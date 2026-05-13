/**
 * Render a video_explainer project to a long-form output.
 *
 * Three render modes based on source÷target ratio:
 *   - Stretch  (ratio < 1.0):  slow to 0.85× + brief freeze at scene boundaries
 *   - Continuous (1.0–2.5):    per-segment speed matched to TTS timing
 *   - Cut      (ratio > 2.5):  skip gaps, show only selected scenes at per-segment speed
 *
 * Inputs:
 *   source.mp4, script.json, narration.mp3, timestamps.json
 * Output:
 *   output/final.mp4
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
import { pickMusicBed } from './musicBed.js';
import { logger } from '../utils/logger.js';

const ASPECT_PRESETS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1':  { width: 1080, height: 1080 },
  'original': null,
};
const DEFAULT_ASPECT = '16:9';
const TARGET_FPS = 25;

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

function escapeAssPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

// ─── Copyright hardening ─────────────────────────────────────────────────────
//
// Optional video + audio transforms that break Content ID fingerprints
// without being noticeable to a human viewer. Off by default.
//
// Video stack:
//   hflip                        — mirror the frame
//   hue=s=1.04                   — saturation +4%
//   eq=brightness=0.02:contrast=1.03  — brightness +2%, contrast +3%
//   crop=iw*0.97:ih*0.97,scale=W:H  — ~1.5% crop then back to target dims
//   drawtext (optional watermark)
//
// Audio: +1% pitch shift on the SOURCE BED (not narrator). Realized as
// asetrate * 1.01, aresample back to 48000, atempo 1/1.01 to keep duration.

const PITCH_SHIFT = 1.01;
const WIN_FONT = 'C\\:/Windows/Fonts/arialbd.ttf';
const NIX_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '’')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

/**
 * Build the per-segment video hardening chain (no subs, no concat).
 * Returns a comma-prefixed string to be appended after the scale/crop chain,
 * or "" when hardening is disabled.
 *
 * NOTE: per-segment so the concat output dims stay uniform.
 */
function buildVideoHardenChain(hardenCfg, dims) {
  if (!hardenCfg?.enabled) return '';
  const steps = [];
  if (hardenCfg.flip !== false) steps.push('hflip');
  steps.push('hue=s=1.04');
  steps.push('eq=brightness=0.02:contrast=1.03');
  steps.push(`crop=floor(iw*0.97/2)*2:floor(ih*0.97/2)*2`);
  steps.push(`scale=${dims.width}:${dims.height},setsar=1`);
  return ',' + steps.join(',');
}

/**
 * Build the final post-concat overlay chain — watermark goes here so it
 * doesn't get cropped away by the per-segment hardening.
 */
function buildFinalOverlayChain(hardenCfg) {
  if (!hardenCfg?.enabled) return '';
  const wm = (hardenCfg.watermark || '').trim();
  if (!wm) return '';
  const font = process.platform === 'win32' ? WIN_FONT : NIX_FONT;
  const text = escapeDrawtext(wm);
  return (
    `,drawtext=fontfile='${font}':text='${text}':` +
    `x=w-tw-24:y=24:fontsize=24:fontcolor=white@0.65:` +
    `box=1:boxcolor=black@0.45:boxborderw=8`
  );
}

function buildAudioPitchShift() {
  // asetrate raises both pitch and tempo; aresample fixes sample rate;
  // atempo divides tempo back to 1× so duration is preserved.
  return `asetrate=48000*${PITCH_SHIFT},aresample=48000,atempo=${(1 / PITCH_SHIFT).toFixed(6)}`;
}

// ─── Per-segment TTS timing ─────────────────────────────────────────────────

