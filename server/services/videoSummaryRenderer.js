/**
 * Render a video-summary project to final.mp4.
 *
 * Inputs (already produced by earlier pipeline steps):
 *   data/projects/<id>/source.mp4         — original episode
 *   data/projects/<id>/clips.json         — picked clips with source windows
 *   data/projects/<id>/script.json        — narration script (segments → clipIndex)
 *   data/projects/<id>/audio/narration.mp3
 *   data/projects/<id>/audio/timestamps.json (segmentBoundaries)
 *
 * Output:
 *   data/projects/<id>/final.mp4
 *
 * Phase 1 keeps it intentionally simple: narration is the only audio track,
 * the source audio is dropped. Ducked-original-audio is a Phase 2 polish.
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

const TARGET_WIDTH  = 1920;
const TARGET_HEIGHT = 1080;
const TARGET_FPS    = 25;

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data?.format?.duration) return reject(err || new Error('no duration'));
      resolve(parseFloat(data.format.duration));
    });
  });
}

/**
 * Re-cut one source window to a target duration, centered on the
 * window's midpoint. The cut is clamped to the scene boundaries.
 */
function recutClipToDuration(srcPath, originalClip, narrationSec, outPath) {
  const center = (originalClip.startSec + originalClip.endSec) / 2;
  const sceneStart = originalClip.sceneStartSec ?? originalClip.startSec;
  const sceneEnd   = originalClip.sceneEndSec   ?? originalClip.endSec;
  const half = narrationSec / 2;

  let start = center - half;
  let end   = center + half;
  if (start < sceneStart) { end += (sceneStart - start); start = sceneStart; }
  if (end > sceneEnd)     { start -= (end - sceneEnd);   end   = sceneEnd; }
  start = Math.max(0, start);

  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(start)
      .duration(end - start)
      .outputOptions([
        '-an',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-vf', `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
               `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,` +
               `fps=${TARGET_FPS},setsar=1`,
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Recut clip ${originalClip.clipIndex} failed: ${err.message}`)))
      .run();
  });
}

function concatVideos(inputPaths, outPath) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().setFfmpegPath(getFfmpegPath());
    inputPaths.forEach(p => cmd.input(p));
    const filterParts = inputPaths.map((_, i) => `[${i}:v]`).join('');
    cmd
      .complexFilter([`${filterParts}concat=n=${inputPaths.length}:v=1:a=0[v]`])
      .outputOptions([
        '-map', '[v]',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-an',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Concat failed: ${err.message}`)))
      .run();
  });
}

function muxAudioAndSubs(silentVideoPath, audioPath, subsPath, outPath, detailPreset) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(silentVideoPath)
      .setFfmpegPath(getFfmpegPath())
      .input(audioPath);

    const subFilter = subsPath ? `,subtitles='${subsPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'` : '';

    cmd
      .complexFilter([`[0:v]scale=${TARGET_WIDTH}:${TARGET_HEIGHT},setsar=1${subFilter}[v]`])
      .outputOptions([
        '-map', '[v]',
        '-map', '1:a',
        ...getEncodingOptions(detailPreset),
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Mux failed: ${err.message}`)))
      .run();
  });
}

export async function renderVideoSummary(projectId, onProgress = () => {}) {
  const sourcePath = projectPath(projectId, 'source.mp4');
  const script     = await safeReadJson(projectPath(projectId, 'script.json'));
  const clips      = await safeReadJson(projectPath(projectId, 'clips.json'));
  const timestamps = await safeReadJson(projectPath(projectId, 'audio', 'timestamps.json'));
  const audioPath  = projectPath(projectId, 'audio', 'narration.mp3');

  if (!await fileExists(sourcePath)) throw new Error(`Source video missing: ${sourcePath}`);
  if (!script?.segments?.length)     throw new Error('No script — generate script first');
  if (!clips?.length)                throw new Error('No clips.json — run pipeline through momentSelector first');
  if (!await fileExists(audioPath))  throw new Error('No narration audio — run voice generation first');

  const segmentBoundaries = timestamps?.segmentBoundaries || [];
  const audioDuration = await ffprobeDuration(audioPath);
  logger.info(`[videoSummaryRenderer] narration ${audioDuration.toFixed(1)}s · ${segmentBoundaries.length} segment boundaries`);

  const project = await safeReadJson(projectPath(projectId, 'project.json'));
  const detail = getDetailPreset(project?.config?.detail || 'medium');

  const recutDir = projectPath(projectId, 'clips_recut');
  await ensureDir(recutDir);

  const recutPaths = [];
  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    const clip = clips.find(c => c.clipIndex === seg.clipIndex);
    if (!clip) {
      logger.warn(`[videoSummaryRenderer] segment ${i} has no matching clip (clipIndex=${seg.clipIndex}) — skipping`);
      continue;
    }
    const boundary = segmentBoundaries[i];
    const narrationSec = boundary
      ? Math.max(0.5, boundary.endTime - boundary.startTime)
      : Math.max(0.5, clip.durationSec);

    onProgress(`Recutting clip ${i + 1}/${script.segments.length} to ${narrationSec.toFixed(1)}s`,
      Math.round((i / script.segments.length) * 40));

    const outPath = path.join(recutDir, `seg_${String(i).padStart(4, '0')}.mp4`);
    await recutClipToDuration(sourcePath, clip, narrationSec, outPath);
    recutPaths.push(outPath);
  }

  if (!recutPaths.length) throw new Error('No clips were re-cut — nothing to render');

  onProgress('Concatenating clips...', 50);
  const silentVideoPath = projectPath(projectId, 'concat-silent.mp4');
  await concatVideos(recutPaths, silentVideoPath);

  onProgress('Generating subtitles...', 70);
  let subsPath = null;
  try {
    subsPath = await generateProjectSubtitles(projectId, timestamps);
  } catch (err) {
    logger.warn(`[videoSummaryRenderer] subtitle generation failed: ${err.message} — rendering without subs`);
  }

  onProgress('Muxing audio + video + subtitles...', 85);
  await ensureDir(projectPath(projectId, 'output'));
  const finalPath = projectPath(projectId, 'output', 'final.mp4');
  await muxAudioAndSubs(silentVideoPath, audioPath, subsPath, finalPath, detail);

  // Best-effort cleanup of intermediates
  try {
    await fs.unlink(silentVideoPath);
    for (const p of recutPaths) await fs.unlink(p);
    await fs.rmdir(recutDir);
  } catch {}

  onProgress('Render complete', 100);
  logger.info(`[videoSummaryRenderer] final.mp4 written for ${projectId}`);
  return finalPath;
}
