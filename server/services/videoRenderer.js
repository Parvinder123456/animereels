import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import {
  ensureDir, safeReadJson, safeWriteJson,
  listImages, projectPath, fileExists
} from '../utils/fileHelpers.js';
import { buildTimeline } from './timelineBuilder.js';
import { selectMusicTrack } from './audioMixer.js';
import { extractTimestamps } from './whisperTimestamps.js';
import { getDetailPreset } from './detailPresets.js';
import { getEncodingOptions, getFfmpegPath } from './gpuDetect.js';
import { detectFocusRegions } from './cameraDirector.js';
import { generateProjectSubtitles } from './subtitleGenerator.js';
import { renderScrollClip, buildScrollPath } from './webtoonCamera.js';
import { logger } from '../utils/logger.js';

ffmpeg.setFfmpegPath(ffmpegStatic); // default; overridden per-command when GPU is active
ffmpeg.setFfprobePath(ffprobeStatic.path);

const FPS = 25;

function createFfmpeg() {
  const cmd = ffmpeg();
  cmd.setFfmpegPath(getFfmpegPath()); // use system ffmpeg if GPU detected, else bundled
  return cmd;
}

function getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err || !data?.format?.duration) return resolve(null);
      resolve(parseFloat(data.format.duration));
    });
  });
}

// ─── Parallel execution helper ────────────────────────────────────────────────

async function parallelMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Mood → zoom behaviour mapping ──────────────────────────────────────────

function moodZoomStyle(mood) {
  switch ((mood || '').toLowerCase()) {
    case 'action':
    case 'horror':
      return { zoomIn: true, amount: 0.45, drift: 'center' };
    case 'suspense':
    case 'reveal':
      return { zoomIn: true, amount: 0.3, drift: 'corner' };
    case 'emotional':
    case 'calm':
      return { zoomIn: false, amount: 0.3, drift: 'center' };
    case 'comedic':
      return { zoomIn: true, amount: 0.2, drift: 'pan' };
    case 'dramatic':
      return { zoomIn: true, amount: 0.35, drift: 'top' };
    default:
      return { zoomIn: true, amount: 0.25, drift: 'center' };
  }
}

// ─── Single-shot zoompan clip generator ─────────────────────────────────────

function generateRegionZoomClip(imagePath, region, duration, outputPath, style) {
  const totalFrames = Math.max(2, Math.round(Math.max(0.4, duration) * FPS));
  logger.info(`[generateRegionZoomClip] START — ${path.basename(imagePath)}, duration: ${duration.toFixed(2)}s, ${totalFrames} frames, zoomIn: ${style.zoomIn}, region: x=${region.x.toFixed(2)} y=${region.y.toFixed(2)} w=${region.w.toFixed(2)} h=${region.h.toFixed(2)} label="${region.label || ''}"`);

  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;

  // Cap zoom: for webtoon strips show full width at 1.0, for manga slight zoom for cinematic effect.
  // With scale=1200:-2, at zoom=1.0 the 1080px output shows full image width.
  const regionScale = Math.max(region.w, region.h * (9 / 16));
  const baseZoom = Math.min(1.5, Math.max(1.0, 0.75 / regionScale));

  let startZ, endZ;
  if (style.zoomIn) {
    startZ = Math.max(1.0, baseZoom * 0.9);
    endZ = baseZoom;
  } else {
    startZ = baseZoom;
    endZ = Math.max(1.0, baseZoom * 0.9);
  }

  const xExpr = `max(0,min(${cx.toFixed(4)}*iw-iw/zoom/2,iw*(1-1/zoom)))`;
  const yExpr = `max(0,min(${cy.toFixed(4)}*ih-ih/zoom/2,ih*(1-1/zoom)))`;

  logger.info(`[generateRegionZoomClip] center=(${cx.toFixed(3)},${cy.toFixed(3)}), zoom ${startZ.toFixed(3)}→${endZ.toFixed(3)}`);

  const vf = [
    `scale=1200:-2:force_original_aspect_ratio=increase`,
    `zoompan=z='${startZ.toFixed(4)}+(${(endZ - startZ).toFixed(4)})*on/${totalFrames}'` +
    `:x='${xExpr}'` +
    `:y='${yExpr}'` +
    `:d=${totalFrames}:s=1080x1920:fps=${FPS}`,
    `setsar=1`,
  ].join(',');

  return new Promise((resolve, reject) => {
    createFfmpeg()
      .input(imagePath)
      .outputOptions([
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-an',
      ])
      .output(outputPath)
      .on('end', () => { logger.info(`[generateRegionZoomClip] DONE — ${path.basename(outputPath)}`); resolve(); })
      .on('error', (err) => {
        logger.error(`[generateRegionZoomClip] ERROR — ${path.basename(outputPath)}: ${err.message}`);
        reject(err);
      })
      .run();
  });
}

