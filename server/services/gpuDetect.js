import { execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../utils/logger.js';

let _nvencAvailable = null;
let _ffmpegPath = ffmpegStatic; // default to bundled (CPU only)

/**
 * Find system ffmpeg path (not the bundled static one).
 * Returns null if not found.
 */
function findSystemFfmpeg() {
  const candidates = ['ffmpeg', 'C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe'];
  for (const cmd of candidates) {
    try {
      const out = execSync(`"${cmd}" -version`, { stdio: 'pipe', timeout: 5000 }).toString();
      if (out.includes('ffmpeg version')) return cmd;
    } catch {}
  }
  return null;
}

/**
 * Probe whether h264_nvenc is listed as an available encoder.
 * Checks the encoders list rather than running a test encode,
 * which avoids GPU context issues in subprocess environments.
 */
function testNvenc(ffmpegBin) {
  try {
    const out = execSync(`"${ffmpegBin}" -encoders`, { stdio: 'pipe', timeout: 10000 }).toString();
    return out.includes('h264_nvenc');
  } catch {
    return false;
  }
}

/**
 * Detect NVENC support. Tries system ffmpeg first (supports NVENC),
 * then bundled ffmpeg-static (CPU only).
 * Result is cached after first call.
 */
export function detectNvenc() {
  if (_nvencAvailable !== null) return _nvencAvailable;

  // ffmpeg-static is CPU-only — must use system ffmpeg for NVENC
  const systemFfmpeg = findSystemFfmpeg();

  if (systemFfmpeg && testNvenc(systemFfmpeg)) {
    _nvencAvailable = true;
    _ffmpegPath = systemFfmpeg;
    logger.info(`GPU encoding available: h264_nvenc via ${systemFfmpeg}`);
  } else {
    _nvencAvailable = false;
    _ffmpegPath = ffmpegStatic;
    if (systemFfmpeg) {
      logger.info('System ffmpeg found but NVENC not supported — using CPU (libx264)');
    } else {
      logger.info('No system ffmpeg found — using bundled ffmpeg-static with CPU (libx264)');
      logger.info('To enable GPU encoding: install ffmpeg with NVENC support and ensure it is on PATH');
    }
  }

  return _nvencAvailable;
}

/**
 * Returns the ffmpeg binary path to use for encoding.
 * Must call detectNvenc() first (done at startup).
 */
export function getFfmpegPath() {
  return _ffmpegPath;
}

/**
 * Get ffmpeg video encoding options based on GPU availability and detail preset.
 */
export function getEncodingOptions(detailPreset) {
  const useNvenc = detectNvenc();

  if (useNvenc) {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',
      '-rc', 'vbr',
      '-cq', String(detailPreset.cq ?? detailPreset.crf),
      '-b:v', '8M',
      '-maxrate', '12M',
      '-pix_fmt', 'yuv420p',
    ];
  }

  return [
    '-c:v', 'libx264',
    '-preset', detailPreset.preset,
    '-crf', String(detailPreset.crf),
    '-pix_fmt', 'yuv420p',
  ];
}

/**
 * Force CPU (libx264) encoding regardless of GPU availability.
 * Use for parallel clip generation to avoid NVENC session limits.
 */
export function getCpuEncodingOptions(crf = 23, preset = 'ultrafast') {
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
}