function computeSegmentTiming(segments, segmentBoundaries, windowStart, windowEnd, narrationDur, renderMode) {
  const timing = [];
  const totalFrames = Math.round(narrationDur * TARGET_FPS);
  let assignedFrames = 0;
  let fractionalDebt = 0;

  // Bug 1 fix: if Edge TTS produced leading silence before segment 0 starts
  // speaking, the first segment's output slot must include that silence so the
  // video timeline matches the audio timeline. Without this, every segment's
  // video plays boundary[0].startTime ahead of its narration.
  const leadingSilence = segmentBoundaries[0]?.startTime || 0;
  if (leadingSilence > 0.01) {
    logger.info(`[videoExplainerRenderer] leading silence: ${leadingSilence.toFixed(3)}s — absorbed into segment 0`);
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const boundary = segmentBoundaries[i];
    const nextBoundary = segmentBoundaries[i + 1];

    // TTS slot: time this segment occupies in the output audio timeline.
    // First segment starts at output t=0 (not boundary[0].startTime).
    const slotStart = (i === 0) ? 0 : boundary.startTime;
    const ttsSlot = nextBoundary
      ? nextBoundary.startTime - slotStart
      : narrationDur - slotStart;

    // Source clip boundaries depend on render mode
    let srcStart = seg.sourceStart;
    let srcEnd;
    if (renderMode === 'continuous') {
      // Include gap footage between scenes for seamless playback
      srcEnd = (i < segments.length - 1) ? segments[i + 1].sourceStart : windowEnd;
    } else {
      srcEnd = seg.sourceEnd;
    }

    let srcDur = Math.max(0.04, srcEnd - srcStart);
    let speed = srcDur / ttsSlot;

    // Clamp speed: if too fast, trim source (skip unwatchable gap footage)
    if (speed > 4.0) {
      srcEnd = srcStart + ttsSlot * 4.0;
      srcDur = srcEnd - srcStart;
      speed = 4.0;
    }
    speed = Math.max(0.25, speed);

    // Bug 3 fix: carry fractional frame debt forward instead of rounding
    // each segment independently. Prevents rounding bias that dumps all
    // error onto the last segment.
    const exactFrames = ttsSlot * TARGET_FPS + fractionalDebt;
    let frameCount;
    if (i === segments.length - 1) {
      frameCount = totalFrames - assignedFrames;
    } else {
      frameCount = Math.round(exactFrames);
      fractionalDebt = exactFrames - frameCount;
    }
    frameCount = Math.max(1, frameCount);
    assignedFrames += frameCount;

    // Freeze frames for stretch mode when video is shorter than slot
    const videoFrames = Math.round((srcDur / speed) * TARGET_FPS);
    const freezeFrames = renderMode === 'stretch'
      ? Math.max(0, frameCount - videoFrames)
      : 0;

    timing.push({ srcStart, srcEnd, ttsSlot, speed, frameCount, freezeFrames });
  }

  return timing;
}

