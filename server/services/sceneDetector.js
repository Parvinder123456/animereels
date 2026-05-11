/**
 * Scene detection: run ffmpeg's `select='gt(scene,T)'` filter once over
 * the source video and capture the timestamp of every cut.
 *
 * Output: array of { startSec, endSec } windows covering the full video.
 * Adjacent cuts become adjacent windows (so the union is the whole timeline).
 */

import ffmpeg from 'fluent-ffmpeg';
import { getFfmpegPath } from './gpuDetect.js';
import { logger } from '../utils/logger.js';

const DEFAULT_THRESHOLD = 0.30;
const MIN_SCENE_SEC = 1.5;  // collapse very short scenes (cross-fades, flashes)

/**
 * Run ffmpeg with showinfo to get scene-cut timestamps.
 * Returns array of cut points in seconds (NOT including 0 or duration).
 */
function detectCutTimestamps(srcPath, threshold) {
  return new Promise((resolve, reject) => {
    const cuts = [];
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .videoFilters(`select='gt(scene,${threshold})',showinfo`)
      .outputOptions(['-f', 'null', '-an'])
      .output(process.platform === 'win32' ? 'NUL' : '/dev/null')
      .on('stderr', line => {
        // showinfo emits lines like:
        //   [Parsed_showinfo_1 @ 0x...] n:  12 pts:1234 pts_time:51.4 ...
        const m = line.match(/pts_time:([\d.]+)/);
        if (m) {
          const t = parseFloat(m[1]);
          if (Number.isFinite(t) && t > 0) cuts.push(t);
        }
      })
      .on('end', () => resolve(cuts))
      .on('error', err => reject(new Error(`Scene detection failed: ${err.message}`)))
      .run();
  });
}

export async function detectScenes(srcPath, durationSec, { threshold = DEFAULT_THRESHOLD } = {}) {
  const cuts = await detectCutTimestamps(srcPath, threshold);

  // Build windows: [0, cut1], [cut1, cut2], ..., [cutN, duration]
  const boundaries = [0, ...cuts, durationSec].sort((a, b) => a - b);
  const windows = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSec = boundaries[i];
    const endSec = boundaries[i + 1];
    if (endSec - startSec < MIN_SCENE_SEC) continue; // skip flashes / cross-fades
    windows.push({ startSec, endSec, durationSec: endSec - startSec });
  }

  logger.info(`[sceneDetector] ${cuts.length} cuts → ${windows.length} scenes (≥${MIN_SCENE_SEC}s)`);
  return windows;
}
