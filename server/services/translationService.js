/**
 * Translate a Hindi (or any-source) transcript into an English narration
 * script in the same shape as the existing manga `script.json`, so the
 * existing TTS + subtitle pipeline can handle it without modification.
 *
 * Routes through textQuery → DeepSeek by default.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import { safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'hi-en-translate.v1.md');

async function getPrompt() {
  try { return await fs.readFile(PROMPT_PATH, 'utf-8'); }
  catch { return 'Translate Hindi segments to English JSON {title,hook,segments:[{segmentId,start,end,english,mood}]}.'; }
}

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in translation response');
  return JSON.parse(raw);
}

function compactSegments(segments) {
  return segments.map(s => `[${s.id} | ${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`).join('\n');
}

/**
 * @param {string} projectId
 * @param {Array<{id,start,end,text}>} segments  Hindi transcript segments to translate
 * @param {{ window?: {startSec:number,endSec:number}, sourceLanguage?: string }} opts
 * @returns {Promise<object>}  the script.json that was written
 */
export async function translateAndScript(projectId, segments, { window, sourceLanguage = 'hi' } = {}, onProgress = () => {}) {
  const filtered = window
    ? segments.filter(s => s.end > window.startSec && s.start < window.endSec)
    : segments;
  if (!filtered.length) throw new Error('No segments in selected window — nothing to translate');

  const promptTemplate = await getPrompt();
  const prompt =
    `${promptTemplate}\n\nSOURCE LANGUAGE: ${sourceLanguage}\n\nSEGMENTS:\n${compactSegments(filtered)}`;

  onProgress(`Translating ${filtered.length} segments via DeepSeek...`, 30);

  const raw = await retry(
    () => textQuery(prompt, { temperature: 0.3 }),
    { maxAttempts: 3, label: 'hi-en-translate' }
  );

  let parsed;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    logger.warn(`[translationService] JSON parse failed: ${err.message} — using fallback shell`);
    parsed = {
      title: 'Translated Clip',
      hook: '',
      segments: filtered.map(s => ({ segmentId: s.id, start: s.start, end: s.end, english: s.text, mood: 'calm' })),
    };
  }

  // Reshape to the existing script.json contract: {title, hook, segments:[{text, mood, sourceStart, sourceEnd}]}
  const segmentsOut = (parsed.segments || []).map(s => ({
    sourceSegmentId: s.segmentId,
    sourceStart:     Number(s.start) || 0,
    sourceEnd:       Number(s.end) || 0,
    text:            String(s.english || s.text || '').trim(),
    mood:            String(s.mood || 'calm').toLowerCase(),
  })).filter(s => s.text);

  const script = {
    title: parsed.title || 'Translated Clip',
    hook:  parsed.hook  || '',
    segments: segmentsOut,
    sourceWindow: window || null,
    sourceLanguage,
  };

  await safeWriteJson(projectPath(projectId, 'script.json'), script);
  onProgress('Translation complete', 100);
  logger.info(`[translationService] ${segmentsOut.length} translated segments · "${script.title}"`);
  return script;
}