// Build atempo filter chain. FFmpeg atempo only accepts [0.5, 100.0],
// so speeds < 0.5 need to be chained: atempo=sqrt(s),atempo=sqrt(s).
function buildAtempo(speed) {
  speed = Math.max(0.25, Math.min(100, speed));
  if (speed >= 0.5) return `atempo=${speed.toFixed(6)}`;
  const s = Math.sqrt(speed);
  return `atempo=${s.toFixed(6)},atempo=${s.toFixed(6)}`;
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

  // Copyright hardening config (off unless explicitly enabled).
  const hardenCfg = project?.config?.copyrightHardening
    ? {
        enabled: true,
        flip: project.config.copyrightHardening.flip !== false,
        pitchShift: project.config.copyrightHardening.pitchShift !== false,
        watermark: project.config.copyrightHardening.watermark || project?.config?.channelName || '',
      }
    : { enabled: false };

  // Background music bed (off by default — needs explicit opt-in AND a file
  // in music/ matching the dominant mood).
  let musicBed = null;
  if (project?.config?.musicBed) {
    musicBed = await pickMusicBed(script);
    if (!musicBed?.path) musicBed = null;
  }

  // Narration duration = content end (last spoken word + 1s), not raw MP3 duration
  const segmentBoundaries = timestamps?.segmentBoundaries || [];
  const narrationFileDur = await ffprobeDuration(narrationPath);
  const lastBoundary = segmentBoundaries[segmentBoundaries.length - 1];
  const contentEnd = lastBoundary ? lastBoundary.endTime + 1.0 : narrationFileDur;
  const narrationDur = Math.min(contentEnd, narrationFileDur);

  // Source window
  const sourceDur = await ffprobeDuration(sourcePath);
  const segments = script.segments;
  const windowStart = Math.max(0, Number(segments[0].sourceStart) || 0);
  const windowEnd = Math.min(sourceDur, Number(segments[segments.length - 1].sourceEnd) || sourceDur);
  const windowDur = windowEnd - windowStart;

  // Determine render mode from script or compute it
  const ratio = script.speedRatio || (windowDur / narrationDur);
  const renderMode = script.renderMode || (ratio < 1.0 ? 'stretch' : (ratio > 2.5 ? 'cut' : 'continuous'));

  logger.info(
    `[videoExplainerRenderer] aspect=${aspectKey} dims=${dims.width}x${dims.height} ` +
    `narration=${narrationDur.toFixed(1)}s (file=${narrationFileDur.toFixed(1)}s) ` +
    `source window=${windowStart.toFixed(0)}-${windowEnd.toFixed(0)}s (${windowDur.toFixed(0)}s) ` +
    `ratio=${ratio.toFixed(2)} mode=${renderMode}`
  );

  // Per-segment TTS sync: match each video segment to its narration boundary
  let timing = null;
  if (segmentBoundaries.length === segments.length) {
    timing = computeSegmentTiming(segments, segmentBoundaries, windowStart, windowEnd, narrationDur, renderMode);
    const speeds = timing.map(t => t.speed);
    logger.info(
      `[videoExplainerRenderer] per-segment sync: ${timing.length} segs, ` +
      `speeds=[${Math.min(...speeds).toFixed(2)}..${Math.max(...speeds).toFixed(2)}], ` +
      `avg=${(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(2)}x`
    );
  } else {
    logger.warn(
      `[videoExplainerRenderer] segment/boundary count mismatch ` +
      `(${segments.length} segments vs ${segmentBoundaries.length} boundaries) — ` +
      `falling back to proportional timing`
    );
  }

  // Generate subtitles
  onProgress('Generating subtitles from narration timestamps...', 5);
  await ensureDir(projectPath(projectId, 'output'));
  let subsPath = null;
  try {
    subsPath = await generateProjectSubtitles(projectId, timestamps);
  } catch (err) {
    logger.warn(`[videoExplainerRenderer] subtitle gen failed: ${err.message} — rendering without subs`);
  }

  const filterScriptPath = projectPath(projectId, '_filter_graph.txt');
  const finalPath = projectPath(projectId, 'output', 'final.mp4');
  let vfChain;

  if (renderMode === 'continuous') {
    if (timing) {
      vfChain = buildContinuousFilterGraph(segments, timing, dims, subsPath, hardenCfg);
      onProgress('Rendering final.mp4 (continuous, per-segment sync)...', 10);
    } else {
      // Fallback: single trim + uniform speed
      const speed = Math.min(2.5, Math.max(0.5, ratio));
      const setptsExpr = `(PTS-STARTPTS)/${speed.toFixed(6)}`;
      const hardenInline = buildVideoHardenChain(hardenCfg, dims);
      const overlayInline = buildFinalOverlayChain(hardenCfg);
      const subFilter = subsPath ? `,subtitles='${escapeAssPath(subsPath)}'` : '';
      vfChain =
        `[0:v]trim=start=${windowStart.toFixed(3)}:end=${windowEnd.toFixed(3)},` +
        `setpts=${setptsExpr},` +
        `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
        `crop=${dims.width}:${dims.height},` +
        `fps=${TARGET_FPS},setsar=1${hardenInline}${overlayInline}${subFilter}[vout]`;
      onProgress(`Rendering final.mp4 (continuous, ${speed.toFixed(2)}× playback)...`, 10);
      logger.info(`[videoExplainerRenderer] continuous speed=${speed.toFixed(3)}x`);
    }

  } else if (renderMode === 'cut') {
    vfChain = buildCutFilterGraph(segments, narrationDur, windowStart, dims, subsPath, timing, hardenCfg);
    onProgress('Rendering final.mp4 (cut mode, selected scenes)...', 10);

  } else {
    vfChain = buildStretchFilterGraph(segments, narrationDur, windowStart, windowDur, dims, subsPath, timing, hardenCfg);
    onProgress('Rendering final.mp4 (stretch mode, slowed + freeze)...', 10);
  }

  if (hardenCfg.enabled) {
    logger.info(
      `[videoExplainerRenderer] copyright hardening: flip=${hardenCfg.flip} ` +
      `pitchShift=${hardenCfg.pitchShift} watermark=${hardenCfg.watermark ? `"${hardenCfg.watermark}"` : '(none)'}`
    );
  }

  // Ducked source audio bed: mix original audio at low volume under narration.
  // During breathe segments (narrator silent), source audio is the only thing heard.
  const srcHasAudio = await new Promise(resolve => {
    ffmpeg.ffprobe(sourcePath, (err, data) => {
      if (err) return resolve(false);
      resolve(data.streams.some(s => s.codec_type === 'audio'));
    });
  });

  // Dynamic ducking via sidechaincompress: when the narrator is speaking
  // (high level on [1:a]), the source/music beds drop; when the narrator
  // is silent (breathe segments), the beds rise back.
  //
  //   threshold=0.05 — narration triggers compression once it exceeds ~−26 dB
  //   ratio=8        — heavy 8:1 compression when triggered
  //   attack=20ms    — quick duck onset (responsive)
  //   release=400ms  — gentle rise back when narrator pauses
  //   makeup=0       — we set the resting volume manually instead
  const REST_VOLUME = 0.55;
  const SIDECHAIN = `sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400:makeup=0`;

  let audioMapping = '1:a';
  if (srcHasAudio) {
    // Optional pitch shift on the source bed when hardening is on.
    const pitchTail = (hardenCfg.enabled && hardenCfg.pitchShift)
      ? ',' + buildAudioPitchShift()
      : '';

    // Build [bedraw] (the per-segment or uniform source audio at rest volume).
    if (timing) {
      const audioParts = [];
      const audioLabels = [];
      for (let i = 0; i < timing.length; i++) {
        const t = timing[i];
        audioParts.push(
          `[0:a]atrim=start=${t.srcStart.toFixed(3)}:end=${t.srcEnd.toFixed(3)},` +
          `asetpts=PTS-STARTPTS,${buildAtempo(t.speed)}${pitchTail},volume=${REST_VOLUME}[a${i}]`
        );
        audioLabels.push(`[a${i}]`);
      }
      vfChain += ';\n' + audioParts.join(';\n');
      vfChain += `;\n${audioLabels.join('')}concat=n=${timing.length}:v=0:a=1[bedraw]`;
    } else {
      const bedSpeed = Math.max(0.5, Math.min(100, ratio));
      vfChain += `;\n[0:a]atrim=start=${windowStart.toFixed(3)}:end=${windowEnd.toFixed(3)},` +
        `asetpts=PTS-STARTPTS,atempo=${bedSpeed.toFixed(6)}${pitchTail},volume=${REST_VOLUME}[bedraw]`;
    }

    // Sidechain duck + optional music bed as a third channel.
    if (musicBed) {
      // [2:a] is the music input (added via .input() below).
      // aloop -1 makes it cover any narration length; volume keeps it well under bed.
      vfChain += `;\n[2:a]aloop=loop=-1:size=2147483647,volume=0.25[musicraw]`;
      vfChain += `;\n[1:a]asplit=3[narr1][narr2][narr3]`;
      vfChain += `;\n[bedraw][narr1]${SIDECHAIN}[bedducked]`;
      vfChain += `;\n[musicraw][narr2]${SIDECHAIN}[musicducked]`;
      vfChain += `;\n[bedducked][musicducked][narr3]amix=inputs=3:duration=first:dropout_transition=0:weights=1 0.7 1.6[aout]`;
      logger.info(
        `[videoExplainerRenderer] audio mix: source-bed + music-bed (${musicBed.file}, mood=${musicBed.dominantMood}) + narrator${pitchTail ? ', +1% pitch on source' : ''}`
      );
    } else {
      vfChain += `;\n[1:a]asplit=2[narr1][narr2]`;
      vfChain += `;\n[bedraw][narr1]${SIDECHAIN}[bedducked]`;
      vfChain += `;\n[bedducked][narr2]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1.4[aout]`;
      logger.info(`[videoExplainerRenderer] sidechain duck rest=${REST_VOLUME}${pitchTail ? ', +1% pitch on source' : ''}`);
    }
    audioMapping = '[aout]';
  } else if (musicBed) {
    // No source audio but music bed enabled — mix music + narration only.
    // [2:a] is the music when no source audio; otherwise this branch is unreachable
    // since musicBed adds [2:a] to the input list which would conflict with the
    // srcHasAudio path. To keep input indexing stable we still pass source as [0].
    vfChain += `;\n[2:a]aloop=loop=-1:size=2147483647,volume=0.30[musicraw]`;
    vfChain += `;\n[1:a]asplit=2[narr1][narr2]`;
    vfChain += `;\n[musicraw][narr1]${SIDECHAIN}[musicducked]`;
    vfChain += `;\n[musicducked][narr2]amix=inputs=2:duration=first:dropout_transition=0:weights=0.7 1.6[aout]`;
    audioMapping = '[aout]';
    logger.info(`[videoExplainerRenderer] no source audio — music-bed only (${musicBed.file})`);
  } else {
    logger.info(`[videoExplainerRenderer] no source audio track — narration only`);
  }

  await fs.writeFile(filterScriptPath, vfChain, 'utf-8');
  logger.info(`[videoExplainerRenderer] filter: ${vfChain.length} chars, mode=${renderMode}`);

  // Single ffmpeg pass
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .setFfmpegPath(getFfmpegPath())
      .input(sourcePath)
      .input(narrationPath);
    if (musicBed) cmd.input(musicBed.path);
    cmd
      .addOption('-filter_complex_script', filterScriptPath)
      .outputOptions([
        '-map', '[vout]',
        '-map', audioMapping,
        '-t', narrationDur.toFixed(3),
        ...getEncodingOptions(detail),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
      ])
      .output(finalPath);

    cmd.on('progress', (p) => {
      if (typeof p.percent === 'number' && Number.isFinite(p.percent)) {
        onProgress(
          `Encoding (${renderMode}): ${p.percent.toFixed(1)}%`,
          10 + Math.min(85, Math.round(p.percent * 0.85))
        );
      }
    });

    cmd.on('end', resolve);
    cmd.on('error', err => reject(new Error(`Render failed: ${err.message}`)));
    cmd.run();
  });

  try { await fs.unlink(filterScriptPath); } catch {}

  onProgress('Render complete', 100);
  logger.info(`[videoExplainerRenderer] final.mp4 written for ${projectId}`);
  return finalPath;
}

// ─── Continuous mode filter graph (per-segment) ──────────────────────────────

function buildContinuousFilterGraph(segments, timing, dims, subsPath, hardenCfg) {
  const parts = [];
  const labels = [];
  const hardenInline = buildVideoHardenChain(hardenCfg, dims);

  for (let i = 0; i < segments.length; i++) {
    const t = timing[i];
    const label = `s${i}`;

    parts.push(
      `[0:v]trim=start=${t.srcStart.toFixed(3)}:end=${t.srcEnd.toFixed(3)},` +
      `setpts=(PTS-STARTPTS)/${t.speed.toFixed(6)},` +
      `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
      `crop=${dims.width}:${dims.height},` +
      `fps=${TARGET_FPS},setsar=1${hardenInline},` +
      `trim=end_frame=${t.frameCount},setpts=PTS-STARTPTS[${label}]`
    );
    labels.push(`[${label}]`);
  }

  const overlayInline = buildFinalOverlayChain(hardenCfg);
  const subFilter = subsPath ? `,subtitles='${escapeAssPath(subsPath)}'` : '';
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0${overlayInline}${subFilter}[vout]`);

  return parts.join(';\n');
}

// ─── Cut mode filter graph ────────────────────────────────────────────────────

function buildCutFilterGraph(segments, narrationDur, windowStart, dims, subsPath, timing, hardenCfg) {
  const hardenInline = buildVideoHardenChain(hardenCfg, dims);
  const overlayInline = buildFinalOverlayChain(hardenCfg);

  // When timing is available, use per-segment TTS-synced speeds
  if (timing) {
    const parts = [];
    const labels = [];

    for (let i = 0; i < segments.length; i++) {
      const t = timing[i];
      const label = `s${i}`;

      parts.push(
        `[0:v]trim=start=${t.srcStart.toFixed(3)}:end=${t.srcEnd.toFixed(3)},` +
        `setpts=(PTS-STARTPTS)/${t.speed.toFixed(6)},` +
        `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
        `crop=${dims.width}:${dims.height},` +
        `fps=${TARGET_FPS},setsar=1${hardenInline},` +
        `trim=end_frame=${t.frameCount},setpts=PTS-STARTPTS[${label}]`
      );
      labels.push(`[${label}]`);
    }

    const subFilter = subsPath ? `,subtitles='${escapeAssPath(subsPath)}'` : '';
    parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0${overlayInline}${subFilter}[vout]`);

    logger.info(
      `[videoExplainerRenderer] cut (TTS-synced): ${segments.length} segments, ` +
      `totalFrames=${timing.reduce((s, t) => s + t.frameCount, 0)}`
    );

    return parts.join(';\n');
  }

  // Fallback: proportional frame allocation with uniform speed
  const totalSelectedDur = segments.reduce((s, seg) => s + ((seg.sourceEnd - seg.sourceStart) || 0), 0);
  const cutSpeed = Math.min(2.0, Math.max(1.0, totalSelectedDur / narrationDur));
  const totalFrames = Math.round(narrationDur * TARGET_FPS);

  const segDurations = segments.map(seg => (seg.sourceEnd - seg.sourceStart) || 0.1);
  const totalDur = segDurations.reduce((a, b) => a + b, 0);
  let assignedFrames = 0;
  const frameAllocs = segDurations.map((d, i) => {
    if (i === segments.length - 1) return totalFrames - assignedFrames;
    const f = Math.round((d / totalDur) * totalFrames);
    assignedFrames += f;
    return f;
  });

  const parts = [];
  const labels = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = `s${i}`;

    parts.push(
      `[0:v]trim=start=${seg.sourceStart.toFixed(3)}:end=${seg.sourceEnd.toFixed(3)},` +
      `setpts=(PTS-STARTPTS)/${cutSpeed.toFixed(6)},` +
      `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
      `crop=${dims.width}:${dims.height},` +
      `fps=${TARGET_FPS},setsar=1${hardenInline},` +
      `trim=end_frame=${frameAllocs[i]},setpts=PTS-STARTPTS[${label}]`
    );
    labels.push(`[${label}]`);
  }

  const subFilter = subsPath ? `,subtitles='${escapeAssPath(subsPath)}'` : '';
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0${overlayInline}${subFilter}[vout]`);

  logger.info(
    `[videoExplainerRenderer] cut: ${segments.length} segments, speed=${cutSpeed.toFixed(2)}x, ` +
    `totalFrames=${totalFrames}`
  );

  return parts.join(';\n');
}

// ─── Stretch mode filter graph ────────────────────────────────────────────────

function buildStretchFilterGraph(segments, narrationDur, windowStart, windowDur, dims, subsPath, timing, hardenCfg) {
  const hardenInline = buildVideoHardenChain(hardenCfg, dims);
  const overlayInline = buildFinalOverlayChain(hardenCfg);
  // When timing is available, use per-segment TTS-synced speeds
  if (timing) {
    const parts = [];
    const labels = [];

    for (let i = 0; i < segments.length; i++) {
      const t = timing[i];
      const label = `s${i}`;

      let chain =
        `[0:v]trim=start=${t.srcStart.toFixed(3)}:end=${t.srcEnd.toFixed(3)},` +
        `setpts=(PTS-STARTPTS)/${t.speed.toFixed(6)},` +
        `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
        `crop=${dims.width}:${dims.height},` +
        `fps=${TARGET_FPS},setsar=1${hardenInline}`;

      if (t.freezeFrames > 0) {
        chain += `,tpad=stop_mode=clone:stop_duration=${(t.freezeFrames / TARGET_FPS).toFixed(3)}`;
      }

      chain += `,trim=end_frame=${t.frameCount},setpts=PTS-STARTPTS[${label}]`;
      parts.push(chain);
      labels.push(`[${label}]`);
    }

    const subFilter = subsPath ? `,subtitles='${escapeAssPath(subsPath)}'` : '';
    parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0${overlayInline}${subFilter}[vout]`);

    logger.info(
      `[videoExplainerRenderer] stretch (TTS-synced): ${segments.length} segments, ` +
      `totalFrames=${timing.reduce((s, t) => s + t.frameCount, 0)}`
    );

    return parts.join(';\n');
  }

  // Fallback: proportional allocation
  const totalFrames = Math.round(narrationDur * TARGET_FPS);
  const effectiveRatio = windowDur / narrationDur;

  const outputTimes = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const outStart = seg.outputStart != null
      ? seg.outputStart
      : (seg.sourceStart - windowStart) / effectiveRatio;
    const outEnd = seg.outputEnd != null
      ? seg.outputEnd
      : (seg.sourceEnd - windowStart) / effectiveRatio;
    const nextStart = (i < segments.length - 1)
      ? (segments[i + 1].outputStart != null ? segments[i + 1].outputStart : (segments[i + 1].sourceStart - windowStart) / effectiveRatio)
      : outEnd;
    outputTimes.push({ outStart, outEnd, windowDur: Math.max(nextStart - outStart, outEnd - outStart) });
  }

  const totalWindow = outputTimes.reduce((a, t) => a + t.windowDur, 0);
  let assignedFrames = 0;
  const frameAllocs = outputTimes.map((t, i) => {
    if (i === segments.length - 1) return totalFrames - assignedFrames;
    const f = Math.round((t.windowDur / totalWindow) * totalFrames);
    assignedFrames += f;
    return f;
  });

  const parts = [];
  const labels = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const start = seg.sourceStart;
    const end = seg.sourceEnd;
    const sceneDur = end - start;
    const targetDur = frameAllocs[i] / TARGET_FPS;
    const label = `s${i}`;

    const speed = Math.max(0.85, sceneDur / targetDur);
    const videoAfterSpeed = sceneDur / speed;
    const freezeFrames = Math.max(0, frameAllocs[i] - Math.round(videoAfterSpeed * TARGET_FPS));

    let chain =
      `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},` +
      `setpts=(PTS-STARTPTS)/${speed.toFixed(6)},` +
      `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
      `crop=${dims.width}:${dims.height},` +
      `fps=${TARGET_FPS},setsar=1${hardenInline}`;

    if (freezeFrames > 0) {
      chain += `,tpad=stop_mode=clone:stop_duration=${(freezeFrames / TARGET_FPS).toFixed(3)}`;
    }

    chain += `,trim=end_frame=${frameAllocs[i]},setpts=PTS-STARTPTS[${label}]`;
    parts.push(chain);
    labels.push(`[${label}]`);
  }

  const subFilter = subsPath ? `,subtitles='${escapeAssPath(subsPath)}'` : '';
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0${overlayInline}${subFilter}[vout]`);

  logger.info(
    `[videoExplainerRenderer] stretch: ${segments.length} segments, totalFrames=${totalFrames}`
  );

  return parts.join(';\n');
}
