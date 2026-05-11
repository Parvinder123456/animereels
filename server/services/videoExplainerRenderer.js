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
 * Strategy (same for all three modes — cut/hybrid/continuous — since the
 * upstream clusterer/picker chooses which beats survive):
 *
 *   For each script segment in order:
 *     1. Cut [sourceStart, sourceEnd] from source.mp4 at original speed.
 *     2. If the matching narration segment is LONGER than the source clip,
 *        extend the clip by freezing the last frame to match narration duration.
 *        If shorter, leave clip at source duration (narration leads silence).
 *     3. Each clip is encoded uniformly so the concat demuxer can join them.
 *
 *   Concat → silent timeline → mux with:
 *     - narration (placed at each segment's offset on the merged timeline)
 *     - original source audio ducked to ~18%, pitch-shifted +1% to break
 *       Content ID fingerprints (legitimate transformative use)
 *     - burned-in subtitles from the narration's word-level timestamps
 *
 * YouTube safety measures baked in:
 *   - Source audio ducked to 18% (Content ID is audio-first)
 *   - Source audio pitched +1% via asetrate/aresample/atempo composition
 *   - OP/ED already removed upstream (most heavily fingerprinted)
 *   - Optional small overlay (project name) for transformative signal
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
const SOURCE_AUDIO_GAIN = 0.18;
const NARRATOR_GAIN = 1.0;
const PITCH_SHIFT = 1.01; // +1% — invisible to viewers, breaks audio fingerprints

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
 * Cut a clip from source. If we need it to be longer than the source
 * window, append a freeze of the last frame to match `extendToSec`.
 */
async function cutAndOptionallyExtend(srcPath, srcStart, srcEnd, extendToSec, outPath, dims) {
  const srcDur = srcEnd - srcStart;
  const needExtend = extendToSec && extendToSec > srcDur + 0.05;

  const vf = [
    `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase`,
    `crop=${dims.width}:${dims.height}`,
    `fps=${TARGET_FPS}`,
    'setsar=1',
  ].join(',');

  if (!needExtend) {
    return new Promise((resolve, reject) => {
      ffmpeg(srcPath)
        .setFfmpegPath(getFfmpegPath())
        .seekInput(srcStart)
        .duration(srcDur)
        .outputOptions([
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
          '-vf', vf,
          '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart',
        ])
        .output(outPath)
        .on('end', resolve)
        .on('error', err => reject(new Error(`Beat cut failed: ${err.message}`)))
        .run();
    });
  }

  // Extend path: tpad=stop_mode=clone freezes the last frame; the source
  // audio gets padded with silence so the clip's audio still matches video length.
  const extra = extendToSec - srcDur;
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(srcStart)
      .duration(srcDur)
      .complexFilter([
        `[0:v]${vf},tpad=stop_mode=clone:stop_duration=${extra.toFixed(3)}[v]`,
        `[0:a]apad=pad_dur=${extra.toFixed(3)},atrim=0:${extendToSec.toFixed(3)}[a]`,
      ])
      .outputOptions([
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Beat cut+extend failed: ${err.message}`)))
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
 * Mux narration over the concatenated source timeline.
 * - Source audio: pitch +1%, gain 0.18
 * - Narration audio: gain 1.0
 * - Burns ASS subtitles (if available)
 */
function muxNarrationAndSubs(timelinePath, narrationPath, subsPath, outPath, detailPreset, dims) {
  return new Promise((resolve, reject) => {
    const subFilter = subsPath
      ? `,subtitles='${subsPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
      : '';

    const pitchChain = `asetrate=48000*${PITCH_SHIFT},aresample=48000,atempo=${(1 / PITCH_SHIFT).toFixed(6)}`;

    ffmpeg(timelinePath)
      .setFfmpegPath(getFfmpegPath())
      .input(narrationPath)
      .complexFilter([
        `[0:v]scale=${dims.width}:${dims.height},setsar=1${subFilter}[v]`,
        `[0:a]${pitchChain},volume=${SOURCE_AUDIO_GAIN}[src]`,
        `[1:a]volume=${NARRATOR_GAIN}[narr]`,
        `[src][narr]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]`,
      ])
      .outputOptions([
        '-map', '[v]', '-map', '[a]',
        ...getEncodingOptions(detailPreset),
        '-c:a', 'aac', '-b:a', '192k',
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

  // Phase 1: cut + optionally extend each beat.
  const clipPaths = [];
  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const srcStart = Number(seg.sourceStart) || 0;
    const srcEnd   = Number(seg.sourceEnd)   || (srcStart + 5);
    const boundary = segmentBoundaries[i] || segmentBoundaries[i + 1];
    const narrSec  = boundary ? Math.max(0.1, boundary.endTime - boundary.startTime) : (srcEnd - srcStart);

    onProgress(
      `Cutting beat ${i + 1}/${script.segments.length} ` +
      `(src ${(srcEnd - srcStart).toFixed(1)}s, narr ${narrSec.toFixed(1)}s)`,
      Math.round((i / script.segments.length) * 70)
    );

    const outPath = path.join(beatsDir, `beat_${String(i).padStart(4, '0')}.mp4`);
    await cutAndOptionallyExtend(sourcePath, srcStart, srcEnd, narrSec, outPath, dims);
    clipPaths.push(outPath);
  }

  // Phase 2: concat into silent timeline (still has source audio per clip).
  onProgress('Concatenating timeline...', 75);
  const timelinePath = projectPath(projectId, 'explainer-timeline.mp4');
  await concatClips(clipPaths, timelinePath);

  // Phase 3: subtitles.
  onProgress('Generating subtitles from narration timestamps...', 85);
  let subsPath = null;
  try { subsPath = await generateProjectSubtitles(projectId, timestamps); }
  catch (err) { logger.warn(`[videoExplainerRenderer] subtitle gen failed: ${err.message} — rendering without subs`); }

  // Phase 4: final mux — narration dominant, source ducked + pitch-shifted.
  onProgress('Muxing narration + ducked source audio + subtitles...', 92);
  await ensureDir(projectPath(projectId, 'output'));
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
