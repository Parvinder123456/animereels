/**
 * Find the contiguous window in a transcript that best matches a topic
 * supplied by the user. Routes through textQuery so the call uses
 * whatever text backend is currently selected (DeepSeek by default).
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'segment-finder.v1.md');

const MIN_WINDOW_SEC = 30;
const MAX_WINDOW_SEC = 180;

async function getPrompt() {
  try { return await fs.readFile(PROMPT_PATH, 'utf-8'); }
  catch { return 'Pick a 30-180s window matching the topic. Return JSON {found,startSec,endSec,rationale}.'; }
}

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in segment-finder response');
  return JSON.parse(raw);
}

function compactSegments(segments) {
  // Whisper segments are typically ~5-15s each; we send id/start/end/text.
  return segments.map(s => `[${s.id} | ${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`).join('\n');
}

/**
 * @param {Array<{id, start, end, text}>} segments  Whisper segments
 * @param {string} topic  natural-language topic
 * @returns {Promise<{found:boolean, startSec:number, endSec:number, rationale:string}>}
 */
export async function findTopicWindow(segments, topic) {
  if (!segments?.length) return { found: false, startSec: 0, endSec: 0, rationale: 'no transcript segments' };
  if (!topic?.trim()) return null;

  const promptTemplate = await getPrompt();
  const prompt = `${promptTemplate}\n\nTOPIC: ${topic.trim()}\n\nTRANSCRIPT:\n${compactSegments(segments)}`;

  const raw = await retry(
    () => textQuery(prompt, { temperature: 0.2 }),
    { maxAttempts: 3, label: 'segment-finder' }
  );

  let parsed;
  try { parsed = extractJsonObject(raw); }
  catch (err) {
    logger.warn(`[segmentFinder] JSON parse failed: ${err.message} — defaulting to "not found"`);
    return { found: false, startSec: 0, endSec: 0, rationale: 'parse failed' };
  }

  if (!parsed.found) {
    return { found: false, startSec: 0, endSec: 0, rationale: parsed.rationale || 'topic not found' };
  }

  // Snap to segment boundaries + clamp to allowed window length.
  let startSec = clampToSegmentStart(segments, Number(parsed.startSec) || 0);
  let endSec = clampToSegmentEnd(segments, Number(parsed.endSec) || 0);
  if (endSec - startSec < MIN_WINDOW_SEC) {
    endSec = Math.min(segments[segments.length - 1].end, startSec + MIN_WINDOW_SEC);
  }
  if (endSec - startSec > MAX_WINDOW_SEC) {
    endSec = startSec + MAX_WINDOW_SEC;
  }

  logger.info(
    `[segmentFinder] topic="${topic}" → ${startSec.toFixed(1)}-${endSec.toFixed(1)}s ` +
    `(${(endSec - startSec).toFixed(1)}s) · ${parsed.rationale}`
  );
  return { found: true, startSec, endSec, rationale: parsed.rationale || '' };
}

function clampToSegmentStart(segments, t) {
  let best = segments[0].start;
  for (const s of segments) {
    if (s.start <= t) best = s.start;
    else break;
  }
  return best;
}

function clampToSegmentEnd(segments, t) {
  let best = segments[segments.length - 1].end;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].end >= t) best = segments[i].end;
    else break;
  }
  return best;
}
