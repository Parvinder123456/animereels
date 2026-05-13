/**
 * Generate YouTube-ready title variants + description + tags for a finished
 * explainer project. Uses the bundleSummary (real story context) + the
 * generated script (narration that actually went into the video) so titles
 * and descriptions stay faithful to what's in the recap.
 *
 * Result is cached at data/projects/<id>/title-pack.json. Re-runs return the
 * cached pack unless the script's updatedAt is newer (or force=true).
 */

import fs from 'fs/promises';
import { textQuery } from '../utils/textClient.js';
import { retry } from '../utils/retry.js';
import {
  safeReadJson, safeWriteJson, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const PROMPT = `
You are a YouTube growth strategist. Produce title variants + description +
tags for a recap/explainer video. Output ONLY this JSON — no prose, no
code fence:

{
  "titles": [
    "<variant 1 — listicle / 'Top N' format with hook number>",
    "<variant 2 — curiosity / question format>",
    "<variant 3 — outcome / 'You will learn X' format>"
  ],
  "description": "<2-3 paragraph description that frontloads value, weaves in
                   key takeaways naturally, ends with a CTA. Include timestamps
                   in 0:00 format using the format-section block I provide,
                   one per major section. Max 4500 chars.>",
  "tags": ["<5-12 lowercase tags optimized for the niche>"]
}

RULES:
- Titles: 60-72 chars each, ALL CAPS for emphasis is okay but use sparingly.
  No clickbait that doesn't deliver. Match the OUTPUT FORMAT specified below.
- Description: open with the hook, include the speaker/source names if known,
  list 3-5 key takeaways as bullets, end with a soft CTA (subscribe).
- Tags: relevant to topic + audience + format. No generic ones like "youtube".
- Output ONLY the JSON object.
`.trim();

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in title-generator response');
  return JSON.parse(raw);
}

function fmtTimestamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

/**
 * Build the chapter-timestamps block from the script's outputStart values.
 * Picks at most 8 evenly-spaced chapters using importance + position cues.
 */
function buildTimestampBlock(script) {
  const segs = script?.segments || [];
  if (!segs.length) return '';
  // Pick scenes with non-empty narration; cap at 8 evenly spaced
  const candidates = segs.filter(s => (s.text || '').length > 10);
  if (!candidates.length) return '';
  const max = Math.min(8, candidates.length);
  const step = Math.max(1, Math.floor(candidates.length / max));
  const picked = [];
  for (let i = 0; i < candidates.length; i += step) {
    if (picked.length >= max) break;
    picked.push(candidates[i]);
  }
  return picked
    .map(s => {
      const t = typeof s.outputStart === 'number' ? s.outputStart : s.sourceStart;
      const label = (s.text || '').split(/[\.!\?]/)[0].slice(0, 60);
      return `  ${fmtTimestamp(t)} — ${label}`;
    })
    .join('\n');
}

function buildPrompt(project, script, bundle) {
  const charBlock = (bundle?.characters || [])
    .map(c => `- ${c.name}: ${c.role}`)
    .join('\n') || '(unspecified)';
  const through = (bundle?.throughLines || []).join('; ');
  const allText = (script?.segments || [])
    .map(s => s.text || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 6000);
  const tsBlock = buildTimestampBlock(script);

  return `${PROMPT}

OUTPUT FORMAT: ${script?.outputFormat || 'recap'}
VIDEO TITLE (working): ${script?.title || project?.name || 'Recap'}
HOOK: ${script?.hook || ''}

BUNDLE SUMMARY:
${bundle?.arcSummary || '(no summary)'}

SPEAKERS / CHARACTERS:
${charBlock}

THROUGH LINES: ${through}

KEY NARRATION (full script flattened):
${allText}

TIMESTAMP CANDIDATES (use these in the description, one per line, prepended
to the section label):
${tsBlock}
`;
}

/**
 * @param {string} projectId
 * @param {{force?: boolean}} opts
 */
export async function generateTitlePack(projectId, { force = false } = {}) {
  const cachedPath = projectPath(projectId, 'title-pack.json');
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  if (!script?.segments?.length) throw new Error('No script — run analysis first');

  if (!force && await fileExists(cachedPath)) {
    const cached = await safeReadJson(cachedPath);
    if (cached && cached.scriptUpdatedAt === script.updatedAt) return cached;
  }

  const project = await safeReadJson(projectPath(projectId, 'project.json'));
  const bundleEnv = await safeReadJson(projectPath(projectId, 'bundle-summary.json'));
  const bundle = bundleEnv?.bundle || bundleEnv || null;

  const prompt = buildPrompt(project, script, bundle);
  const raw = await retry(
    () => textQuery(prompt, { temperature: 0.7 }),
    { maxAttempts: 2, label: 'title-generator' }
  );

  let parsed;
  try { parsed = extractJsonObject(raw); }
  catch (err) {
    logger.warn(`[titleGenerator] parse failed: ${err.message} — using fallback`);
    parsed = {
      titles: [
        script.title || project?.name || 'Recap',
        `Key takeaways from ${project?.name || 'this video'}`,
        `What you'll learn from ${project?.name || 'this'}`,
      ],
      description: script.hook || '',
      tags: ['recap', 'summary', 'takeaways'],
    };
  }

  const result = {
    titles: (parsed.titles || []).map(t => String(t).slice(0, 100)).filter(Boolean).slice(0, 5),
    description: String(parsed.description || '').slice(0, 4900),
    tags: (parsed.tags || []).map(t => String(t).toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 15),
    outputFormat: script.outputFormat || 'recap',
    scriptUpdatedAt: script.updatedAt || null,
    generatedAt: new Date().toISOString(),
  };

  await safeWriteJson(cachedPath, result);
  logger.info(`[titleGenerator] wrote ${result.titles.length} titles, ${result.description.length}ch description, ${result.tags.length} tags`);
  return result;
}

export async function loadTitlePack(projectId) {
  const cachedPath = projectPath(projectId, 'title-pack.json');
  if (!await fileExists(cachedPath)) return null;
  return safeReadJson(cachedPath);
}
