/**
 * YouTube downloader: shells out to yt-dlp to grab the source video and
 * audio for a given URL. Output is a single mp4 with audio.
 *
 * Requires `yt-dlp` on PATH:
 *   - macOS:   `brew install yt-dlp`
 *   - Linux:   `pip install yt-dlp`  (or apt for nix; see nixpacks.toml)
 *   - Windows: `winget install yt-dlp` or grab the binary from
 *              https://github.com/yt-dlp/yt-dlp/releases
 *
 * The service does not transcode — yt-dlp's `-f bv*+ba/best --merge-output-format mp4`
 * gives us a usable mp4 directly, and the rest of the pipeline (sceneDetector,
 * clipExtractor, etc.) handles whatever container/codec it produces.
 */

import { spawn } from 'child_process';
import path from 'path';
import { ensureDir, projectPath, fileExists } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const YT_DLP_BIN = process.env.YT_DLP_PATH || 'yt-dlp';
const MAX_DURATION_SEC = 90 * 60; // 90 min ceiling for translate jobs

const DL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min max per yt-dlp invocation

function runYtDlp(args, onLine, timeoutMs = DL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const proc = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    const timer = setTimeout(() => {
      logger.warn('[youtubeDownloader] yt-dlp timed out, killing process');
      proc.kill('SIGKILL');
      settle(reject, new Error(`yt-dlp timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      try {
        const text = chunk.toString();
        text.split('\n').forEach(line => { if (line.trim()) onLine?.(line.trim()); });
      } catch (e) {
        logger.warn(`[youtubeDownloader] onLine callback error: ${e.message}`);
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', err => {
      clearTimeout(timer);
      settle(reject, new Error(`yt-dlp failed to start: ${err.message}. Is yt-dlp on PATH?`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return settle(resolve);
      settle(reject, new Error(`yt-dlp exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

/**
 * Probe the video's metadata BEFORE downloading. yt-dlp `-J` returns full
 * video info as JSON without fetching the media — used to enforce the
 * duration cap and to surface a useful title/description.
 */
async function probeMetadata(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const proc = spawn(YT_DLP_BIN, ['-J', '--no-warnings', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    const timer = setTimeout(() => {
      logger.warn('[youtubeDownloader] probe timed out, killing');
      proc.kill('SIGKILL');
      settle(reject, new Error('yt-dlp probe timed out after 60s'));
    }, 60_000);

    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { err += c.toString(); });
    proc.on('error', e => {
      clearTimeout(timer);
      settle(reject, new Error(`yt-dlp probe failed: ${e.message}. Is yt-dlp on PATH?`));
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return settle(reject, new Error(`yt-dlp probe exited ${code}: ${err.slice(-500)}`));
      try { settle(resolve, JSON.parse(out)); }
      catch (e) { settle(reject, new Error(`yt-dlp probe returned non-JSON: ${e.message}`)); }
    });
  });
}

/**
 * Download a YouTube video to data/projects/<id>/source.mp4.
 *
 * @returns {Promise<{path:string, durationSec:number, title:string, language:string|null}>}
 */
export async function downloadYouTubeVideo(projectId, url, onProgress = () => {}) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Invalid URL: expected http(s)://...');
  }

  const projDir = projectPath(projectId);
  await ensureDir(projDir);
  const outPath = path.join(projDir, 'source.mp4');

  onProgress('Probing video metadata...', 5);
  const meta = await probeMetadata(url);
  const durationSec = Number(meta.duration) || 0;
  if (!durationSec) throw new Error('yt-dlp did not report a duration — is the URL valid?');
  if (durationSec > MAX_DURATION_SEC) {
    throw new Error(
      `Video is ${(durationSec / 60).toFixed(1)} min — over the ${MAX_DURATION_SEC / 60}-min cap`
    );
  }

  // Skip download if source.mp4 already exists (e.g. previous failed run)
  if (await fileExists(outPath)) {
    logger.info(`[youtubeDownloader] source.mp4 already exists, skipping download for ${url}`);
    onProgress('Download complete (cached)', 100);
    return {
      path: outPath,
      durationSec,
      title: meta.title || '',
      language: meta.language || null,
    };
  }

  onProgress(`Downloading "${meta.title || url}" (${(durationSec / 60).toFixed(1)} min)...`, 10);

  const makeProgressHandler = () => {
    let lastReportedPct = 0;
    return (line) => {
      const pct = line.match(/\[download\]\s+([\d.]+)%/)?.[1];
      if (pct) {
        const n = parseFloat(pct);
        if (n - lastReportedPct >= 2 || n >= 100) {
          lastReportedPct = n;
          onProgress(`Downloading… ${pct}%`, 10 + Math.round(n * 0.85));
        }
      }
    };
  };

  const baseArgs = ['--no-playlist', '--retries', '10', '--fragment-retries', '10', '--force-overwrite', '-o', outPath, url];

  try {
    logger.info(`[youtubeDownloader] attempt 1: default bv*+ba/best for ${url}`);
    await runYtDlp(
      ['-f', 'bv*+ba/best', '--merge-output-format', 'mp4', ...baseArgs],
      makeProgressHandler(),
    );
    logger.info(`[youtubeDownloader] attempt 1 succeeded`);
  } catch (err) {
    logger.warn(`[youtubeDownloader] attempt 1 failed: ${err.message}`);
    onProgress('Retrying download (mweb fallback)…', 10);
    logger.info(`[youtubeDownloader] attempt 2: mweb fallback for ${url}`);
    await runYtDlp(
      [
        '--extractor-args', 'youtube:player_client=mweb',
        '-f', 'best[ext=mp4]/best', '--merge-output-format', 'mp4',
        ...baseArgs,
      ],
      makeProgressHandler(),
    );
    logger.info(`[youtubeDownloader] attempt 2 succeeded`);
  }

  if (!await fileExists(outPath)) {
    throw new Error(`yt-dlp finished but ${outPath} is missing`);
  }

  onProgress('Download complete', 100);
  logger.info(`[youtubeDownloader] ${url} → ${outPath} (${(durationSec / 60).toFixed(1)} min)`);
  return {
    path: outPath,
    durationSec,
    title: meta.title || '',
    language: meta.language || null,
  };
}