// ─── Best-region selector ────────────────────────────────────────────────────

/**
 * Pick the single best focus region for a clip.
 *
 * Strategy (in order):
 *  1. If any region label contains a keyword from the segment words, prefer it.
 *  2. Among face/expression/close-up regions, pick the first.
 *  3. Fall back to regions[0] — Gemini already orders by visual priority (face first).
 *
 * This means the camera always stays on ONE subject that matches what is being
 * narrated, instead of jumping between multiple parts of the page.
 */
function pickBestRegion(regions, segmentWords) {
  if (!regions || regions.length === 0) return { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  if (regions.length === 1) return regions[0];

  // Build a set of meaningful words from the narration for this clip
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'is', 'was', 'it', 'he', 'she', 'they', 'his', 'her', 'with', 'that', 'this', 'for', 'as', 'be', 'are', 'were', 'has', 'have', 'had', 'not', 'from']);
  const keywords = (segmentWords || [])
    .map(w => w.word?.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(w => w && w.length > 3 && !stopWords.has(w));

  if (keywords.length > 0) {
    for (const region of regions) {
      const label = (region.label || '').toLowerCase();
      if (keywords.some(kw => label.includes(kw))) {
        logger.info(`[pickBestRegion] Keyword match: "${region.label}" matched narration keywords`);
        return region;
      }
    }
  }

  // Prefer a face/expression region if one exists
  const faceRegion = regions.find(r => {
    const l = (r.label || '').toLowerCase();
    return l.includes('face') || l.includes('expression') || l.includes('eye') || l.includes('close');
  });
  if (faceRegion) {
    logger.info(`[pickBestRegion] Face region selected: "${faceRegion.label}"`);
    return faceRegion;
  }

  // Default: Gemini's first region (highest priority — already sorted face > action > background)
  logger.info(`[pickBestRegion] Using Gemini priority region[0]: "${regions[0].label}"`);
  return regions[0];
}

/**
 * Generate a single cinematic zoom clip for a focus region.
 * Always uses ONE region — no multi-shot cuts that cause jarring side-to-side jumps.
 */
async function generateFocusClip(imagePath, regions, totalDuration, outputPath, mood, segmentWords) {
  logger.info(`[generateFocusClip] START — ${path.basename(imagePath)}, ${regions?.length ?? 0} regions available, duration: ${totalDuration.toFixed(2)}s, mood: ${mood}`);

  const region = pickBestRegion(regions, segmentWords);
  logger.info(`[generateFocusClip] Selected region: x=${region.x.toFixed(2)} y=${region.y.toFixed(2)} w=${region.w.toFixed(2)} h=${region.h.toFixed(2)} label="${region.label || ''}"`);

  return generateRegionZoomClip(imagePath, region, totalDuration, outputPath, moodZoomStyle(mood));
}

// ─── Legacy fallback: generic Ken Burns for panels without focus data ─────────

