/**
 * Translate a generated script.json into another language for multi-language
 * narration. Produces a parallel script-<lang>.json that downstream voice
 * generation can consume.
 *
 * One LLM call per batch of 12 segments (same batching as the script writer)
 * so the translator stays focused and the output JSON doesn't truncate.
 */

import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import {
  safeReadJson, safeWriteJson, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 12;

const SUPPORTED = {
  hi: 'Hindi (Devanagari)',
  es: 'Spanish (Latin American)',
  pt: 'Portuguese (Brazilian)',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  id: 'Indonesian',
  ar: 'Arabic',
  zh: 'Chinese (Simplified)',
};

const PROMPT = (langLabel) => `
You are translating narrator script segments from English to ${langLabel}.
Preserve the speaker's tone, pacing, and intent. DO NOT add or remove
segments — translate exactly one segment per input, same index, same order.

Rules:
- Keep proper nouns and well-known names in their original form unless a
  natural localized equivalent exists.
- Match the source segment's word count within ±25% so timing stays close.
- Preserve breathe segments: if input text is empty, output empty.
- No transliteration. Output natural ${langLabel} that a native narrator
  would deliver.

Return ONLY this JSON — no prose, no code fence:

{
  "segments": [
    { "sceneIndex": <number, copied from input>, "text": "<translation>" }
  ]
}
`.trim();

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in translation response');
  return JSON.parse(raw);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function formatSegments(segs) {
  return segs.map(s =>
    `[scene ${s.sceneIndex}] ${s.text || '(breathe — leave empty)'}`
  ).join('\n');
}

export function listSupportedLanguages() {
  return Object.entries(SUPPORTED).map(([code, label]) => ({ code, label }));
}

/**
 * @param {string} projectId
 * @param {string} languageCode  e.g. 'hi', 'es'
 * @param {{force?: boolean, onProgress?: Function}} opts
 * @returns {Promise<object>} the translated script object
 */
export async function translateScript(projectId, languageCode, { force = false, onProgress = () => {} } = {}) {
  if (!SUPPORTED[languageCode]) {
    throw new Error(`Unsupported language: ${languageCode}. Supported: ${Object.keys(SUPPORTED).join(', ')}`);
  }
  const outPath = projectPath(projectId, `script-${languageCode}.json`);
  const enScriptPath = projectPath(projectId, 'script.json');
  const enScript = await safeReadJson(enScriptPath);
  if (!enScript?.segments?.length) throw new Error('English script.json missing — generate it first');

  if (!force && await fileExists(outPath)) {
    const cached = await safeReadJson(outPath);
    if (cached?.sourceScriptUpdatedAt === enScript.updatedAt) {
      logger.info(`[scriptTranslator] ${languageCode} cache hit`);
      return cached;
    }
  }

  const langLabel = SUPPORTED[languageCode];
  const promptTemplate = PROMPT(langLabel);
  const batches = chunk(enScript.segments, BATCH_SIZE);
  const translatedSegments = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    onProgress(`Translating segments ${batch[0].sceneIndex}-${batch[batch.length - 1].sceneIndex} → ${langLabel}`,
      Math.round((b / batches.length) * 95));

    const prompt = `${promptTemplate}\n\nSEGMENTS (English → ${langLabel}):\n${formatSegments(batch)}`;

    let parsed;
    try {
      const raw = await retry(
        () => textQuery(prompt, { temperature: 0.5 }),
        { maxAttempts: 2, label: `script-translate-${languageCode}-batch-${b + 1}` }
      );
      parsed = extractJsonObject(raw);
    } catch (err) {
      logger.warn(`[scriptTranslator] batch ${b + 1} failed: ${err.message} — copying English as fallback`);
      parsed = { segments: batch.map(s => ({ sceneIndex: s.sceneIndex, text: s.text || '' })) };
    }

    const byIdx = new Map((parsed.segments || []).map(s => [s.sceneIndex, s]));
    for (const original of batch) {
      const t = byIdx.get(original.sceneIndex);
      translatedSegments.push({
        ...original,
        text: t?.text?.trim() ?? original.text,
      });
    }
  }

  // Also translate title + hook for completeness.
  let title = enScript.title || '';
  let hook = enScript.hook || '';
  try {
    const titlePrompt =
      `Translate the following to ${langLabel}. Output JSON ONLY: ` +
      `{"title": "...", "hook": "..."}\n\nTITLE: ${title}\nHOOK: ${hook}`;
    const raw = await retry(() => textQuery(titlePrompt, { temperature: 0.5 }),
      { maxAttempts: 2, label: `script-translate-${languageCode}-title` });
    const parsed = extractJsonObject(raw);
    if (parsed.title) title = parsed.title;
    if (parsed.hook)  hook  = parsed.hook;
  } catch (err) {
    logger.warn(`[scriptTranslator] title/hook translation failed: ${err.message}`);
  }

  const translated = {
    ...enScript,
    title,
    hook,
    segments: translatedSegments,
    language: languageCode,
    sourceScriptUpdatedAt: enScript.updatedAt,
    translatedAt: new Date().toISOString(),
  };
  await safeWriteJson(outPath, translated);
  onProgress(`Translation complete: ${translatedSegments.length} segments in ${langLabel}`, 100);
  logger.info(`[scriptTranslator] wrote script-${languageCode}.json with ${translatedSegments.length} segments`);
  return translated;
}
