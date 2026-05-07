/**
 * Video analyzer (cheap path): score each detected scene by importance
 * using batched frame analysis through the existing visionQueryBatch
 * router (Gemini / Groq / Ollama).
 *
 * Produces an array parallel to `scenes`, with importance / type / summary
 * for each scene that the moment selector can rank.
 *
 * Phase 2 will add a Gemini Files-API path for true video understanding;
 * this file is the frame-grid baseline.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { visionQueryBatch } from '../utils/visionClient.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'video-scene-analysis.v1.md');

const BATCH_SIZE = 8;

async function getPrompt() {
  try {
    return await fs.readFile(PROMPT_PATH, 'utf-8');
  } catch {
    return 'For each frame, return JSON {sceneIndex, importance(1-5), type, summary}.';
  }
}

function extractJsonArray(text) {
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const raw = fence ? fence[1] : (text.match(/\[[\s\S]*\]/)?.[0]);
  if (!raw) throw new Error('No JSON array in vision response');
  return JSON.parse(raw);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {Array<{sceneIndex:number, framePath:string, atSec:number}>} frames
 * @returns {Promise<Array<{sceneIndex:number, importance:number, type:string, summary:string, atSec:number}>>}
 */
export async function analyzeScenes(frames, onProgress = () => {}) {
  if (frames.length === 0) return [];
  const prompt = await getPrompt();
  const batches = chunk(frames, BATCH_SIZE);
  const results = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    onProgress(
      `Analyzing scenes ${b * BATCH_SIZE + 1}-${b * BATCH_SIZE + batch.length} of ${frames.length}`,
      Math.round((b / batches.length) * 100)
    );

    const images = await Promise.all(batch.map(async f => ({
      buffer: await fs.readFile(f.framePath),
      mimeType: 'image/jpeg',
    })));

    const batchPrompt = `${prompt}\n\nThis batch contains ${batch.length} frames in chronological order.`;

    let parsed;
    try {
      const text = await retry(
        () => visionQueryBatch(batchPrompt, images),
        { maxAttempts: 3, label: `video-analyze-batch-${b + 1}` }
      );
      parsed = extractJsonArray(text);
    } catch (err) {
      logger.warn(`[videoAnalyzer] batch ${b + 1} failed: ${err.message} — defaulting to importance=3`);
      parsed = batch.map((_, i) => ({ sceneIndex: i, importance: 3, type: 'dialogue', summary: 'unparsed' }));
    }

    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      logger.warn(`[videoAnalyzer] batch ${b + 1} length mismatch (got ${parsed?.length}, expected ${batch.length}) — padding`);
      parsed = batch.map((_, i) => parsed?.[i] ?? { sceneIndex: i, importance: 3, type: 'dialogue', summary: 'missing' });
    }

    for (let i = 0; i < batch.length; i++) {
      const frame = batch[i];
      const entry = parsed[i] || {};
      results.push({
        sceneIndex: frame.sceneIndex,
        atSec:      frame.atSec,
        importance: clampInt(entry.importance, 1, 5, 3),
        type:       String(entry.type || 'dialogue'),
        summary:    String(entry.summary || ''),
      });
    }
  }

  logger.info(`[videoAnalyzer] scored ${results.length} scenes across ${batches.length} batches`);
  return results;
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
