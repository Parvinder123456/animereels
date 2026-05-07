/**
 * Write the narrator script for a video-summary project, given the
 * selected clips and a target word count. Routes through textQuery —
 * so when textBackend === 'deepseek' this whole step costs ~$0.005.
 *
 * Output shape matches the existing manga script.json: { title, hook,
 * segments[{text, mood, ...}] }. We add a `clipIndex` field on each
 * segment so the renderer can pair it with the right clip.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import { safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'anime-recap.v1.md');

const WORDS_PER_SECOND = 2.5;

async function getPrompt() {
  try {
    return await fs.readFile(PROMPT_PATH, 'utf-8');
  } catch {
    return 'Write narration with one segment per clip in JSON: {title,hook,segments:[{clipIndex,text,mood}]}.';
  }
}

function formatClipsForPrompt(clips) {
  return clips
    .map(c =>
      `Clip ${c.clipIndex} · ${c.durationSec.toFixed(1)}s · type=${c.type} · ` +
      `importance=${c.importance}\n  ${c.summary}`
    )
    .join('\n');
}

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in script response');
  return JSON.parse(raw);
}

export async function generateVideoSummaryScript(projectId, clips, { targetReelSec, onProgress = () => {} } = {}) {
  if (!clips.length) throw new Error('No clips to script');

  const targetWords = Math.round(targetReelSec * WORDS_PER_SECOND);
  const promptTemplate = await getPrompt();

  const prompt =
    promptTemplate
      .replace(/TARGET_WORDS/g, String(targetWords)) +
    `\n\nCLIPS (in order):\n${formatClipsForPrompt(clips)}\n\n` +
    `Total reel duration: ~${targetReelSec}s, target narration ≈ ${targetWords} words.`;

  onProgress('Writing narration with DeepSeek (or chosen text backend)...', 30);

  const raw = await retry(
    () => textQuery(prompt, { temperature: 0.7 }),
    { maxAttempts: 3, label: 'video-summary-script' }
  );

  let parsed;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    logger.warn(`[videoSummaryScriptWriter] JSON parse failed: ${err.message} — using fallback`);
    parsed = {
      title: 'Untitled Recap',
      hook: '',
      segments: clips.map(c => ({ clipIndex: c.clipIndex, text: c.summary || '', mood: 'dramatic' })),
    };
  }

  parsed.title = parsed.title || 'Untitled Recap';
  parsed.hook  = parsed.hook  || '';
  parsed.segments = (parsed.segments || []).map(s => ({
    clipIndex: typeof s.clipIndex === 'number' ? s.clipIndex : null,
    text: String(s.text || s.narration || s.script_text || '').trim(),
    mood: String(s.mood || 'dramatic').toLowerCase(),
  })).filter(s => s.text);

  // Re-pair segments to clips by index — drop any orphans, fill any missing.
  const byIdx = new Map(parsed.segments.map(s => [s.clipIndex, s]));
  parsed.segments = clips.map(c => byIdx.get(c.clipIndex) || {
    clipIndex: c.clipIndex,
    text: c.summary || '',
    mood: 'dramatic',
  });

  await safeWriteJson(projectPath(projectId, 'script.json'), parsed);
  onProgress('Script generation complete', 100);
  logger.info(`[videoSummaryScriptWriter] ${parsed.segments.length} segments · "${parsed.title}"`);
  return parsed;
}
