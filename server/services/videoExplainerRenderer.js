/**
 * Render a video_explainer project to a long-form output.
 *
 * Input artifacts (already produced by earlier pipeline steps):
 *   data/projects/<id>/source.mp4              — stitched + normalized source
 *   data/projects/<id>/script.json             — { title, hook, segments:[{beatIndex, sourceStart, sourceEnd, text, mood}] }
 *   data/projects/<id>/audio/narration.mp3     — TTS for hook + all segments
 *   data/projects/<id>/audio/timestamps.json   — { words, segmentBoundaries:[{startTime, endTime}] }
 *
 * Output:
 *   data/projects/<id>/output/final.mp4
 *
 * Strategy:
 *   For each script segment:
 *     1. Cut [sourceStart, sourceEnd] from source.mp4.
 *     2. Speed-adjust the clip so it fills exactly the narration segment's
 *        duration (setpts=PTS/speed). Clamped to 0.25x–4x.
 *     3. No source audio — only narration plays over the video.
 *
 *   Concat → timeline → mux with:
 *     - narration audio only (no source audio)
 *     - burned-in subtitles from the narration's word-level timestamps
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import {
  ensureDir, safeReadJson, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { getEncodingOptions, getFfmpegPath } from './gpuDetect.js';
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
const MIN_SPEED = 0.25;
const MAX_SPEED = 4.0;

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data?.format?.duration) return reject(err || new Error(`no duration for ${filePath}`));
      resolve(parseFloat(data.format.duration));
    });
  });
}

function resolveDims(aspectKey, sourcePath) {
  if (aspectKey && ASPECT_PRESETS[aspectKey]) return Promise.resolve(ASPECT_PRESETS[aspectKey]);
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(sourcePath, (err, data) => {
      if (err) return reject(err);
      const vs = data.streams.find(s => s.codec_type === 'video');
      resolve({ width: vs?.width || 1920, height: vs?.height || 1080 });
    });
  });
}

/**
 * Cut a clip from source and speed-adjust video so it fills exactly `targetDur`.
 * Source audio is muted (volume=0) to produce a silent audio track for concat.
 * The output is hard-trimmed to targetDur so clamped speeds don't create excess.
 */
async function cutWithSpeed(srcPath, srcStart, srcEnd, targetDur, outPath, dims) {
  const srcDur = srcEnd - srcStart;
  const rawSpeed = srcDur / targetDur;
  const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, rawSpeed));
  const effectiveDur = srcDur / speed; // actual output duration after speed adjust

  // If speed was clamped, only read what we need from source (avoid excess frames)
  const readDur = Math.min(srcDur, targetDur * speed);

  // Build atempo chain: ffmpeg atempo only accepts 0.5–100, so chain multiple
  // stages for extreme slow-downs (speed < 0.5 means atempo > 2).
  const atempoVal = 1 / speed; // how much to stretch/shrink audio timeline
  const atempoFilters = [];
  let remaining = atempoVal;
  while (remaining > 2.0) { atempoFilters.push('atempo=2.0'); remaining /= 2.0; }
  while (remaining < 0.5) { atempoFilters.push('atempo=0.5'); remaining /= 0.5; }
  atempoFilters.push(`atempo=${remaining.toFixed(4)}`);

  const vfChain = [
    `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase`,
    `crop=${dims.width}:${dims.height}`,
    `fps=${TARGET_FPS}`,
    'setsar=1',
    `setpts=PTS/${speed.toFixed(4)}`,
  ].join(',');

  const afChain = `volume=0,${atempoFilters.join(',')}`;

  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(srcStart)
      .duration(readDur)
      .complexFilter([
        `[0:v]${vfChain}[v]`,
        `[0:a]${afChain}[a]`,
      ])
      .outputOptions([
        '-map', '[v]', '-map', '[a]',
        '-t', targetDur.toFixed(3),   // hard-trim output to exact target duration
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Beat cut+speed failed: ${err.message}`)))
      .run();
  });
}

function concatClips(clipPaths, outPath) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().setFfmpegPath(getFfmpegPath());
    clipPaths.forEach(p => cmd.input(p));
    const filterParts = clipPaths.map((_, i) => `[${i}:v][${i}:a]`).join('');
    cmd
      .complexFilter([`${filterParts}concat=n=${clipPaths.length}:v=1:a=1[v][a]`])
      .outputOptions([
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Concat failed: ${err.message}`)))
      .run();
  });
}

/**
 * Mux narration over the video timeline (no source audio).
 * Burns ASS subtitles if available.
 */
