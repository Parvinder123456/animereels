/**
 * Thumbnail generator for explainer projects.
 *
 * Strategy:
 *   1. Pick the highest-importance scene from the scene plan.
 *   2. Extract its mid-frame from source.mp4 at the target aspect ratio.
 *   3. Ask Gemini Flash (vision) to suggest a 4-7 word headline and a
 *      placement region (top-left | top-right | bottom-left | bottom-right
 *      | center) that avoids covering the subject.
 *   4. Overlay the headline as bold drawtext at the suggested position.
 *
 * Output: data/projects/<id>/output/thumbnail.jpg
 *
 * Cached at title-pack-level: regenerate when title pack is regenerated.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  ensureDir, safeReadJson, safeWriteJson, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { getSettings } from '../utils/appSettings.js';
import { logger } from '../utils/logger.js';

const ASPECTS = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1':  { width: 1080, height: 1080 },
};

const PLACEMENT_COORDS = {
  'top-left':     { x: '40',                    y: '40' },
  'top-right':    { x: 'w-tw-40',               y: '40' },
  'bottom-left':  { x: '40',                    y: 'h-th-40' },
  'bottom-right': { x: 'w-tw-40',               y: 'h-th-40' },
  'center':       { x: '(w-tw)/2',              y: '(h-th)/2' },
};

const WIN_FONT = 'C\\:/Windows/Fonts/arialbd.ttf';
const NIX_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '’')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

function extractFrame(srcPath, atSec, outPath, dims) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(Math.max(0, atSec))
      .frames(1)
      .outputOptions([
        '-vf',
        `scale=w=${dims.width}:h=${dims.height}:force_original_aspect_ratio=increase,` +
        `crop=${dims.width}:${dims.height},setsar=1`,
        '-q:v', '2',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Frame extract failed: ${err.message}`)))
      .run();
  });
}

const PLACEMENT_PROMPT = `
You are designing a YouTube thumbnail. I will show you a frame from the
video and tell you the video's working title. Decide:

1. headline — a 3-7 word punchy text overlay that promises value. ALL CAPS
   format, max 32 chars total. Should NOT be the working title — make it a
   curiosity hook.
2. placement — where to put the headline so it doesn't cover the main
   subject. One of: "top-left" | "top-right" | "bottom-left" |
   "bottom-right" | "center".
3. accentColor — a color name from this list that pops against the
   background: "yellow" | "red" | "white" | "cyan" | "orange".

Return ONLY this JSON, no prose:

{ "headline": "...", "placement": "...", "accentColor": "..." }
`.trim();

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in thumbnail-placement response');
  return JSON.parse(raw);
}

async function askGeminiForPlacement(framePath, workingTitle) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const settings = await getSettings();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: settings.geminiModel,
    generationConfig: { temperature: 0.7, responseMimeType: 'application/json' },
  });

  const buf = fs.readFileSync(framePath);
  const result = await model.generateContent([
    `${PLACEMENT_PROMPT}\n\nWORKING TITLE: ${workingTitle}`,
    { inlineData: { data: buf.toString('base64'), mimeType: 'image/jpeg' } },
  ]);
  return extractJsonObject(result.response.text());
}

function colorHex(name) {
  const m = {
    yellow: 'yellow', red: 'red', white: 'white',
    cyan: 'cyan', orange: 'orange',
  };
  return m[name] || 'yellow';
}

function applyTextOverlay(framePath, outPath, { headline, placement, accentColor }, dims) {
  const font = process.platform === 'win32' ? WIN_FONT : NIX_FONT;
  const pos = PLACEMENT_COORDS[placement] || PLACEMENT_COORDS['bottom-left'];
  const color = colorHex(accentColor);
  const fontSize = Math.max(56, Math.floor(dims.width / 18));
  const text = escapeDrawtext(headline.toUpperCase().slice(0, 40));

  const drawtext =
    `drawtext=fontfile='${font}':text='${text}':` +
    `x=${pos.x}:y=${pos.y}:` +
    `fontsize=${fontSize}:fontcolor=${color}:` +
    `borderw=6:bordercolor=black:` +
    `box=1:boxcolor=black@0.55:boxborderw=18`;

  return new Promise((resolve, reject) => {
    ffmpeg(framePath)
      .setFfmpegPath(getFfmpegPath())
      .outputOptions(['-vf', drawtext, '-q:v', '2', '-frames:v', '1'])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Thumbnail overlay failed: ${err.message}`)))
      .run();
  });
}

function pickBestScene(scenes) {
  if (!scenes?.length) return null;
  const candidates = scenes.filter(s => s.type !== 'transition' && s.type !== 'intro_outro');
  const pool = candidates.length ? candidates : scenes;
  return pool.reduce((max, s) => (s.importance || 0) > (max?.importance || 0) ? s : max, pool[0]);
}

/**
 * @param {string} projectId
 * @param {{aspect?: 'auto'|'16:9'|'9:16'|'1:1', force?: boolean}} opts
 */
