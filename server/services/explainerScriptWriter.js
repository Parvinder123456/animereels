/**
 * Write the narrator script for a video_explainer project.
 *
 * Input: scenes from the Gemini visual breakdown + sceneSelector. Each
 * scene carries both VISUAL context and dialogue context, so the narrator
 * can write commentary that MATCHES what's on screen instead of what
 * dialogue happens to say.
 *
 * Output (script.json): the standard render contract:
 *   { title, hook, segments: [{ sceneIndex, sourceStart, sourceEnd, text, mood }] }
 *
 * For long projects (40+ scenes) we batch into windows of ~12 scenes per
 * call so the LLM stays focused and the output JSON doesn't truncate.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import { safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'explainer-narration.v1.md');

const WORDS_PER_SECOND = 2.3;
const BATCH_SIZE = 12;

async function getPrompt() {
  try { return await fs.readFile(PROMPT_PATH, 'utf-8'); }
  catch { return 'Write narration. One segment per scene. Return JSON {title,hook,segments:[{sceneIndex,text,mood}]}.'; }
}

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in script response');
  return JSON.parse(raw);
}

function formatScenes(scenes, wordBudgets) {
  return scenes.map(s => {
    const dur = s.endSec - s.startSec;
    const targetWords = wordBudgets?.[s.idx] ?? Math.round(dur * WORDS_PER_SECOND);
    const chars = s.characters?.length ? ` chars=[${s.characters.join(', ')}]` : '';
    const dialogue = (s.dialogueGist || '').slice(0, 300);
    const verbatim = (s.dialogueVerbatim || '').slice(0, 300);
    return (
      `SCENE ${s.idx} (${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}s, ${dur.toFixed(1)}s, ` +
      `type=${s.type}, mood=${s.mood}, importance=${s.importance},${chars} target ~${targetWords} words)\n` +
      `  VISUAL:   ${s.visualDescription || '(unspecified)'}\n` +
      (dialogue ? `  SAYS:     ${dialogue}\n` : '') +
      (verbatim ? `  VERBATIM: ${verbatim}\n` : '')
    ).trimEnd();
  }).join('\n\n');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string} projectId
 * @param {Array<object>} scenes        selected scenes from sceneSelector
 * @param {Function} onProgress
 * @param {object} opts
 * @param {number} opts.targetReelSec   total target reel duration for word budgeting
 * @param {object} opts.bundleHints     optional: { bundleTitle, characters, throughLines, endsOn }
 *                                       derived from the scene plan, gives the writer cross-scene context
 */
export async function writeExplainerScript(projectId, scenes, onProgress = () => {}, { targetReelSec, bundleHints } = {}) {
  if (!scenes.length) throw new Error('No scenes to write narration for');
  const promptTemplate = await getPrompt();

  // Per-scene word budget proportional to its share of total selected time.
  const totalSceneDur = scenes.reduce((s, sc) => s + (sc.endSec - sc.startSec), 0);
  const effectiveTarget = targetReelSec || totalSceneDur;
  const totalWords = Math.round(effectiveTarget * WORDS_PER_SECOND);
  const wordBudgets = {};
  for (const s of scenes) {
    const dur = s.endSec - s.startSec;
    const share = dur / (totalSceneDur || 1);
    wordBudgets[s.idx] = Math.max(8, Math.round(share * totalWords));
  }
  logger.info(
    `[explainerScriptWriter] target=${effectiveTarget.toFixed(0)}s totalWords=${totalWords} scenes=${scenes.length}`
  );

  // Cross-scene context block. Derived from the scene plan (top characters,
  // arc-spanning info) so the narrator doesn't reintroduce known faces every scene.
  const charCounts = {};
  for (const s of scenes) for (const c of (s.characters || [])) {
    charCounts[c] = (charCounts[c] || 0) + 1;
  }
  const topChars = Object.entries(charCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);

  const contextBlock =
    `BUNDLE TITLE: ${bundleHints?.bundleTitle || 'Anime Explainer'}\n` +
    `RECURRING CHARACTERS: ${topChars.join(', ') || '(infer from scenes)'}\n` +
    `ARC OVERVIEW: ${bundleHints?.arcOverview || '(infer from scenes in order)'}\n` +
    `THROUGH LINES: ${(bundleHints?.throughLines || []).join('; ')}\n` +
    `ENDS ON: ${bundleHints?.endsOn || ''}\n`;

  const batches = chunk(scenes, BATCH_SIZE);
  const allSegments = [];
  let title = bundleHints?.bundleTitle || 'Anime Explainer';
  let hook  = '';

  for (let b = 0; b < batches.length; b++) {
    const batchScenes = batches[b];
    onProgress(
      `Writing narration for scenes ${batchScenes[0].idx}-${batchScenes[batchScenes.length - 1].idx} ` +
      `(${b + 1}/${batches.length})`,
      Math.round((b / batches.length) * 95)
    );

    const isFirst = b === 0;
    const hookInstruction = isFirst
      ? `Write the hook + segments for this batch.`
      : `This is batch ${b + 1} of ${batches.length} — DO NOT write a hook (leave hook empty).`;

    const prompt =
      `${promptTemplate}\n\n${contextBlock}\n${hookInstruction}\n\n` +
      `SCENES:\n${formatScenes(batchScenes, wordBudgets)}`;

    let parsed;
    try {
      const raw = await retry(
        () => textQuery(prompt, { temperature: 0.7 }),
        { maxAttempts: 2, label: `explainer-script-batch-${b + 1}` }
      );
      parsed = extractJsonObject(raw);
    } catch (err) {
      logger.warn(`[explainerScriptWriter] batch ${b + 1} failed: ${err.message} — using visual-description fallback`);
      parsed = {
        title, hook: '',
        segments: batchScenes.map(s => ({
          sceneIndex: s.idx,
          text: s.visualDescription || s.dialogueGist || 'Continuing...',
          mood: s.mood || 'calm',
        })),
      };
    }

    if (isFirst) {
      title = parsed.title || title;
      hook  = parsed.hook  || '';
    }

    const byIdx = new Map((parsed.segments || []).map(s => [s.sceneIndex, s]));
    for (const scene of batchScenes) {
      const s = byIdx.get(scene.idx);
      allSegments.push({
        sceneIndex: scene.idx,
        sourceStart: scene.startSec,
        sourceEnd:   scene.endSec,
        text: s?.text?.trim() || scene.visualDescription || scene.dialogueGist || '',
        mood: (s?.mood || scene.mood || 'calm').toLowerCase(),
      });
    }
  }

  allSegments.sort((a, b) => a.sceneIndex - b.sceneIndex);
  const script = {
    title,
    hook,
    segments: allSegments,
    projectType: 'video_explainer',
    sourceWindow: {
      startSec: scenes[0].startSec,
      endSec: scenes[scenes.length - 1].endSec,
    },
  };
  await safeWriteJson(projectPath(projectId, 'script.json'), script);
  onProgress('Script generation complete', 100);
  logger.info(
    `[explainerScriptWriter] wrote ${allSegments.length} segments across ${batches.length} batches · "${title}"`
  );
  return script;
}
