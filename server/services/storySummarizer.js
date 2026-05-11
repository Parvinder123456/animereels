/**
 * Hierarchical story summarizer for the video_explainer pipeline.
 *
 *   1. summarizeEpisodes()  →  for each episode, send its slice of the
 *      transcript to DeepSeek/whatever text backend is selected, get a
 *      structured per-episode summary (title, characters, plot arc,
 *      key moments, themes, unresolved threads).
 *
 *   2. summarizeBundle()    →  take all per-episode summaries and produce
 *      a single combined arc summary that the script writer uses as
 *      the over-the-shoulder context for narration.
 *
 * Both steps route through textQuery so a fresh install lands on DeepSeek
 * (~$0.005 per project total) but Gemini / Groq / Ollama work too.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import { safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPISODE_PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'episode-summary.v1.md');
const BUNDLE_PROMPT_PATH  = path.resolve(__dirname, '..', '..', 'prompts', 'bundle-summary.v1.md');

async function readPrompt(p, fallback) {
  try { return await fs.readFile(p, 'utf-8'); }
  catch { return fallback; }
}

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in summarizer response');
  return JSON.parse(raw);
}

function formatSegments(segments) {
  return segments
    .map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] ${s.text}`)
    .join('\n');
}

/**
 * @param {string} projectId
 * @param {Array<{start, end, text}>} transcriptSegments  full transcript
 * @param {Array<{idx, startSec, durationSec}>} episodes
 * @param {Array<{startSec, endSec}>} skipWindows  to exclude OP/ED dialogue noise
 */
export async function summarizeEpisodes(projectId, transcriptSegments, episodes, skipWindows = [], onProgress = () => {}) {
  const promptTemplate = await readPrompt(EPISODE_PROMPT_PATH,
    'Summarize this episode transcript. Return JSON {episodeIdx,title,characters,plotArc,keyMoments,themes,unresolved}.');

  const inSkip = (sec) => skipWindows.some(w => sec >= w.startSec && sec < w.endSec);
  const perEpisodeSummaries = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const epEnd = ep.startSec + ep.durationSec;
    const epSegs = transcriptSegments
      .filter(s => s.start >= ep.startSec && s.end <= epEnd)
      .filter(s => !inSkip(s.start));
    if (!epSegs.length) {
      logger.warn(`[storySummarizer] episode ${ep.idx} has no dialogue after skip filter — using empty summary`);
      perEpisodeSummaries.push({
        episodeIdx: ep.idx, title: `Episode ${ep.idx + 1}`,
        characters: [], plotArc: '', keyMoments: [], themes: [], unresolved: '',
      });
      continue;
    }

    onProgress(`Summarizing episode ${i + 1}/${episodes.length}...`, Math.round((i / episodes.length) * 100));
    const prompt =
      `${promptTemplate}\n\n` +
      `Episode index: ${ep.idx}\nEpisode timestamp range in source: ${ep.startSec.toFixed(1)}-${epEnd.toFixed(1)}s\n\n` +
      `TRANSCRIPT:\n${formatSegments(epSegs)}`;

    let summary;
    try {
      const raw = await retry(() => textQuery(prompt, { temperature: 0.3 }), { maxAttempts: 2, label: `ep-summary-${ep.idx}` });
      summary = extractJsonObject(raw);
    } catch (err) {
      logger.warn(`[storySummarizer] episode ${ep.idx} summary failed: ${err.message} — fallback shell`);
      summary = {
        episodeIdx: ep.idx, title: `Episode ${ep.idx + 1}`,
        characters: [], plotArc: epSegs.slice(0, 5).map(s => s.text).join(' '),
        keyMoments: [], themes: [], unresolved: '',
      };
    }
    summary.episodeIdx = ep.idx;
    perEpisodeSummaries.push(summary);
  }

  await safeWriteJson(projectPath(projectId, 'episode-summaries.json'), perEpisodeSummaries);
  logger.info(`[storySummarizer] wrote ${perEpisodeSummaries.length} episode summaries`);
  return perEpisodeSummaries;
}

/**
 * @param {string} projectId
 * @param {Array<object>} perEpisodeSummaries
 */
export async function summarizeBundle(projectId, perEpisodeSummaries, onProgress = () => {}) {
  const promptTemplate = await readPrompt(BUNDLE_PROMPT_PATH,
    'Combine these episode summaries into one bundle arc. Return JSON {bundleTitle,characters,arcSummary,episodeRecap,throughLines,endsOn}.');

  onProgress('Combining episode summaries into bundle arc...', 50);
  const prompt = `${promptTemplate}\n\nEPISODE SUMMARIES:\n${JSON.stringify(perEpisodeSummaries, null, 2)}`;

  let bundle;
  try {
    const raw = await retry(() => textQuery(prompt, { temperature: 0.4 }), { maxAttempts: 2, label: 'bundle-summary' });
    bundle = extractJsonObject(raw);
  } catch (err) {
    logger.warn(`[storySummarizer] bundle summary failed: ${err.message} — using fallback`);
    bundle = {
      bundleTitle: 'Anime Recap',
      characters: [],
      arcSummary: perEpisodeSummaries.map(e => e.plotArc).filter(Boolean).join(' '),
      episodeRecap: perEpisodeSummaries.map(e => ({ episodeIdx: e.episodeIdx, title: e.title, oneLine: '' })),
      throughLines: [],
      endsOn: '',
    };
  }

  await safeWriteJson(projectPath(projectId, 'bundle-summary.json'), bundle);
  onProgress('Bundle summary complete', 100);
  logger.info(`[storySummarizer] bundle summary written: "${bundle.bundleTitle}"`);
  return bundle;
}
