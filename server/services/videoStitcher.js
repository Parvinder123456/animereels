/**
 * Concatenate N uploaded video files into a single source.mp4 via ffmpeg's
 * concat demuxer. Re-encodes once to a uniform codec/resolution so all
 * downstream steps (whisper, scene-detect, render) see a single coherent
 * source — concat-copy would only work if every input were already
 * identically encoded, which we cannot rely on.
 *
 * Output:
 *   data/projects/<id>/source.mp4         — stitched single file
 *   data/projects/<id>/episodes.json      — { files: [{idx, path, durationSec, startSec}], totalSec }
 *
 * The per-file offsets in episodes.json are what later steps use to map
 * timestamps back to "which episode this happened in".
 */

import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';
import fs from 'fs/promises';
import path from 'path';
import { ensureDir, projectPath, safeWriteJson } from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { logger } from '../utils/logger.js';

ffmpeg.setFfprobePath(ffprobeStatic.path);

const TARGET_WIDTH  = 1920;
const TARGET_HEIGHT = 1080;
const TARGET_FPS    = 25;

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data?.format?.duration) return reject(err || new Error(`no duration for ${filePath}`));
      resolve(parseFloat(data.format.duration));
    });
  });
}

/**
 * Normalize one input to a uniform encoding/dims. We can't stream-copy the
 * concat result because inputs typically vary in codec, sample rate, or fps.
 */
function normalizeOne(srcPath, outPath) {
  const vf = [
    `scale=w=${TARGET_WIDTH}:h=${TARGET_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${TARGET_FPS}`,
    'setsar=1',
  ].join(',');

  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .outputOptions([
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-vf', vf,
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Normalize failed for ${path.basename(srcPath)}: ${err.message}`)))
      .run();
  });
}

function concatList(normalizedPaths, outPath) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().setFfmpegPath(getFfmpegPath());
    normalizedPaths.forEach(p => cmd.input(p));
    const filterParts = normalizedPaths.map((_, i) => `[${i}:v][${i}:a]`).join('');
    cmd
      .complexFilter([`${filterParts}concat=n=${normalizedPaths.length}:v=1:a=1[v][a]`])
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
 * @param {string} projectId
 * @param {string[]} inputPaths  paths to uploaded files (preserve order)
 * @param {(msg:string, pct:number)=>void} onProgress
 * @returns {Promise<{path:string, totalSec:number, episodes:Array<{idx:number, path:string, durationSec:number, startSec:number}>}>}
 */
export async function stitchEpisodes(projectId, inputPaths, onProgress = () => {}) {
  if (!inputPaths?.length) throw new Error('No input files');
  if (inputPaths.length === 1) {
    // Single file — still normalize so the downstream pipeline gets a known shape.
    onProgress('Single source — normalizing...', 5);
    const out = projectPath(projectId, 'source.mp4');
    await normalizeOne(inputPaths[0], out);
    const dur = await probeDuration(out);
    const episodes = [{ idx: 0, path: out, durationSec: dur, startSec: 0 }];
    await safeWriteJson(projectPath(projectId, 'episodes.json'), { files: episodes, totalSec: dur });
    onProgress('Normalize complete', 100);
    return { path: out, totalSec: dur, episodes };
  }

  const tmpDir = projectPath(projectId, '_stitch_tmp');
  await ensureDir(tmpDir);
  const normalizedPaths = [];

  for (let i = 0; i < inputPaths.length; i++) {
    onProgress(`Normalizing ${i + 1}/${inputPaths.length}...`, 5 + Math.round((i / inputPaths.length) * 50));
    const out = path.join(tmpDir, `norm_${String(i).padStart(2, '0')}.mp4`);
    await normalizeOne(inputPaths[i], out);
    normalizedPaths.push(out);
  }

  onProgress('Concatenating into stitched source...', 60);
  const finalPath = projectPath(projectId, 'source.mp4');
  await concatList(normalizedPaths, finalPath);

  // Build episodes manifest with cumulative offsets.
  const episodes = [];
  let cursor = 0;
  for (let i = 0; i < normalizedPaths.length; i++) {
    const dur = await probeDuration(normalizedPaths[i]);
    episodes.push({ idx: i, path: normalizedPaths[i], durationSec: dur, startSec: cursor });
    cursor += dur;
  }
  await safeWriteJson(projectPath(projectId, 'episodes.json'), { files: episodes, totalSec: cursor });

  // Clean up the per-file normalized intermediates — they're inside the stitched output now.
  // (We keep them only if a future iteration wants to recompute boundaries without restitching.)
  for (const p of normalizedPaths) {
    try { await fs.unlink(p); } catch {}
  }
  try { await fs.rmdir(tmpDir); } catch {}

  onProgress('Stitch complete', 100);
  logger.info(`[videoStitcher] stitched ${inputPaths.length} files → ${(cursor / 60).toFixed(1)} min`);
  return { path: finalPath, totalSec: cursor, episodes };
}
