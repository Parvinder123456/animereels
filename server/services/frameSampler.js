/**
 * Frame sampling: for each detected scene, extract one representative
 * frame (the middle frame of the scene) at a low enough resolution to
 * keep Gemini multimodal calls cheap.
 *
 * Output: array of { sceneIndex, framePath, atSec } parallel to the
 * input scenes array.
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import { ensureDir } from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { logger } from '../utils/logger.js';

const FRAME_WIDTH = 768; // matches the local-vision resize ceiling in visionClient

function extractSingleFrame(srcPath, atSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(atSec)
      .outputOptions([
        '-frames:v', '1',
        '-vf', `scale=${FRAME_WIDTH}:-2`,
        '-q:v', '4',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Frame extract @${atSec}s failed: ${err.message}`)))
      .run();
  });
}

export async function sampleFramesForScenes(srcPath, scenes, outDir) {
  await ensureDir(outDir);
  const frames = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const atSec = scene.startSec + scene.durationSec / 2;
    const framePath = path.join(outDir, `scene_${String(i).padStart(4, '0')}.jpg`);
    try {
      await extractSingleFrame(srcPath, atSec, framePath);
      frames.push({ sceneIndex: i, framePath, atSec });
    } catch (err) {
      logger.warn(`[frameSampler] scene ${i} extract failed: ${err.message}`);
    }
  }

  logger.info(`[frameSampler] ${frames.length}/${scenes.length} frames extracted to ${outDir}`);
  return frames;
}
