/**
 * Gemini Flash multimodal scene breakdown.
 *
 * Sends the stitched source video (chunked) through Gemini's native
 * video+audio understanding (Files API) and gets back a scene plan
 * anchored to ACTUAL visual cuts, with per-scene visual + dialogue
 * context. This replaces the old "Whisper dialogue segments → cluster
 * by dialogue gaps" approach where the cuts were never visually informed.
 *
 * Output (data/projects/<id>/scene-plan.json):
 *   {
 *     totalSec, chunkCount,
 *     scenes: [
 *       { startSec, endSec, type, importance, mood,
 *         visualDescription, dialogueGist, dialogueVerbatim, characters }
 *     ]
 *   }
 *
 * Costs ~1 Gemini Flash call per 18-min chunk. For 120 min of source =
 * 7 calls, comfortably within free tier when paced.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  ensureDir, projectPath, safeReadJson, safeWriteJson, fileExists,
} from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { getSettings } from '../utils/appSettings.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'visual-scene-breakdown.v1.md');
const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com';

const CHUNK_SEC = 18 * 60;            // 18-min chunks — same as Whisper chunking
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 200;        // ~10 minutes per upload, enough for ~1 GB chunks
const MIN_SCENE_SEC = 3;
const TOKEN_PACING_MS = 5_000;        // breathe between Gemini calls to stay under free-tier RPM

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadPrompt() {
  try { return await fsp.readFile(PROMPT_PATH, 'utf-8'); }
  catch { return 'Break the video into visually-anchored scenes. Return JSON {chunkStartSec, scenes:[...]}.'; }
}

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in Gemini scene-breakdown response');
  return JSON.parse(raw);
}

function planChunks(totalSec) {
  const out = [];
  let cursor = 0;
  while (cursor < totalSec) {
    const dur = Math.min(CHUNK_SEC, totalSec - cursor);
    out.push({ startSec: cursor, durationSec: dur });
    cursor += dur;
  }
  return out;
}

function extractChunkVideo(srcPath, startSec, durationSec, outPath) {
  // Keep both video + audio; Gemini multimodal needs both. Re-encode lightly
  // to a downsized stream so the Files API upload stays sub-GB even for
  // long anime — Gemini is happy with low spatial resolution (it samples at
  // ~1 fps anyway for video understanding).
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(startSec)
      .duration(durationSec)
      .outputOptions([
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-vf', 'scale=640:-2,fps=2',  // small + 2 fps is plenty for scene understanding
        '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '16000',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Chunk extract @${startSec}s: ${err.message}`)))
      .run();
  });
}

// ─── Gemini Files API ────────────────────────────────────────────────────────

async function uploadToFiles(apiKey, filePath, mimeType) {
  const bytes = fs.readFileSync(filePath);
  const len = bytes.length;
  const displayName = path.basename(filePath);

  const startRes = await fetch(
    `${GEMINI_FILES_BASE}/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(len),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { displayName } }),
    }
  );
  if (!startRes.ok) throw new Error(`Files API start ${startRes.status}: ${(await startRes.text()).slice(0, 300)}`);

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API did not return upload URL');

  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(len),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });
  if (!upRes.ok) throw new Error(`Files API upload ${upRes.status}: ${(await upRes.text()).slice(0, 300)}`);

  let fileInfo = (await upRes.json()).file;
  for (let i = 0; i < MAX_POLL_ATTEMPTS && fileInfo.state === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await fetch(`${GEMINI_FILES_BASE}/v1beta/${fileInfo.name}?key=${apiKey}`);
    if (!poll.ok) throw new Error(`Files API poll ${poll.status}`);
    fileInfo = await poll.json();
  }
  if (fileInfo.state !== 'ACTIVE') throw new Error(`Files API state ${fileInfo.state} for ${displayName}`);
  return fileInfo;
}

async function deleteFromFiles(apiKey, name) {
  try { await fetch(`${GEMINI_FILES_BASE}/v1beta/${name}?key=${apiKey}`, { method: 'DELETE' }); }
  catch {}
}

// ─── Per-chunk analysis ──────────────────────────────────────────────────────

async function analyzeChunk(model, fileInfo, chunkStartSec, chunkDurSec, promptTemplate) {
  const metaBlock =
    `chunkStartSec: ${chunkStartSec}\nchunkDurationSec: ${chunkDurSec}\n` +
    `NOTE: All "startSec" and "endSec" in your output must be RELATIVE TO THIS CHUNK ` +
    `(starting at 0), NOT absolute timestamps. The downstream pipeline will add the chunk offset.`;

  const result = await retry(
    () => model.generateContent([
      promptTemplate + '\n\n' + metaBlock,
      { fileData: { mimeType: fileInfo.mimeType, fileUri: fileInfo.uri } },
    ]),
    { maxAttempts: 2, label: `breakdown-chunk-at-${chunkStartSec}s` }
  );

  return extractJsonObject(result.response.text());
}

function normalizeScene(s, chunkStartSec, fallbackIdx) {
  const relStart = Math.max(0, Number(s.startSec) || 0);
  const relEnd   = Math.max(relStart + MIN_SCENE_SEC, Number(s.endSec) || (relStart + MIN_SCENE_SEC));
  return {
    idx: fallbackIdx,
    startSec: relStart + chunkStartSec,
    endSec:   relEnd   + chunkStartSec,
    type: String(s.type || 'dialogue').toLowerCase(),
    importance: clampInt(s.importance, 1, 5, 3),
    mood: String(s.mood || 'calm').toLowerCase(),
    visualDescription: String(s.visualDescription || '').trim(),
    dialogueGist: String(s.dialogueGist || '').trim(),
    dialogueVerbatim: String(s.dialogueVerbatim || '').trim(),
    characters: Array.isArray(s.characters) ? s.characters.map(String) : [],
  };
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ─── Source-identity cache ───────────────────────────────────────────────────
//
// The breakdown step costs the most (Gemini Files API upload + multimodal
// analysis × N chunks). Re-running with the same source.mp4 but a different
// target duration shouldn't pay for the breakdown again. We tag the saved
// scene-plan.json with the source file's mtime + size, then short-circuit on
// re-run when both still match.

async function sourceIdentity(sourcePath) {
  const stat = await fsp.stat(sourcePath);
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function identityMatches(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Return a previously-saved scene plan if it exists AND was produced from
 * the same source file (same size + mtime). Otherwise null.
 */