export async function generateThumbnail(projectId, { aspect = 'auto', force = false } = {}) {
  const sourcePath = projectPath(projectId, 'source.mp4');
  if (!await fileExists(sourcePath)) throw new Error('Source video missing');

  const project = await safeReadJson(projectPath(projectId, 'project.json'));
  const planEnv = await safeReadJson(projectPath(projectId, 'scene-plan.json'));
  const scenes = planEnv?.scenes || [];
  if (!scenes.length) throw new Error('No scene plan — run analysis first');

  const titlePack = await safeReadJson(projectPath(projectId, 'title-pack.json'));
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  const workingTitle = titlePack?.titles?.[0] || script?.title || project?.name || 'Video';

  const resolvedAspect = aspect === 'auto' ? (project?.config?.aspect || '16:9') : aspect;
  const dims = ASPECTS[resolvedAspect] || ASPECTS['16:9'];

  const outputDir = projectPath(projectId, 'output');
  await ensureDir(outputDir);
  const thumbPath = path.join(outputDir, 'thumbnail.jpg');
  const metaPath  = path.join(outputDir, 'thumbnail.json');

  if (!force && await fileExists(thumbPath)) {
    const meta = await safeReadJson(metaPath);
    if (meta && meta.aspect === resolvedAspect && meta.workingTitle === workingTitle) {
      return { path: thumbPath, ...meta, cached: true };
    }
  }

  const best = pickBestScene(scenes);
  const atSec = (best.startSec + best.endSec) / 2;
  const rawFramePath = path.join(outputDir, '_thumb_raw.jpg');
  await extractFrame(sourcePath, atSec, rawFramePath, dims);

  let placement;
  try {
    placement = await askGeminiForPlacement(rawFramePath, workingTitle);
  } catch (err) {
    logger.warn(`[thumbnailGenerator] Gemini placement failed: ${err.message} — fallback to default`);
    placement = {
      headline: (workingTitle || 'WATCH NOW').toUpperCase().slice(0, 32),
      placement: 'bottom-left',
      accentColor: 'yellow',
    };
  }

  await applyTextOverlay(rawFramePath, thumbPath, placement, dims);
  try { await fsp.unlink(rawFramePath); } catch {}

  const meta = {
    aspect: resolvedAspect,
    workingTitle,
    sourceScene: best.idx,
    sourceTimeSec: atSec,
    placement,
    generatedAt: new Date().toISOString(),
  };
  await safeWriteJson(metaPath, meta);
  logger.info(
    `[thumbnailGenerator] ${resolvedAspect} thumbnail from scene ${best.idx} @ ${atSec.toFixed(1)}s, ` +
    `headline="${placement.headline}" pos=${placement.placement}`
  );
  return { path: thumbPath, ...meta, cached: false };
}