function muxNarrationAndSubs(timelinePath, narrationPath, subsPath, outPath, detailPreset, dims) {
  return new Promise((resolve, reject) => {
    const subFilter = subsPath
      ? `,subtitles='${subsPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
      : '';

    ffmpeg(timelinePath)
      .setFfmpegPath(getFfmpegPath())
      .input(narrationPath)
      .complexFilter([
        `[0:v]scale=${dims.width}:${dims.height},setsar=1${subFilter}[v]`,
      ])
      .outputOptions([
        '-map', '[v]', '-map', '1:a',
        ...getEncodingOptions(detailPreset),
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Final mux failed: ${err.message}`)))
      .run();
  });
}

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
  const dims = await resolveDims(aspectKey, sourcePath);
  const detail = getDetailPreset(project?.config?.detail || 'medium');
  logger.info(`[videoExplainerRenderer] aspect=${aspectKey} → ${dims.width}x${dims.height}`);

  const segmentBoundaries = timestamps?.segmentBoundaries || [];
  const narrationDur = await ffprobeDuration(narrationPath);
  logger.info(`[videoExplainerRenderer] narration ${narrationDur.toFixed(1)}s · ${segmentBoundaries.length} boundaries · ${script.segments.length} segments`);

  const beatsDir = projectPath(projectId, 'beats_render');
  await ensureDir(beatsDir);

  // Phase 1: cut + speed-adjust each beat to fill narration duration (incl. gaps).
  // Each clip must cover from its narration start to the NEXT segment's start
  // (to fill breathing-room silences). Last clip covers until narration ends.
  const clipPaths = [];
  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const srcStart = Number(seg.sourceStart) || 0;
    const srcEnd   = Number(seg.sourceEnd)   || (srcStart + 5);
    const boundary = segmentBoundaries[i];
    const nextBoundary = segmentBoundaries[i + 1];

    let narrSec;
    if (boundary && nextBoundary) {
      // Fill from this segment's start to the next segment's start (covers gap)
      narrSec = Math.max(0.5, nextBoundary.startTime - boundary.startTime);
    } else if (boundary) {
      // Last segment: fill from start to narration end
      narrSec = Math.max(0.5, narrationDur - boundary.startTime);
    } else {
      // No boundary data — fall back to source duration (shouldn't happen)
      narrSec = srcEnd - srcStart;
      logger.warn(`[videoExplainerRenderer] No boundary for segment ${i} — using source duration ${narrSec.toFixed(1)}s`);
    }

    const srcDur = srcEnd - srcStart;
    const speed = (srcDur / narrSec).toFixed(2);

    onProgress(
      `Cutting beat ${i + 1}/${script.segments.length} ` +
      `(src ${srcDur.toFixed(1)}s → narr ${narrSec.toFixed(1)}s, ${speed}x)`,
      Math.round((i / script.segments.length) * 70)
    );

    const outPath = path.join(beatsDir, `beat_${String(i).padStart(4, '0')}.mp4`);
    await cutWithSpeed(sourcePath, srcStart, srcEnd, narrSec, outPath, dims);
    clipPaths.push(outPath);
  }

  // Phase 2: concat into timeline (silent audio tracks from cutWithSpeed).
  onProgress('Concatenating timeline...', 75);
  const timelinePath = projectPath(projectId, 'explainer-timeline.mp4');
  await concatClips(clipPaths, timelinePath);

  // Phase 3: subtitles.
  onProgress('Generating subtitles from narration timestamps...', 85);
  await ensureDir(projectPath(projectId, 'output'));
  let subsPath = null;
  try { subsPath = await generateProjectSubtitles(projectId, timestamps); }
  catch (err) { logger.warn(`[videoExplainerRenderer] subtitle gen failed: ${err.message} — rendering without subs`); }

  // Phase 4: final mux — narration only (no source audio).
  onProgress('Muxing narration + subtitles...', 92);
  const finalPath = projectPath(projectId, 'output', 'final.mp4');
  await muxNarrationAndSubs(timelinePath, narrationPath, subsPath, finalPath, detail, dims);

  // Cleanup intermediates.
  try { await fs.unlink(timelinePath); } catch {}
  for (const p of clipPaths) { try { await fs.unlink(p); } catch {} }
  try { await fs.rmdir(beatsDir); } catch {}

  onProgress('Render complete', 100);
  logger.info(`[videoExplainerRenderer] final.mp4 written for ${projectId}`);
  return finalPath;
}
