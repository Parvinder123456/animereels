/**
 * Render a translated-clip project (Phase 3) to final.mp4.
 *
 * Inputs (already produced by earlier pipeline steps):
 *   data/projects/<id>/source.mp4
 *   data/projects/<id>/script.json          — translated narration + sourceWindow
 *   data/projects/<id>/audio/narration.mp3  — English narrator
 *   data/projects/<id>/audio/timestamps.json (word boundaries from TTS)
 *
 * Output:
 *   data/projects/<id>/output/final.mp4
 *
 * Behavior:
 *   - Cuts source.mp4 to the sourceWindow (keeps original audio).
 *   - Time-aligns narration to the source window: if narration is up to
 *     1.25× shorter or longer, atempo it to fit. Beyond that we let it
 *     run long and extend the video by freezing the last frame.
 *   - Mixes Hindi original at 18% under English narration at 100%.
 *   - Burns subtitles from the narration's word timestamps.
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
const SOURCE_AUDIO_GAIN = 0.18;
const NARRATOR_GAIN     = 1.0;
const ATEMPO_MAX = 1.25;
const ATEMPO_MIN = 0.80;

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data?.format?.duration) return reject(err || new Error('no duration'));
      resolve(parseFloat(data.format.duration));
    });
  });
}

function cutSourceWindow(srcPath, startSec, endSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(startSec)
      .duration(endSec - startSec)
      .outputOptions([
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-vf', `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
               `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,` +
               `fps=${TARGET_FPS},setsar=1`,
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Source cut failed: ${err.message}`)))
      .run();
  });
}

/**
 * Time-fit the narrator audio to the target duration via atempo. Returns
 * the path to the (possibly modified) narration file and its final
 * duration.
 */
async function fitNarrationToWindow(narrationPath, narrationSec, targetSec, outPath) {
  if (narrationSec <= 0) throw new Error('Narration is empty');
  let factor = narrationSec / targetSec;
  factor = Math.min(ATEMPO_MAX, Math.max(ATEMPO_MIN, factor));

  if (Math.abs(factor - 1) < 0.02) {
    return { path: narrationPath, durationSec: narrationSec, atempo: 1 };
  }

  await new Promise((resolve, reject) => {
    ffmpeg(narrationPath)
      .setFfmpegPath(getFfmpegPath())
      .audioFilters([`atempo=${factor.toFixed(3)}`])
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`atempo failed: ${err.message}`)))
      .run();
  });

  return { path: outPath, durationSec: narrationSec / factor, atempo: factor };
}

function mixAndBurnSubs(videoPath, narrationPath, subsPath, finalDurationSec, outPath, detailPreset) {
  return new Promise((resolve, reject) => {
    const subFilter = subsPath
      ? `,subtitles='${subsPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
      : '';

    ffmpeg(videoPath)
      .setFfmpegPath(getFfmpegPath())
      .input(narrationPath)
      .complexFilter([
        `[0:v]scale=${TARGET_WIDTH}:${TARGET_HEIGHT},setsar=1${subFilter}[v]`,
        `[0:a]volume=${SOURCE_AUDIO_GAIN}[src]`,
        `[1:a]volume=${NARRATOR_GAIN}[narr]`,
        `[src][narr]amix=inputs=2:duration=longest:dropout_transition=0[a]`,
      ])
      .outputOptions([
        '-map', '[v]',
        '-map', '[a]',
        ...getEncodingOptions(detailPreset),
        '-c:a', 'aac', '-b:a', '192k',
        '-t', String(finalDurationSec.toFixed(3)),
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Mix failed: ${err.message}`)))
      .run();
  });
}

export async function renderTranslatedClip(projectId, onProgress = () => {}) {
  const sourcePath    = projectPath(projectId, 'source.mp4');
  const script        = await safeReadJson(projectPath(projectId, 'script.json'));
  const timestamps    = await safeReadJson(projectPath(projectId, 'audio', 'timestamps.json'));
  const narrationPath = projectPath(projectId, 'audio', 'narration.mp3');

  if (!await fileExists(sourcePath))    throw new Error(`Source video missing: ${sourcePath}`);
  if (!script?.sourceWindow)            throw new Error('script.json missing sourceWindow — run translate orchestrator first');
  if (!await fileExists(narrationPath)) throw new Error('Narration not generated — run /voice/generate first');

  const project = await safeReadJson(projectPath(projectId, 'project.json'));
  const detail = getDetailPreset(project?.config?.detail || 'medium');

  const { startSec, endSec } = script.sourceWindow;
  const targetDurationSec = endSec - startSec;

  await ensureDir(projectPath(projectId, 'output'));

  onProgress('Cutting source window (with Hindi audio)...', 10);
  const cutPath = projectPath(projectId, 'source-cut.mp4');
  await cutSourceWindow(sourcePath, startSec, endSec, cutPath);

  onProgress('Time-fitting narration to source window...', 35);
  const narrationSec = await ffprobeDuration(narrationPath);
  const fittedNarration = await fitNarrationToWindow(
    narrationPath,
    narrationSec,
    targetDurationSec,
    projectPath(projectId, 'audio', 'narration-fitted.mp3'),
  );
  logger.info(
    `[translatedRenderer] narration ${narrationSec.toFixed(1)}s → ${fittedNarration.durationSec.toFixed(1)}s ` +
    `(atempo ${fittedNarration.atempo.toFixed(2)}) target window ${targetDurationSec.toFixed(1)}s`
  );

  onProgress('Generating English subtitles...', 60);
  let subsPath = null;
  try {
    subsPath = await generateProjectSubtitles(projectId, timestamps);
  } catch (err) {
    logger.warn(`[translatedRenderer] subtitle generation failed: ${err.message}`);
  }

  onProgress('Mixing narration over source + burning subs...', 75);
  const finalPath = projectPath(projectId, 'output', 'final.mp4');
  // Use the longer of (target window, fitted narration) so nothing is clipped early.
  const finalDuration = Math.max(targetDurationSec, fittedNarration.durationSec);
  await mixAndBurnSubs(cutPath, fittedNarration.path, subsPath, finalDuration, finalPath, detail);

  try { await fs.unlink(cutPath); } catch {}
  if (fittedNarration.path !== narrationPath) {
    try { await fs.unlink(fittedNarration.path); } catch {}
  }

  onProgress('Render complete', 100);
  logger.info(`[translatedRenderer] final.mp4 written for ${projectId} (${finalDuration.toFixed(1)}s)`);
  return finalPath;
}