export async function loadCachedPlan(projectId, sourcePath) {
  const planPath = projectPath(projectId, 'scene-plan.json');
  if (!await fileExists(planPath)) return null;
  const plan = await safeReadJson(planPath);
  if (!plan?.scenes?.length || !plan.sourceIdentity) return null;
  const current = await sourceIdentity(sourcePath).catch(() => null);
  if (!identityMatches(plan.sourceIdentity, current)) return null;
  return plan;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * @param {string} projectId
 * @param {string} sourcePath   stitched source.mp4
 * @param {number} totalSec     ffprobed total duration
 * @param {Array<{startSec:number,endSec:number}>} skipWindows  OP/ED to drop
 * @param {(msg:string,pct:number)=>void} onProgress
 */
export async function breakDownVideo(projectId, sourcePath, totalSec, skipWindows = [], onProgress = () => {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');

  const settings = await getSettings();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: settings.geminiModel,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  });

  const promptTemplate = await loadPrompt();
  const chunks = planChunks(totalSec);
  logger.info(`[geminiVideoBreakdown] ${(totalSec / 60).toFixed(1)} min → ${chunks.length} chunks of ${CHUNK_SEC / 60} min`);

  const tmpDir = projectPath(projectId, '_breakdown_tmp');
  await ensureDir(tmpDir);

  const allScenes = [];
  let sceneIdx = 0;

  for (let i = 0; i < chunks.length; i++) {
    const { startSec, durationSec } = chunks[i];
    onProgress(`Extracting chunk ${i + 1}/${chunks.length} for visual analysis...`, Math.round((i / chunks.length) * 8));
    const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(2, '0')}.mp4`);
    await extractChunkVideo(sourcePath, startSec, durationSec, chunkPath);

    onProgress(`Uploading chunk ${i + 1}/${chunks.length} to Gemini Files API...`, 8 + Math.round((i / chunks.length) * 30));
    let fileInfo;
    try {
      fileInfo = await uploadToFiles(apiKey, chunkPath, 'video/mp4');
    } catch (err) {
      logger.error(`[geminiVideoBreakdown] upload failed for chunk ${i + 1}: ${err.message}`);
      try { await fsp.unlink(chunkPath); } catch {}
      continue; // skip this chunk; the rest can still produce a plan
    }

    onProgress(`Gemini analyzing chunk ${i + 1}/${chunks.length} (visual + audio)...`, 38 + Math.round((i / chunks.length) * 55));
    let parsed;
    try {
      parsed = await analyzeChunk(model, fileInfo, startSec, durationSec, promptTemplate);
    } catch (err) {
      logger.error(`[geminiVideoBreakdown] analyze failed for chunk ${i + 1}: ${err.message}`);
      parsed = { scenes: [] };
    }

    await deleteFromFiles(apiKey, fileInfo.name);
    try { await fsp.unlink(chunkPath); } catch {}

    const scenes = (parsed.scenes || [])
      .map(s => normalizeScene(s, startSec, sceneIdx++))
      .filter(s => s.endSec - s.startSec >= MIN_SCENE_SEC);
    allScenes.push(...scenes);
    logger.info(`[geminiVideoBreakdown] chunk ${i + 1}/${chunks.length}: ${scenes.length} scenes`);

    // Pace the calls so free-tier RPM (typ. 10 RPM on Flash) isn't tripped.
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, TOKEN_PACING_MS));
  }

  try { await fsp.rmdir(tmpDir); } catch {}

  // Filter out scenes overlapping skip windows (OP/ED).
  const isInSkip = (sec) => skipWindows.some(w => sec >= w.startSec && sec < w.endSec);
  const filteredScenes = allScenes
    .filter(s => s.type !== 'intro_outro')
    .filter(s => !isInSkip((s.startSec + s.endSec) / 2));

  // Renumber after filtering.
  filteredScenes.forEach((s, i) => { s.idx = i; });

  const plan = {
    totalSec,
    chunkCount: chunks.length,
    rawSceneCount: allScenes.length,
    sceneCount: filteredScenes.length,
    scenes: filteredScenes,
    sourceIdentity: await sourceIdentity(sourcePath).catch(() => null),
    cachedAt: new Date().toISOString(),
  };
  await safeWriteJson(projectPath(projectId, 'scene-plan.json'), plan);

  onProgress(`Visual breakdown complete: ${filteredScenes.length} scenes`, 100);
  logger.info(`[geminiVideoBreakdown] kept ${filteredScenes.length}/${allScenes.length} scenes after skip filter`);
  return plan;
}
