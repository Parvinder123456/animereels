/**
 * Write the narrator script for a video_explainer project.
 *
 * Input: scenes from the Gemini visual breakdown + sceneSelector. Each
 * scene carries both VISUAL context and dialogue context, plus keyTakeaway
 * for podcast/interview content.
 *
 * Output (script.json): the standard render contract:
 *   { title, hook, segments: [{ sceneIndex, sourceStart, sourceEnd, text, mood }] }
 *
 * Features:
 *   - Mood-adaptive word budgets (action=fast, emotional=slow, breathe=0)
 *   - Cold-open hook from the highest-importance scene
 *   - Previous-batch context for narrator continuity across batches
 *   - Breathe segments (text="") let original audio play
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

// Mood-adaptive words-per-second. Action/energy → faster narration,
// emotional/suspense → slower and more deliberate, breathe → silence.
const MOOD_WPS = {
  action:        3.0,
  energetic:     2.8,
  comedic:       2.6,
  inspirational: 2.5,
  calm:          2.3,
  reveal:        2.0,
  dramatic:      2.0,
  emotional:     1.8,
  suspense:      1.8,
  breathe:       0,
};
const DEFAULT_WPS = 2.3;

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
    const targetWords = wordBudgets?.[s.idx] ?? Math.round(dur * DEFAULT_WPS);
    const chars = s.characters?.length ? ` chars=[${s.characters.join(', ')}]` : '';
    const dialogue = (s.dialogueGist || '').slice(0, 300);
    const verbatim = (s.dialogueVerbatim || '').slice(0, 300);
    const takeaway = (s.keyTakeaway || '').slice(0, 200);
    const onScreen = (s._outputStart != null && s._outputEnd != null)
      ? ` | on screen: ~${(s._outputEnd - s._outputStart).toFixed(0)}s`
      : '';
    return (
      `SCENE ${s.idx} (source: ${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}s${onScreen}, ` +
      `type=${s.type}, mood=${s.mood}, importance=${s.importance},${chars} target ~${targetWords} words)\n` +
      `  VISUAL:   ${s.visualDescription || '(unspecified)'}\n` +
      (dialogue ? `  SAYS:     ${dialogue}\n` : '') +
      (verbatim ? `  VERBATIM: ${verbatim}\n` : '') +
      (takeaway ? `  KEY TAKEAWAY: ${takeaway}\n` : '')
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
 * @param {object} opts.bundleSummary   from storySummarizer.summarizeBundle —
 *                                       { bundleTitle, arcSummary, characters,
 *                                         episodeRecap, throughLines, endsOn }
 *                                       Gives the narrator real story context.
 */
