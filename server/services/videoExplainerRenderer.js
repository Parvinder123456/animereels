/**
 * Render a video_explainer project to a long-form output.
 *
 * Design principle: narration is the master clock. The video is constructed
 * in ONE ffmpeg invocation whose filter graph mathematically guarantees
 * that the cumulative video duration matches the cumulative narration
 * duration frame-by-frame. There are no per-clip files, no intermediate
 * re-encodes, no concat-demuxer round trips — every source of cumulative
 * drift that the previous renderer suffered from is structurally eliminated.
 *
 * Inputs:
 *   data/projects/<id>/source.mp4              — stitched + normalized source
 *   data/projects/<id>/script.json             — { hook, segments:[{beatIndex, sourceStart, sourceEnd, text, mood}] }
 *   data/projects/<id>/audio/narration.mp3     — TTS for hook + all segments
 *   data/projects/<id>/audio/timestamps.json   — { segmentBoundaries:[{startTime, endTime}] }
 *
 * Output:
 *   data/projects/<id>/output/final.mp4
 *
 * Per-clip strategy (auto-selected by source-vs-narration ratio):
 *   speed-adjust  (0.7 ≤ ratio ≤ 1.5)   — subtle setpts time-warp, looks natural
 *   truncate      (ratio > 1.5)         — source plays at 1× for the first targetDur, rest dropped
 *   freeze        (ratio < 0.7)         — source plays at 1×, last frame freezes to fill
 *
 * Frame-exact distribution: we compute integer frame counts that sum to
 * exactly round(narrationDur × fps), eliminating drift across 50+ beats.
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import {
  ensureDir, safeReadJson, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { getFfmpegPath, getEncodingOptions } from './gpuDetect.js';
import { getDetailPreset } from './detailPresets.js';
import { generateProjectSubtitles } from './subtitleGenerator.js';
import { logger } from '../utils/logger.js';

const ASPECT_PRESETS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1':  { width: 1080, height: 1080 },
  'original': null,
};
const DEFAULT_ASPECT = '16:9';
const TARGET_FPS = 25;
const SPEED_OK_MIN = 0.7;   // outside this range we don't speed-warp — looks bad
const SPEED_OK_MAX = 1.5;

// ─── Probes ──────────────────────────────────────────────────────────────────

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data?.format?.duration) return reject(err || new Error(`no duration for ${filePath}`));
      resolve(parseFloat(data.format.duration));
    });
  });
}

function ffprobeVideoStream(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const vs = data.streams.find(s => s.codec_type === 'video');
      resolve(vs || {});
    });
  });
}

function resolveDims(aspectKey, srcStream) {
  if (aspectKey && ASPECT_PRESETS[aspectKey]) return ASPECT_PRESETS[aspectKey];
  return { width: srcStream?.width || 1920, height: srcStream?.height || 1080 };
}

// ─── Segment spec: derive target durations from narration boundaries ─────────

/**
 * Compute per-segment target durations from the narration's segmentBoundaries,
 * then distribute integer frame counts so they sum to exactly
 * round(narrationDur * fps). This is what eliminates accumulated drift.
 *
 * @returns {Array<{srcStart, srcEnd, srcDur, targetFrames, targetDur, strategy}>}
 */
function buildSegmentSpecs(scriptSegments, segmentBoundaries, narrationDur, fps) {
  // 1. Raw target duration per segment from narration boundaries.
  const rawTargets = scriptSegments.map((seg, i) => {
    const b  = segmentBoundaries[i];
    const nb = segmentBoundaries[i + 1];
    let dur;
    if (b && nb) {
      dur = nb.startTime - b.startTime;
    } else if (b) {
      dur = narrationDur - b.startTime;
    } else {
      dur = (Number(seg.sourceEnd) || 0) - (Number(seg.sourceStart) || 0);
    }
    return Math.max(0.2, dur);
  });

  // 2. Frame-exact distribution. We allocate integer frame counts via
  //    cumulative-rounding so the sum equals round(narrationDur * fps).
  //    Per-clip error stays bounded by ±1 frame; the total never drifts.
  const totalFrames = Math.round(narrationDur * fps);
  const rawSum = rawTargets.reduce((s, d) => s + d, 0);
  const frameCounts = [];
  let prevCum = 0;
  let accum = 0;
  for (let i = 0; i < rawTargets.length; i++) {
    accum += rawTargets[i];
    const cum = Math.round((accum / rawSum) * totalFrames);
    frameCounts.push(Math.max(1, cum - prevCum));
    prevCum = cum;
  }

  // 3. Strategy per segment: speed-adjust, truncate, or freeze.
  return scriptSegments.map((seg, i) => {
    const srcStart = Math.max(0, Number(seg.sourceStart) || 0);
    const srcEnd   = Math.max(srcStart + 0.1, Number(seg.sourceEnd) || (srcStart + 5));
    const srcDur   = srcEnd - srcStart;
    const targetFrames = frameCounts[i];
    const targetDur = targetFrames / fps;
    const ratio = srcDur / targetDur;

    let strategy;
    if (ratio >= SPEED_OK_MIN && ratio <= SPEED_OK_MAX) {
      strategy = { kind: 'speed', factor: ratio };
    } else if (ratio > SPEED_OK_MAX) {
      strategy = { kind: 'truncate' };
    } else {
      strategy = { kind: 'freeze', srcFrames: Math.max(1, Math.round(srcDur * fps)) };
    }

    return { idx: i, srcStart, srcEnd, srcDur, targetFrames, targetDur, strategy };
  });
}

