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

function runYtDlp(args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      text.split('\n').forEach(line => { if (line.trim()) onLine?.(line.trim()); });
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', err => reject(new Error(`yt-dlp failed to start: ${err.message}. Is yt-dlp on PATH?`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-1000)}`));
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
    const proc = spawn(YT_DLP_BIN, ['-J', '--no-warnings', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', c => { out += c.toString(); });
    proc.stderr.on('data', c => { err += c.toString(); });
    proc.on('error', e => reject(new Error(`yt-dlp probe failed: ${e.message}. Is yt-dlp on PATH?`)));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp probe exited ${code}: ${err.slice(-500)}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`yt-dlp probe returned non-JSON: ${e.message}`)); }
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

  onProgress('Probing video metadata...', 5);
  const meta = await probeMetadata(url);
  const durationSec = Number(meta.duration) || 0;
  if (!durationSec) throw new Error('yt-dlp did not report a duration — is the URL valid?');
  if (durationSec > MAX_DURATION_SEC) {
    throw new Error(
      `Video is ${(durationSec / 60).toFixed(1)} min — over the ${MAX_DURATION_SEC / 60}-min cap`
    );
  }

  const projDir = projectPath(projectId);
  await ensureDir(projDir);
  const outPath = path.join(projDir, 'source.mp4');

  onProgress(`Downloading "${meta.title || url}" (${(durationSec / 60).toFixed(1)} min)...`, 10);
  await runYtDlp(
    [
      '-f', 'bv*+ba/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', outPath,
      url,
    ],
    line => {
      const pct = line.match(/\[download\]\s+([\d.]+)%/)?.[1];
      if (pct) onProgress(`Downloading… ${pct}%`, 10 + Math.round(parseFloat(pct) * 0.85));
    }
  );

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
