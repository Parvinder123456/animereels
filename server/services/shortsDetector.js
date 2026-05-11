/**
 * Detect the N most interesting segments in a transcript for short-form clips.
 * Uses AI (via textQuery) to find viral-worthy windows.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'shorts-detector.v1.md');

async function getPrompt() {
  try { return await fs.readFile(PROMPT_PATH, 'utf-8'); }
  catch { return 'Find the most interesting segments for short clips. Return JSON array [{startSec,endSec,title,reason}].'; }
}

function extractJsonArray(text) {
  // Try to extract JSON array from response (may be wrapped in code fence)
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const raw = fence ? fence[1] : (text.match(/\[[\s\S]*\]/)?.[0]);
  if (!raw) throw new Error('No JSON array in shorts-detector response');
  return JSON.parse(raw);
}

function compactTranscript(segments) {
  return segments.map(s =>
    `[${s.id} | ${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`
  ).join('\n');
}

/**
 * @param {Array<{id, start, end, text}>} segments - transcript segments
 * @param {{clipCount?:number, clipDurationMin?:number, clipDurationMax?:number}} opts
 * @returns {Promise<Array<{startSec:number, endSec:number, title:string, reason:string}>>}
 */
export async function detectInterestingSegments(segments, opts = {}) {
  const clipCount = opts.clipCount || 5;
  const minDur = opts.clipDurationMin || 30;
  const maxDur = opts.clipDurationMax || 90;

  if (!segments?.length) return [];

  let promptTemplate = await getPrompt();
  promptTemplate = promptTemplate
    .replace('TARGET_COUNT', String(clipCount))
    .replace('TARGET_DURATION_MIN', String(minDur))
    .replace('TARGET_DURATION_MAX', String(maxDur));

  const prompt = `${promptTemplate}\n\nTRANSCRIPT:\n${compactTranscript(segments)}`;

  const raw = await retry(
    () => textQuery(prompt, { temperature: 0.3 }),
    { maxAttempts: 3, label: 'shorts-detector' },
  );

  let clips;
  try { clips = extractJsonArray(raw); }
  catch (err) {
    logger.warn(`[shortsDetector] JSON parse failed: ${err.message}`);
    return [];
  }

  // Validate and clamp
  const validated = clips
    .filter(c => typeof c.startSec === 'number' && typeof c.endSec === 'number')
    .map(c => ({
      startSec: Math.max(0, c.startSec),
      endSec: c.endSec,
      title: String(c.title || 'Clip').slice(0, 80),
      reason: String(c.reason || ''),
    }))
    .filter(c => c.endSec > c.startSec && (c.endSec - c.startSec) >= 10);

  // Remove overlapping clips (keep earlier/higher-ranked ones)
  const noOverlap = [];
  for (const clip of validated) {
    const overlaps = noOverlap.some(
      existing => clip.startSec < existing.endSec && clip.endSec > existing.startSec,
    );
    if (!overlaps) noOverlap.push(clip);
  }

  logger.info(`[shortsDetector] found ${noOverlap.length} clips from ${segments.length} segments`);
  return noOverlap.slice(0, clipCount);
}