function kenBurnsFilter(duration, patternIndex) {
  const totalFrames = Math.max(2, Math.round(Math.max(0.5, duration) * FPS));
  const patterns = [
    // 0: gentle zoom in, full width visible
    `scale=1200:-2:force_original_aspect_ratio=increase,zoompan=z='1.0+0.15*on/${totalFrames}':x='max(0,iw/2-iw/zoom/2)':y='max(0,ih/2-ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=${FPS},setsar=1`,
    // 1: slow scroll top to bottom
    `scale=1200:-2:force_original_aspect_ratio=increase,zoompan=z='1.05':x='max(0,iw/2-iw/zoom/2)':y='min(on/${totalFrames}*(ih-ih/zoom),ih-ih/zoom)':d=${totalFrames}:s=1080x1920:fps=${FPS},setsar=1`,
    // 2: gentle zoom out from center
    `scale=1200:-2:force_original_aspect_ratio=increase,zoompan=z='1.15-0.15*on/${totalFrames}':x='max(0,iw/2-iw/zoom/2)':y='max(0,ih/2-ih/zoom/2)':d=${totalFrames}:s=1080x1920:fps=${FPS},setsar=1`,
    // 3: scroll top to bottom with slight zoom
    `scale=1200:-2:force_original_aspect_ratio=increase,zoompan=z='1.1':x='max(0,iw/2-iw/zoom/2)':y='min(on/${totalFrames}*(ih-ih/zoom),ih-ih/zoom)':d=${totalFrames}:s=1080x1920:fps=${FPS},setsar=1`,
  ];
  return patterns[patternIndex % patterns.length];
}

function generateFallbackClip(panelPath, duration, outputPath, mood) {
  const patternMap = { action: 0, horror: 0, suspense: 1, reveal: 1, emotional: 2, calm: 2, comedic: 3, dramatic: 0 };
  const idx = patternMap[(mood || '').toLowerCase()] ?? 0;
  const totalFrames = Math.max(2, Math.round(Math.max(0.5, duration) * FPS));
  logger.info(`[generateFallbackClip] START — ${path.basename(panelPath)}, duration: ${duration.toFixed(2)}s, pattern: ${idx}`);
  return new Promise((resolve, reject) => {
    createFfmpeg()
      .input(panelPath)
      .outputOptions([
        '-vf', kenBurnsFilter(duration, idx),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an',
      ])
      .output(outputPath)
      .on('end', () => { logger.info(`[generateFallbackClip] DONE — ${path.basename(outputPath)}`); resolve(); })
      .on('error', (err) => { logger.error(`[generateFallbackClip] ERROR — ${path.basename(outputPath)}: ${err.message}`); reject(err); })
      .run();
  });
}

// ─── Merged final encode pass ─────────────────────────────────────────────────

/**
 * Single ffmpeg command: concat clips + audio mix + subtitle burn → final.mp4
 * Uses GPU (NVENC) if available for the final encode.
 */
async function renderFinalPass(concatFile, audioPath, musicTrack, subtitlePath, finalPath, preset, onProgress) {
  const fcParts = [];
  let videoMapArg = '0:v';

  // Subtitle burn (in filter_complex for compatibility with audio filter_complex)
  if (subtitlePath && await fileExists(subtitlePath)) {
    const escapedSubPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    fcParts.push(
      `[0:v]subtitles='${escapedSubPath}':force_style='FontName=Arial,FontSize=68,Bold=1,PrimaryColour=&H00FFFFFF,SecondaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,Outline=5,Shadow=2,Alignment=2,MarginV=120'[vout]`
    );
    videoMapArg = '[vout]';
  }

  // Audio mix filters
  let audioInputIdx = 1;
  let audioMapArg = null;

  if (audioPath && musicTrack) {
    fcParts.push(`[${audioInputIdx}:a]aformat=channel_layouts=stereo,volume=1.0[narr]`);
    fcParts.push(`[${audioInputIdx + 1}:a]aformat=channel_layouts=stereo,volume=0.15[music]`);
    fcParts.push(`[narr][music]amix=inputs=2:duration=first:dropout_transition=3[aout]`);
    audioMapArg = '[aout]';
  } else if (audioPath) {
    fcParts.push(`[${audioInputIdx}:a]aformat=channel_layouts=stereo,volume=1.0[aout]`);
    audioMapArg = '[aout]';
  } else if (musicTrack) {
    fcParts.push(`[${audioInputIdx}:a]aformat=channel_layouts=stereo,volume=0.15[aout]`);
    audioMapArg = '[aout]';
  }

  const cmd = createFfmpeg()
    .input(concatFile)
    .inputOptions(['-f', 'concat', '-safe', '0']);

  if (audioPath) cmd.input(audioPath);
  if (musicTrack) cmd.input(musicTrack);

  if (fcParts.length > 0) cmd.complexFilter(fcParts);

  const outputOpts = [
    '-map', videoMapArg,
    ...getEncodingOptions(preset),
    '-shortest',
  ];

  if (audioMapArg) {
    outputOpts.push('-map', audioMapArg, '-c:a', 'aac', '-b:a', '192k');
  }

  cmd.outputOptions(outputOpts).output(finalPath);

  return new Promise((resolve, reject) => {
    cmd
      .on('progress', p => onProgress(`Encoding final video... ${(p.percent || 0).toFixed(0)}%`, 75 + (p.percent || 0) * 0.2))
      .on('end', () => { logger.info('[renderVideo] Final encode DONE'); resolve(); })
      .on('error', (err) => { logger.error(`[renderVideo] Final encode ERROR: ${err.message}`); reject(err); })
      .run();
  });
}

