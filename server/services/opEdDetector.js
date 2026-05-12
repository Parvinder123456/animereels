/**
 * OP / ED detection for a stitched multi-episode source.
 *
 * Strategy: for each expected episode boundary, extract a 90-sec audio
 * sample at the start (candidate OP) and a 90-sec sample at the end
 * (candidate ED). Send all N samples to a single Gemini Flash audio
 * call asking: "are these the same theme song? If yes, what's the actual
 * duration?". Returns timestamp windows to cut.
 *
 * If only one episode was uploaded, we skip detection entirely (no
 * repetition signal to anchor on).
 *
 * Costs ~2 free-tier Gemini calls per project regardless of episode count.
 */

import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ensureDir, projectPath, safeReadJson, safeWriteJson, fileExists } from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { getSettings } from '../utils/appSettings.js';
import { logger } from '../utils/logger.js';

// ─── Source-identity cache (same scheme as geminiVideoBreakdown.js) ──────────

async function sourceIdentity(sourcePath) {
  const stat = await fs.stat(sourcePath);
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function identityMatches(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Return a previously-saved OP/ED detection if it exists AND was produced
 * from the same source file (same size + mtime). Otherwise null.
 */
export async function loadCachedOpEd(projectId, sourcePath) {
  const cachedPath = projectPath(projectId, 'op-ed-cuts.json');
  if (!await fileExists(cachedPath)) return null;
  const cached = await safeReadJson(cachedPath);
  if (!cached || !cached.sourceIdentity) return null;
  const current = await sourceIdentity(sourcePath).catch(() => null);
  if (!identityMatches(cached.sourceIdentity, current)) return null;
  return cached;
}

const SAMPLE_SEC = 90; // length of each audio sample sent to Gemini
const MAX_SAMPLES = 8; // safety cap — won't send more than 8 samples per call

function extractSampleClip(srcPath, startSec, durationSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(Math.max(0, startSec))
      .duration(durationSec)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .audioChannels(1)
      .audioFrequency(16000)
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`OP/ED sample @${startSec}s failed: ${err.message}`)))
      .run();
  });
}

const DETECT_PROMPT = `
You are listening to N short audio samples extracted from a stitched anime episode bundle.
Each sample is from a candidate OPENING or ENDING theme location.

Decide whether the samples are the SAME piece of music (an anime OP or ED theme that
repeats once per episode).

Return ONLY this JSON — no prose, no code fence:

{
  "is_theme": <true if at least 3 of the samples are clearly the same song; false otherwise>,
  "match_indices": [<indices of samples that match, 0-based>],
  "theme_duration_sec": <if is_theme, your best estimate of the theme song's actual
                         duration in seconds (typically 60-95). 0 if not a theme.>
}

RULES:
- Be conservative: only set is_theme=true if multiple samples are unambiguously the same song.
- match_indices may be a subset (e.g. some episodes might have skipped the OP).
- Output ONLY the JSON object.
`.trim();

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in OP/ED detection response');
  return JSON.parse(raw);
}

async function detectAcrossSamples(samplePaths, kind /* 'OP'|'ED' */) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env (OP/ED detection)');

  const settings = await getSettings();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: settings.geminiModel,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });

  const parts = [`${DETECT_PROMPT}\n\nWe have ${samplePaths.length} candidate ${kind} samples, in order.`];
  for (const p of samplePaths) {
    const buf = await fs.readFile(p);
    parts.push({ inlineData: { data: buf.toString('base64'), mimeType: 'audio/mp3' } });
  }

  try {
    const result = await model.generateContent(parts);
    return extractJsonObject(result.response.text());
  } catch (err) {
    logger.warn(`[opEdDetector] ${kind} detection call failed: ${err.message}`);
    return { is_theme: false, match_indices: [], theme_duration_sec: 0 };
  }
}

/**
 * @param {string} projectId
 * @param {string} sourcePath  the stitched source.mp4
 * @param {Array<{idx:number, startSec:number, durationSec:number}>} episodes
 *        from videoStitcher's episodes.json
 * @returns {Promise<{opCuts:Array<{startSec:number,endSec:number}>, edCuts:Array<{startSec:number,endSec:number}>}>}
 */
