/**
 * Write the per-beat narrator script for a video_explainer project.
 *
 * Receives the bundle summary (story context) + the chosen beats (each
 * with verbatim dialogue from the transcript), produces one narration
 * segment per beat. The prompt makes the narrator aware of the full
 * story so it can foreshadow, recall, and explain motivation rather
 * than just describe what's on screen.
 *
 * For long bundles (40+ beats) we batch into windows of ~15 beats per
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
const BATCH_SIZE = 15;

async function getPrompt() {
  try { return await fs.readFile(PROMPT_PATH, 'utf-8'); }
  catch { return 'Write narrator commentary. One segment per beat. Return JSON {title,hook,segments:[{beatIndex,text,mood}]}.'; }
}

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in script response');
  return JSON.parse(raw);
}

function formatBeats(beats) {
  return beats.map(b => {
    const dialogue = b.segments.map(s => `  [${s.start.toFixed(1)}s] ${s.text}`).join('\n');
    return (
      `BEAT ${b.beatIndex} (episode ${b.episodeIdx}, ${b.startSec.toFixed(1)}-${b.endSec.toFixed(1)}s, ` +
      `${b.durationSec.toFixed(1)}s, target ~${Math.round(b.durationSec * WORDS_PER_SECOND)} words):\n${dialogue || '  (no dialogue — visual-only beat)'}`
    );
  }).join('\n\n');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string} projectId
 * @param {object} bundleSummary       from storySummarizer.summarizeBundle
 * @param {Array<object>} beats        clusters from beatClusterer
 */
export async function writeExplainerScript(projectId, bundleSummary, beats, onProgress = () => {}) {
  if (!beats.length) throw new Error('No beats to write narration for');
  const promptTemplate = await getPrompt();

  const batches = chunk(beats, BATCH_SIZE);
  const allSegments = [];
  let title = bundleSummary?.bundleTitle || 'Anime Recap';
  let hook = '';

  const contextBlock =
    `BUNDLE TITLE: ${bundleSummary?.bundleTitle || 'Unknown'}\n` +
    `ARC SUMMARY: ${bundleSummary?.arcSummary || ''}\n` +
    `CHARACTERS:\n${(bundleSummary?.characters || []).map(c => `- ${c.name}: ${c.role}`).join('\n')}\n` +
    `THROUGH LINES: ${(bundleSummary?.throughLines || []).join('; ')}\n` +
    `ENDS ON: ${bundleSummary?.endsOn || ''}`;

  for (let b = 0; b < batches.length; b++) {
    const batchBeats = batches[b];
    onProgress(
      `Writing narration for beats ${batchBeats[0].beatIndex}-${batchBeats[batchBeats.length - 1].beatIndex} ` +
      `(${b + 1}/${batches.length})`,
      Math.round((b / batches.length) * 95)
    );

    const isFirst = b === 0;
    const prompt =
      `${promptTemplate}\n\n${contextBlock}\n\n` +
      (isFirst ? `Write the hook + segments for this batch.\n\n` : `This is batch ${b + 1} of ${batches.length} — DO NOT write a hook for this batch (leave hook empty).\n\n`) +
      `BEATS:\n${formatBeats(batchBeats)}`;

    let parsed;
    try {
      const raw = await retry(() => textQuery(prompt, { temperature: 0.7 }), { maxAttempts: 2, label: `explainer-script-batch-${b + 1}` });
      parsed = extractJsonObject(raw);
    } catch (err) {
      logger.warn(`[explainerScriptWriter] batch ${b + 1} failed: ${err.message} — using dialogue fallback`);
      parsed = {
        title, hook: '',
        segments: batchBeats.map(b => ({
          beatIndex: b.beatIndex,
          text: b.segments.map(s => s.text).join(' '),
          mood: 'calm',
        })),
      };
    }

    if (isFirst) {
      title = parsed.title || title;
      hook  = parsed.hook  || '';
    }
    const byIdx = new Map((parsed.segments || []).map(s => [s.beatIndex, s]));
    for (const beat of batchBeats) {
      const s = byIdx.get(beat.beatIndex);
      allSegments.push({
        beatIndex: beat.beatIndex,
        episodeIdx: beat.episodeIdx,
        sourceStart: beat.startSec,
        sourceEnd: beat.endSec,
        text: s?.text?.trim() || beat.segments.map(seg => seg.text).join(' '),
        mood: (s?.mood || 'calm').toLowerCase(),
      });
    }
  }

  // Normalize order + fill gaps.
  allSegments.sort((a, b) => a.beatIndex - b.beatIndex);
  const script = {
    title,
    hook,
    segments: allSegments,
    projectType: 'video_explainer',
    sourceWindow: { startSec: beats[0].startSec, endSec: beats[beats.length - 1].endSec },
  };
  await safeWriteJson(projectPath(projectId, 'script.json'), script);
  onProgress('Script generation complete', 100);
  logger.info(
    `[explainerScriptWriter] wrote ${allSegments.length} segments across ${batches.length} batches · "${title}"`
  );
  return script;
}