// ─── Main render pipeline ───────────────────────────────────────────────────

/**
 * Render the final video for a project.
 *
 * @param {string} projectId
 * @param {Function} onProgress
 * @param {{ duration?: number, detail?: string, format?: string }} renderConfig
 */
export async function renderVideo(projectId, onProgress = () => { }, renderConfig = {}) {
  logger.info(`[renderVideo] START — project: ${projectId}, config: ${JSON.stringify(renderConfig)}`);

  const outputDir = projectPath(projectId, 'output');
  await ensureDir(outputDir);

  const targetDuration = renderConfig.duration || null;
  const detail = renderConfig.detail || 'manga';
  const format = renderConfig.format || 'manga';
  const preset = getDetailPreset(detail);
  logger.info(`[renderVideo] ═══════════════════════════════════════════════`);
  logger.info(`[renderVideo] FORMAT: ${format.toUpperCase()} ${format === 'webtoon' ? '(scroll camera active)' : '(zoom-crop camera active)'}`);
  logger.info(`[renderVideo] detail: ${detail}, targetDuration: ${targetDuration ?? 'auto (narration length)'}`);
  logger.info(`[renderVideo] ═══════════════════════════════════════════════`);

  // Load required data
  onProgress('Loading project data...', 5);
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  if (!script?.segments?.length) throw new Error('No script found');
  logger.info(`[renderVideo] Script loaded — ${script.segments.length} segments`);

  const panelImages = await listImages(projectPath(projectId, 'panels'));
  if (!panelImages.length) throw new Error('No panels found');
  logger.info(`[renderVideo] Found ${panelImages.length} panel image(s)`);

  // Check for narration audio
  const narrationPath = projectPath(projectId, 'audio', 'narration.mp3');
  const uploadedPath = projectPath(projectId, 'audio', 'narration-uploaded.mp3');
  let audioPath = null;

  if (await fileExists(narrationPath)) audioPath = narrationPath;
  else if (await fileExists(uploadedPath)) audioPath = uploadedPath;

  // Get timestamps
  onProgress('Processing timestamps...', 10);
  let timestamps = await safeReadJson(projectPath(projectId, 'audio', 'timestamps.json'));
  if (!timestamps && audioPath) {
    timestamps = await extractTimestamps(projectId, audioPath, (msg, pct) => {
      onProgress(msg, 10 + pct * 0.1);
    });
  }
  const words = timestamps?.words || [];
  const segmentBoundaries = timestamps?.segmentBoundaries || null;
  const audioDuration = audioPath ? await getAudioDuration(audioPath) : null;
  logger.info(`[renderVideo] Timestamps: ${words.length} words, audioDuration: ${audioDuration?.toFixed(2) ?? 'N/A'}s`);

  // AI Camera Direction: detect focus regions on chapter pages
  onProgress('AI Camera Direction — detecting focus regions...', 20);
  let focusRegions = {};
  try {
    focusRegions = await detectFocusRegions(projectId, (msg, pct) => {
      onProgress(msg, 20 + pct * 0.05);
    }, format);
  } catch (err) {
    logger.warn(`Focus detection skipped: ${err.message}`);
  }
  const hasFocusData = Object.keys(focusRegions).length > 0;
  logger.flow(`Focus regions: ${Object.keys(focusRegions).length} pages, hasFocusData=${hasFocusData}`);

  // Build timeline
  onProgress('Building timeline...', 27);
  const timeline = buildTimeline(script.segments, panelImages, words, targetDuration, segmentBoundaries, audioDuration);
  await safeWriteJson(projectPath(projectId, 'timeline.json'), timeline);
  logger.info(`[renderVideo] Timeline built — ${timeline.length} entries`);

  if (timeline.length === 0) throw new Error('Timeline is empty');

  // Select background music
  onProgress('Selecting music...', 30);
  const musicTrack = await selectMusicTrack(script.segments);
  logger.info(`[renderVideo] Music track: ${musicTrack ?? 'none'}`);

  // Generate camera clips in parallel
  onProgress('Generating camera shots...', 35);
  logger.info(`[renderVideo] Generating ${timeline.length} camera clip(s) in parallel...`);

  const concurrency = Math.max(2, os.cpus().length - 2);
  logger.info(`[renderVideo] Parallel clip concurrency: ${concurrency} (${os.cpus().length} CPUs)`);

  let done = 0;

  const clipResults = await parallelMap(timeline, async (entry, i) => {
    const clipDuration = entry.endTime - entry.startTime;

    if (clipDuration <= 0) {
      logger.warn(`[renderVideo] Clip ${i + 1} has zero/negative duration (${clipDuration}), skipping`);
      return null;
    }

    const clipPath = path.join(outputDir, `cam-${i}.mp4`);

    try {
      const pageFile = entry.pageFile;
      // Strip _panel_NNN suffix to recover the chapter page key used in focusRegions
      const pageKey = pageFile ? pageFile.replace(/_panel_\d+(\.[^.]+)$/, '$1') : null;
      const pageFocus = pageKey ? focusRegions[pageKey] : null;
      const pagePath = pageKey ? projectPath(projectId, 'chapters', pageKey) : null;
      const pageExists = pagePath ? await fileExists(pagePath) : false;

      logger.info(`[renderVideo] Clip ${i + 1} — pageKey: ${pageKey ?? 'none'}, hasFocus: ${!!(pageFocus)}, isWebtoon: ${!!(pageFocus?.isWebtoon)}, pageExists: ${pageExists}`);

      if (pageFocus?.isWebtoon && pageExists) {
        // ── Webtoon scroll clip ──────────────────────────────────────────────
        logger.info(`[renderVideo] Clip ${i + 1} — WEBTOON MODE`);
        logger.info(`[renderVideo] Clip ${i + 1} — page: ${pageKey}, duration: ${clipDuration.toFixed(2)}s, mood: ${entry.mood}`);
        logger.info(`[renderVideo] Clip ${i + 1} — cached interest points: ${pageFocus.regions?.length ?? 0}`);
        if (pageFocus.regions?.length > 0) {
          pageFocus.regions.forEach((p, ri) =>
            logger.info(`[renderVideo] Clip ${i + 1} — region[${ri}]: y=${p.y_center?.toFixed(3)} x=${p.x_center?.toFixed(3)} imp=${p.importance} zoom=${p.zoom} "${p.label}"`)
          );
        } else {
          logger.warn(`[renderVideo] Clip ${i + 1} — no cached interest points, will use default scroll`);
        }
        // Rebuild scroll path with actual clip duration (cache stores placeholder duration)
        logger.info(`[renderVideo] Clip ${i + 1} — rebuilding scroll path for actual duration ${clipDuration.toFixed(2)}s`);
        const scrollPath = buildScrollPath(pageFocus.regions?.length > 0 ? pageFocus.regions : null, clipDuration);
        logger.info(`[renderVideo] Clip ${i + 1} — scroll path: ${scrollPath.length} keyframe(s)`);
        scrollPath.forEach((kf, ki) =>
          logger.info(`[renderVideo] Clip ${i + 1} — kf[${ki}]: frame=${kf.frame} y=${kf.y?.toFixed(3)} x=${kf.x?.toFixed(3)} zoom=${kf.zoom?.toFixed(3)}`)
        );
        await renderScrollClip(pagePath, scrollPath, clipDuration, clipPath, entry.mood);
        logger.info(`[renderVideo] Clip ${i + 1} — webtoon scroll DONE → ${path.basename(clipPath)}`);
      } else if (hasFocusData && pageFocus && pageFocus.regions?.length > 0 && pageExists) {
        // ── AI focus clip — single best region, no jarring multi-shot cuts ──
        logger.info(`[renderVideo] Clip ${i + 1} using AI focus (${pageFocus.regions.length} candidate regions, picking best)`);
        await generateFocusClip(
          pagePath, pageFocus.regions, clipDuration, clipPath,
          entry.mood, entry.words
        );
        logger.info(`[renderVideo] Clip ${i + 1} focus clip DONE`);
      } else {
        // ── Ken Burns fallback ───────────────────────────────────────────────
        logger.info(`[renderVideo] Clip ${i + 1} using fallback Ken Burns zoom`);
        await generateFallbackClip(entry.panelPath, clipDuration, clipPath, entry.mood);
        logger.info(`[renderVideo] Clip ${i + 1} fallback DONE`);
      }
    } catch (err) {
      logger.error(`[renderVideo] Camera clip ${i + 1} FAILED: ${err.message}`);
      throw err;
    }

    done++;
    onProgress(`Camera shots ${done}/${timeline.length}...`, 35 + Math.round((done / timeline.length) * 25));
    return clipPath;
  }, concurrency);

  const cameraClips = clipResults.filter(Boolean);
  logger.info(`[renderVideo] All ${cameraClips.length} camera clip(s) generated`);

  if (cameraClips.length === 0) throw new Error('No camera clips generated');

  // Build concat list (duplicate last clip to pad for audio tail)
  const concatLines = cameraClips.map(p => `file '${p.replace(/\\/g, '/')}'`);
  concatLines.push(`file '${cameraClips[cameraClips.length - 1].replace(/\\/g, '/')}'`);

  const concatFile = path.join(outputDir, 'concat.txt');
  await fs.writeFile(concatFile, concatLines.join('\n'));

  const finalPath = path.join(outputDir, 'final.mp4');

  // Generate subtitles
  onProgress('Generating subtitles...', 62);
  let subtitlePath = null;
  try {
    subtitlePath = await generateProjectSubtitles(projectId, timestamps);
    logger.info(`[renderVideo] Subtitle file: ${subtitlePath ?? 'none'}`);
  } catch (err) {
    logger.warn(`Subtitle generation failed: ${err.message}`);
  }

  // Merged final pass: concat + audio mix + subtitle burn + GPU encode (1 ffmpeg command)
  onProgress('Encoding final video...', 65);
  logger.info(`[renderVideo] Starting merged final pass (concat + audio + subtitles)...`);

  try {
    await renderFinalPass(concatFile, audioPath, musicTrack, subtitlePath, finalPath, preset, onProgress);
  } catch (err) {
    // If subtitle caused failure, retry without subtitle
    if (subtitlePath) {
      logger.warn(`[renderVideo] Final pass failed (${err.message}), retrying without subtitles`);
      await renderFinalPass(concatFile, audioPath, musicTrack, null, finalPath, preset, onProgress);
    } else {
      throw err;
    }
  }

  // Cleanup temp files
  logger.info(`[renderVideo] Cleaning up temp files...`);
  try { await fs.unlink(concatFile); } catch { }
  for (const clip of cameraClips) { try { await fs.unlink(clip); } catch { } }

  onProgress('Video render complete!', 100);
  logger.flow(`Video rendered: ${finalPath} [detail=${detail}, format=${format}, focusRegions=${hasFocusData}, subtitles=${!!subtitlePath}]`);
  logger.info(`[renderVideo] DONE — ${finalPath}`);
  return finalPath;
}