export async function detectOpEd(projectId, sourcePath, episodes, onProgress = () => {}) {
  if (!episodes || episodes.length < 2) {
    logger.info('[opEdDetector] <2 episodes — skipping detection (no repetition signal)');
    return { opCuts: [], edCuts: [] };
  }

  const tmpDir = projectPath(projectId, '_oped_tmp');
  await ensureDir(tmpDir);

  // OP candidates — start of each episode
  const opPaths = [];
  const opStarts = [];
  for (let i = 0; i < Math.min(episodes.length, MAX_SAMPLES); i++) {
    const startSec = episodes[i].startSec;
    const outPath = path.join(tmpDir, `op_${i}.mp3`);
    onProgress(`Extracting OP candidate ${i + 1}/${episodes.length}`, 5 + Math.round((i / episodes.length) * 20));
    await extractSampleClip(sourcePath, startSec, SAMPLE_SEC, outPath);
    opPaths.push(outPath);
    opStarts.push(startSec);
  }

  onProgress('Detecting OP via Gemini Flash audio comparison...', 35);
  const opVerdict = await detectAcrossSamples(opPaths, 'OP');

  // ED candidates — last 95 sec of each episode
  const edPaths = [];
  const edStarts = [];
  for (let i = 0; i < Math.min(episodes.length, MAX_SAMPLES); i++) {
    const epEnd = episodes[i].startSec + episodes[i].durationSec;
    const startSec = Math.max(episodes[i].startSec, epEnd - SAMPLE_SEC - 5);
    const outPath = path.join(tmpDir, `ed_${i}.mp3`);
    onProgress(`Extracting ED candidate ${i + 1}/${episodes.length}`, 50 + Math.round((i / episodes.length) * 20));
    await extractSampleClip(sourcePath, startSec, SAMPLE_SEC, outPath);
    edPaths.push(outPath);
    edStarts.push(startSec);
  }

  onProgress('Detecting ED via Gemini Flash audio comparison...', 75);
  const edVerdict = await detectAcrossSamples(edPaths, 'ED');

  // Build cut windows from the verdicts.
  const opCuts = (opVerdict.is_theme && opVerdict.match_indices?.length)
    ? opVerdict.match_indices
        .filter(i => i < opStarts.length)
        .map(i => ({
          startSec: opStarts[i],
          endSec: opStarts[i] + (Number(opVerdict.theme_duration_sec) || SAMPLE_SEC),
        }))
    : [];

  const edCuts = (edVerdict.is_theme && edVerdict.match_indices?.length)
    ? edVerdict.match_indices
        .filter(i => i < edStarts.length)
        .map(i => ({
          startSec: edStarts[i],
          endSec: edStarts[i] + (Number(edVerdict.theme_duration_sec) || SAMPLE_SEC),
        }))
    : [];

  await safeWriteJson(projectPath(projectId, 'op-ed-cuts.json'), {
    opVerdict, edVerdict, opCuts, edCuts,
    sourceIdentity: await sourceIdentity(sourcePath).catch(() => null),
    cachedAt: new Date().toISOString(),
  });

  // Clean up audio samples — they're temporary.
  for (const p of [...opPaths, ...edPaths]) {
    try { await fs.unlink(p); } catch {}
  }
  try { await fs.rmdir(tmpDir); } catch {}

  onProgress(`OP/ED detect: ${opCuts.length} OP cuts, ${edCuts.length} ED cuts`, 100);
  logger.info(`[opEdDetector] OP cuts=${opCuts.length} ED cuts=${edCuts.length}`);
  return { opCuts, edCuts };
}

/**
 * Convenience: merge OP/ED cuts into a single sorted, non-overlapping
 * "skip list" the renderer + beat-clusterer can use to filter timestamps.
 */
export function mergeSkipWindows(opCuts, edCuts) {
  const all = [...opCuts, ...edCuts].sort((a, b) => a.startSec - b.startSec);
  const merged = [];
  for (const w of all) {
    const last = merged[merged.length - 1];
    if (last && w.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, w.endSec);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/** True if a timestamp falls inside any skip window. */
export function isInSkipWindow(skipWindows, sec) {
  for (const w of skipWindows) {
    if (sec >= w.startSec && sec < w.endSec) return true;
  }
  return false;
}