export async function writeExplainerScript(projectId, scenes, onProgress = () => {}, { targetReelSec, bundleSummary } = {}) {
  if (!scenes.length) throw new Error('No scenes to write narration for');
  const promptTemplate = await getPrompt();

  // Compute the same ratio the renderer will use so word budgets match output time.
  const sourceWindowStart = scenes[0].startSec;
  const sourceWindowEnd = scenes[scenes.length - 1].endSec;
  const sourceWindowDur = sourceWindowEnd - sourceWindowStart;
  const effectiveTarget = targetReelSec || sourceWindowDur;
  const ratio = sourceWindowDur / effectiveTarget;

  // For CUT mode (ratio > 2.5): use total selected scene dur, not full window
  const totalSelectedDur = scenes.reduce((s, sc) => s + (sc.endSec - sc.startSec), 0);
  const useCutMode = ratio > 2.5;
  const renderMode = ratio < 1.0 ? 'stretch' : (useCutMode ? 'cut' : 'continuous');
  const effectiveSourceDur = useCutMode ? totalSelectedDur : sourceWindowDur;
  const effectiveRatio = effectiveSourceDur / effectiveTarget;

  // Output-time position of each scene
  if (useCutMode) {
    let cursor = 0;
    for (const s of scenes) {
      const sceneDur = s.endSec - s.startSec;
      s._outputStart = cursor;
      s._outputEnd = cursor + sceneDur / effectiveRatio;
      cursor = s._outputEnd;
    }
  } else {
    for (const s of scenes) {
      s._outputStart = (s.startSec - sourceWindowStart) / effectiveRatio;
      s._outputEnd = (s.endSec - sourceWindowStart) / effectiveRatio;
    }
  }

  // Mood-adaptive word budgets
  const wordBudgets = {};
  for (let i = 0; i < scenes.length; i++) {
    const start = scenes[i]._outputStart;
    const end = (i < scenes.length - 1) ? scenes[i + 1]._outputStart : scenes[i]._outputEnd;
    const moodKey = (scenes[i].mood || '').toLowerCase();
    const wps = MOOD_WPS[moodKey] || DEFAULT_WPS;
    wordBudgets[scenes[i].idx] = wps > 0 ? Math.max(8, Math.round((end - start) * wps)) : 0;
  }
  const totalWords = Object.values(wordBudgets).reduce((a, b) => a + b, 0);
  logger.info(
    `[explainerScriptWriter] target=${effectiveTarget.toFixed(0)}s totalWords=${totalWords} ` +
    `scenes=${scenes.length} ratio=${ratio.toFixed(2)} mode=${renderMode}`
  );

  // Rich story context
  const charactersBlock = (bundleSummary?.characters || [])
    .map(c => `- ${c.name}: ${c.role}`)
    .join('\n') || '(infer from scenes)';
  const episodeBlock = (bundleSummary?.episodeRecap || [])
    .map(e => `  - Episode ${e.episodeIdx + 1}: ${e.title || ''} — ${e.oneLine || ''}`)
    .join('\n');

  const contextBlock =
    `CONTENT TITLE: ${bundleSummary?.bundleTitle || 'Video Recap'}\n\n` +
    `SUMMARY:\n${bundleSummary?.arcSummary || '(infer from scenes in order)'}\n\n` +
    `SPEAKERS / CHARACTERS:\n${charactersBlock}\n\n` +
    (episodeBlock ? `SECTION RECAP:\n${episodeBlock}\n\n` : '') +
    `THROUGH LINES: ${(bundleSummary?.throughLines || []).join('; ')}\n` +
    `ENDS ON: ${bundleSummary?.endsOn || ''}\n`;

  // Find the most powerful moment for cold-open teaser
  const climaxScene = scenes.reduce((max, s) =>
    (s.importance || 0) > (max?.importance || 0) ? s : max, scenes[0]);

  const batches = chunk(scenes, BATCH_SIZE);
  const allSegments = [];
  let title = bundleSummary?.bundleTitle || 'Video Recap';
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
      ? `Write the hook + segments for this batch.\n` +
        `COLD OPEN: The most powerful moment is Scene ${climaxScene.idx}: ` +
        `"${(climaxScene.keyTakeaway || climaxScene.visualDescription || climaxScene.dialogueGist || '').slice(0, 200)}". ` +
        `Tease this in your hook WITHOUT spoiling it — make the viewer NEED to keep watching.`
      : `This is batch ${b + 1} of ${batches.length} — DO NOT write a hook (leave hook empty).`;

    // Pass previous batch output for narrator continuity
    const previousNarration = allSegments.length > 0
      ? `\nPREVIOUSLY NARRATED (maintain flow, don't repeat):\n` +
        allSegments.slice(-3).map(s => `  [Scene ${s.sceneIndex}] ${s.text || '(breathe)'}`).join('\n') + '\n'
      : '';

    const prompt =
      `${promptTemplate}\n\n${contextBlock}\n${hookInstruction}\n${previousNarration}\n` +
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
          text: s.keyTakeaway || s.visualDescription || s.dialogueGist || 'Continuing...',
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
        outputStart: scene._outputStart,
        outputEnd:   scene._outputEnd,
        text: s?.text?.trim() || '',
        mood: (s?.mood || scene.mood || 'calm').toLowerCase(),
      });
    }
  }

  allSegments.sort((a, b) => a.sceneIndex - b.sceneIndex);

  const breatheCount = allSegments.filter(s => !s.text || s.mood === 'breathe').length;
  logger.info(`[explainerScriptWriter] breathe segments: ${breatheCount}/${allSegments.length}`);

  const script = {
    title,
    hook,
    segments: allSegments,
    projectType: 'video_explainer',
    speedRatio: ratio,
    renderMode,
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
