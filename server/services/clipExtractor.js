/**
 * Cut the selected windows out of the source video as standalone mp4 files,
 * normalized to a single resolution / fps / codec so they can be concat'd
 * cleanly later.
 *
 * Each clip is re-encoded (not stream-copied) — stream-copy ignores
 * non-keyframe seek points and produces black/glitched openings. The cost
 * is small for short clips.
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import { ensureDir } from '../utils/fileHelpers.js';
import { getFfmpegPath, getCpuEncodingOptions } from './gpuDetect.js';
import { logger } from '../utils/logger.js';

const TARGET_WIDTH  = 1920;
const TARGET_HEIGHT = 1080;
const TARGET_FPS    = 25;

function extractOne(srcPath, clip, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(clip.startSec)
      .duration(clip.durationSec)
      .outputOptions([
        ...getCpuEncodingOptions(20, 'veryfast'),
        '-vf', `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
               `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,` +
               `fps=${TARGET_FPS},setsar=1`,
        '-c:a', 'aac',
        '-b:a', '160k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Clip extract failed for clip ${clip.clipIndex}: ${err.message}`)))
      .run();
  });
}

/**
 * @param {string} srcPath path to the source video
 * @param {Array<{clipIndex, startSec, endSec, durationSec}>} clips
 * @param {string} outDir directory to write clip files into
 */
export async function extractClips(srcPath, clips, outDir, onProgress = () => {}) {
  await ensureDir(outDir);
  const out = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const outPath = path.join(outDir, `clip_${String(clip.clipIndex).padStart(4, '0')}.mp4`);
    onProgress(`Extracting clip ${i + 1}/${clips.length}`, Math.round((i / clips.length) * 100));
    await extractOne(srcPath, clip, outPath);
    out.push({ ...clip, clipPath: outPath });
  }

  logger.info(`[clipExtractor] extracted ${out.length} clips to ${outDir}`);
  return out;
}
