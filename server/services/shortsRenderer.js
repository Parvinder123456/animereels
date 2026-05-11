/**
 * Render short clips from a source video.
 *
 * For each detected clip window:
 *   1. Cuts the source video to that window
 *   2. Smart-crops to target aspect ratio (no black bars)
 *   3. Burns original-language subtitles from the transcript
 *   4. Outputs to output/clip_001.mp4, clip_002.mp4, ...
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import {
  ensureDir, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { logger } from '../utils/logger.js';

const ASPECT_PRESETS = {
  '16:9':     { width: 1920, height: 1080 },
  '9:16':     { width: 1080, height: 1920 },
  '1:1':      { width: 1080, height: 1080 },
};
const TARGET_FPS = 25;

// ─── ASS subtitle generation from transcript segments ────────────────────────

function toAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function assHeader(width, height) {
  const fontSize = width >= 1920 ? 48 : 36;
  const marginV = height >= 1920 ? 120 : 60;
  return `[Script Info]
Title: Shorts Subtitles
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,20,20,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

function buildAssFromSegments(segments, clipStartSec, { width, height }) {
  const lines = segments
    .filter(s => s.end > clipStartSec)
    .map(s => {
      const start = Math.max(0, s.start - clipStartSec);
      const end = s.end - clipStartSec;
      const text = s.text.replace(/\n/g, '\\N');
      return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`;
    });
  return assHeader(width, height) + lines.join('\n') + '\n';
}

// ─── Single clip renderer ────────────────────────────────────────────────────

function renderOneClip(srcPath, startSec, endSec, subsPath, outPath, { width, height }) {
  const vf = [
    `scale=w=${width}:h=${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `fps=${TARGET_FPS}`,
    'setsar=1',
  ];
  if (subsPath) {
    vf.push(`subtitles='${subsPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`);
  }

  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(startSec)
      .duration(endSec - startSec)
      .outputOptions([
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-vf', vf.join(','),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Clip render failed: ${err.message}`)))
      .run();
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {string} projectId
 * @param {Array<{startSec, endSec, title, reason}>} clips
 * @param {Array<{id, start, end, text}>} transcriptSegments - full transcript
 * @param {{aspect?:string, subtitles?:boolean}} opts
 * @param {Function} onProgress
 * @returns {Promise<Array<{path:string, title:string, startSec:number, endSec:number, index:number}>>}
 */
export async function renderShortClips(projectId, clips, transcriptSegments, opts = {}, onProgress = () => {}) {
  const sourcePath = projectPath(projectId, 'source.mp4');
  if (!await fileExists(sourcePath)) throw new Error('Source video missing');

  const aspect = opts.aspect || '9:16';
  const burnSubs = opts.subtitles !== false;
  const dims = ASPECT_PRESETS[aspect] || ASPECT_PRESETS['9:16'];

  const outDir = projectPath(projectId, 'output');
  await ensureDir(outDir);

  const results = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const idx = String(i + 1).padStart(3, '0');
    const clipPath = path.join(outDir, `clip_${idx}.mp4`);

    onProgress(`Rendering clip ${i + 1}/${clips.length}: ${clip.title}`, Math.round(((i) / clips.length) * 100));

    // Generate subtitle file for this clip's window
    let subsPath = null;
    if (burnSubs && transcriptSegments?.length) {
      const windowSegments = transcriptSegments.filter(
        s => s.start < clip.endSec && s.end > clip.startSec,
      );
      if (windowSegments.length) {
        subsPath = path.join(outDir, `subs_${idx}.ass`);
        const assContent = buildAssFromSegments(windowSegments, clip.startSec, dims);
        await fs.writeFile(subsPath, assContent, 'utf-8');
      }
    }

    await renderOneClip(sourcePath, clip.startSec, clip.endSec, subsPath, clipPath, dims);

    // Clean up temp subtitle file
    if (subsPath) {
      try { await fs.unlink(subsPath); } catch {}
    }

    results.push({
      path: clipPath,
      filename: `clip_${idx}.mp4`,
      title: clip.title,
      reason: clip.reason,
      startSec: clip.startSec,
      endSec: clip.endSec,
      durationSec: +(clip.endSec - clip.startSec).toFixed(1),
      index: i,
    });
  }

  onProgress(`All ${clips.length} clips rendered`, 100);
  logger.info(`[shortsRenderer] ${clips.length} clips rendered for ${projectId}`);
  return results;
}

/**
 * Render a single translated short clip: source video + EN narration + EN subtitles.
 * Mixes original audio at low volume under the English narration.
 */
export async function renderTranslatedShortClip(projectId, clip, enSegments, narrationPath, outPath, opts = {}) {
  const sourcePath = projectPath(projectId, 'source.mp4');
  if (!await fileExists(sourcePath)) throw new Error('Source video missing');

  const aspect = opts.aspect || '9:16';
  const dims = ASPECT_PRESETS[aspect] || ASPECT_PRESETS['9:16'];
  const outDir = path.dirname(outPath);
  await ensureDir(outDir);

  // Build EN subtitle file
  let subsPath = null;
  if (enSegments?.length) {
    subsPath = outPath.replace(/\.mp4$/, '_subs.ass');
    // Build ASS from translated segments (they have sourceStart/sourceEnd relative to full video)
    const assLines = enSegments.map(s => {
      const start = Math.max(0, (s.sourceStart || 0) - clip.startSec);
      const end = (s.sourceEnd || 0) - clip.startSec;
      const text = (s.text || '').replace(/\n/g, '\\N');
      return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`;
    });
    const assContent = assHeader(dims.width, dims.height) + assLines.join('\n') + '\n';
    await fs.writeFile(subsPath, assContent, 'utf-8');
  }

  const clipDuration = clip.endSec - clip.startSec;

  const sourceVolume = opts.sourceVolume ?? 0.05;

  // Smart-crop video + mix audio (original at low volume + EN narration at 100%)
  const vf = [
    `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase`,
    `crop=${dims.width}:${dims.height}`,
    `fps=${TARGET_FPS}`,
    'setsar=1',
  ];
  if (subsPath) {
    vf.push(`subtitles='${subsPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`);
  }

  await new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(clip.startSec)
      .duration(clipDuration)
      .input(narrationPath)
      .complexFilter([
        `[0:v]${vf.join(',')}[v]`,
        `[0:a]volume=${sourceVolume}[src]`,
        '[1:a]volume=1.0[narr]',
        '[src][narr]amix=inputs=2:duration=longest:dropout_transition=0[a]',
      ])
      .outputOptions([
        '-map', '[v]',
        '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-t', String(clipDuration.toFixed(3)),
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Translated clip render failed: ${err.message}`)))
      .run();
  });

  if (subsPath) { try { await fs.unlink(subsPath); } catch {} }
  logger.info(`[shortsRenderer] translated clip rendered: ${outPath}`);
}