// ─── Filter graph builder ────────────────────────────────────────────────────

function escapeAssPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

/**
 * Build the filter_complex string. Returns the string AND a list of
 * label names so the caller knows what to -map.
 */
function buildFilterGraph(specs, dims, fps, narrationDur, subsPath) {
  const lines = [];
  const labels = [];

  for (const s of specs) {
    const inLabel = `v${s.idx}`;
    const scaleCrop =
      `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
      `crop=${dims.width}:${dims.height},setsar=1,fps=${fps}`;

    let chain;
    if (s.strategy.kind === 'speed') {
      // Read [srcStart, srcEnd] at original rate, then time-warp with setpts.
      // Then normalize to CFR and clip to exactly targetFrames using trim=end_frame.
      const inv = (1 / s.strategy.factor).toFixed(6);
      chain =
        `[0:v]trim=start=${s.srcStart.toFixed(3)}:end=${s.srcEnd.toFixed(3)},` +
        `setpts=(PTS-STARTPTS)*${inv},` +
        `${scaleCrop},` +
        `trim=end_frame=${s.targetFrames},setpts=PTS-STARTPTS[${inLabel}]`;
    } else if (s.strategy.kind === 'truncate') {
      // Source longer than narration window — cut to first targetDur of source.
      const cutEnd = (s.srcStart + s.targetDur).toFixed(3);
      chain =
        `[0:v]trim=start=${s.srcStart.toFixed(3)}:end=${cutEnd},setpts=PTS-STARTPTS,` +
        `${scaleCrop},` +
        `trim=end_frame=${s.targetFrames},setpts=PTS-STARTPTS[${inLabel}]`;
    } else {
      // Source shorter than narration — play once, freeze last frame to fill.
      const padFrames = s.targetFrames - s.strategy.srcFrames;
      const padDur = (padFrames / fps).toFixed(3);
      chain =
        `[0:v]trim=start=${s.srcStart.toFixed(3)}:end=${s.srcEnd.toFixed(3)},setpts=PTS-STARTPTS,` +
        `${scaleCrop},` +
        `tpad=stop_mode=clone:stop_duration=${padDur},` +
        `trim=end_frame=${s.targetFrames},setpts=PTS-STARTPTS[${inLabel}]`;
    }

    lines.push(chain);
    labels.push(`[${inLabel}]`);
  }

  // Concat all segments into one video stream.
  lines.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vcat]`);

  // Burn subtitles (if available) into the concatenated stream.
  if (subsPath) {
    lines.push(`[vcat]subtitles='${escapeAssPath(subsPath)}'[vout]`);
  } else {
    lines.push(`[vcat]copy[vout]`);
  }

  return lines.join(';\n');
}

// ─── One-shot ffmpeg runner ──────────────────────────────────────────────────

