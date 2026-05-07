/**
 * Video ingestion: probe an uploaded source video and expose the basic
 * facts the rest of the pipeline needs (duration, dims, fps, codec).
 *
 * No transcoding here — we keep the original file as-is and let
 * sceneDetector / clipExtractor seek into it directly. Transcoding to a
 * normalized intermediate is a Phase 2 optimization.
 */

import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';
import { logger } from '../utils/logger.js';

ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Resolve fluent-ffmpeg's frame-rate string ("24000/1001") to a number.
 */
function parseFps(rate) {
  if (!rate) return null;
  if (typeof rate === 'number') return rate;
  const [n, d] = String(rate).split('/').map(Number);
  if (!n || !d) return null;
  return n / d;
}

export function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      const video = (data.streams || []).find(s => s.codec_type === 'video');
      const audio = (data.streams || []).find(s => s.codec_type === 'audio');
      if (!video) return reject(new Error('No video stream found in source'));

      const durationSec = parseFloat(data.format?.duration ?? video.duration ?? 0);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return reject(new Error('Could not determine video duration'));
      }

      resolve({
        path: filePath,
        durationSec,
        width: video.width,
        height: video.height,
        fps: parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate),
        videoCodec: video.codec_name,
        audioCodec: audio?.codec_name || null,
        hasAudio: !!audio,
        sizeBytes: parseInt(data.format?.size ?? 0, 10) || null,
      });
    });
  });
}

const MAX_DURATION_SEC = 30 * 60; // 30 minutes — pre-flight default; raise via setting later

export async function ingestVideo(filePath) {
  const meta = await probeVideo(filePath);
  if (meta.durationSec > MAX_DURATION_SEC) {
    throw new Error(
      `Source video is ${(meta.durationSec / 60).toFixed(1)} min — over the ${MAX_DURATION_SEC / 60}-min cap`
    );
  }
  if (!meta.hasAudio) {
    logger.warn(`[videoIngestion] No audio stream in ${filePath} — clip beats will be silent`);
  }
  logger.info(
    `[videoIngestion] ${filePath} · ${meta.width}x${meta.height} · ${meta.fps?.toFixed(1)} fps · ` +
    `${(meta.durationSec / 60).toFixed(1)} min · ${meta.videoCodec}/${meta.audioCodec || 'no-audio'}`
  );
  return meta;
}