async function runOneShot(sourcePath, narrationPath, filterScriptPath, outPath, narrationDur, detailPreset, onProgress) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .setFfmpegPath(getFfmpegPath())
      .input(sourcePath)
      .input(narrationPath)
      .addOption('-filter_complex_script', filterScriptPath)
      .outputOptions([
        '-map', '[vout]',
        '-map', '1:a',
        '-t', narrationDur.toFixed(3),
        ...getEncodingOptions(detailPreset),
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
      ])
      .output(outPath);

    cmd.on('progress', (p) => {
      if (typeof p.percent === 'number' && Number.isFinite(p.percent)) {
        onProgress(`ffmpeg: ${p.percent.toFixed(1)}% (frame ${p.frames || '?'})`,
          15 + Math.min(80, Math.round(p.percent * 0.8)));
      }
    });

    cmd.on('end', resolve);
    cmd.on('error', err => reject(new Error(`Render failed: ${err.message}`)));
    cmd.run();
  });
}

// ─── Public entry ─────────────────────────────────────────────────────────────

export async function renderVideoExplainer(projectId, onProgress = () => {}) {
  const sourcePath    = projectPath(projectId, 'source.mp4');
  const script        = await safeReadJson(projectPath(projectId, 'script.json'));
  const timestamps    = await safeReadJson(projectPath(projectId, 'audio', 'timestamps.json'));
  const narrationPath = projectPath(projectId, 'audio', 'narration.mp3');
  const project       = await safeReadJson(projectPath(projectId, 'project.json'));

  if (!await fileExists(sourcePath))    throw new Error(`Source video missing: ${sourcePath}`);
  if (!script?.segments?.length)        throw new Error('No script — generate explainer script first');
  if (!await fileExists(narrationPath)) throw new Error('No narration — run /voice/generate first');

  const aspectKey = project?.config?.aspect || DEFAULT_ASPECT;
  const srcStream = await ffprobeVideoStream(sourcePath);
  const dims = resolveDims(aspectKey, srcStream);
  const detail = getDetailPreset(project?.config?.detail || 'medium');

  const segmentBoundaries = timestamps?.segmentBoundaries || [];
  const narrationDur = await ffprobeDuration(narrationPath);
  const fps = TARGET_FPS;

  if (segmentBoundaries.length !== script.segments.length) {
    logger.warn(
      `[videoExplainerRenderer] boundary count (${segmentBoundaries.length}) ` +
      `!= script segment count (${script.segments.length}) — fallback alignments may be used`
    );
  }
  logger.info(
    `[videoExplainerRenderer] aspect=${aspectKey} dims=${dims.width}x${dims.height} ` +
    `narration=${narrationDur.toFixed(1)}s segments=${script.segments.length}`
  );

  // Build per-segment specs with frame-exact distribution.
  onProgress('Computing frame-exact segment plan...', 4);
  const specs = buildSegmentSpecs(script.segments, segmentBoundaries, narrationDur, fps);

  // Strategy summary for log.
  const summary = specs.reduce((m, s) => { m[s.strategy.kind] = (m[s.strategy.kind] || 0) + 1; return m; }, {});
  logger.info(
    `[videoExplainerRenderer] strategies: ` +
    Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ') +
    ` · totalFrames=${specs.reduce((n, s) => n + s.targetFrames, 0)} ` +
    `(expected ${Math.round(narrationDur * fps)})`
  );

  // Generate subtitles BEFORE running ffmpeg — we burn them in the same pass.
  onProgress('Generating subtitles from narration timestamps...', 8);
  let subsPath = null;
  try {
    subsPath = await generateProjectSubtitles(projectId, timestamps);
  } catch (err) {
    logger.warn(`[videoExplainerRenderer] subtitle gen failed: ${err.message} — rendering without subs`);
  }

  // Write the filter graph to a file (avoids Windows command-line length limits
  // for projects with 50+ beats, where the inline string would exceed 8 KB).
  const filterGraph = buildFilterGraph(specs, dims, fps, narrationDur, subsPath);
  const filterScriptPath = projectPath(projectId, '_filter_graph.txt');
  await fs.writeFile(filterScriptPath, filterGraph, 'utf-8');
  logger.info(`[videoExplainerRenderer] filter graph: ${filterGraph.length} bytes, ${specs.length} segments`);

  // One ffmpeg invocation.
  await ensureDir(projectPath(projectId, 'output'));
  const finalPath = projectPath(projectId, 'output', 'final.mp4');
  onProgress('Rendering final.mp4 (single ffmpeg pass)...', 12);
  await runOneShot(sourcePath, narrationPath, filterScriptPath, finalPath, narrationDur, detail, onProgress);

  try { await fs.unlink(filterScriptPath); } catch {}

  onProgress('Render complete', 100);
  logger.info(`[videoExplainerRenderer] final.mp4 written for ${projectId}`);
  return finalPath;
}
