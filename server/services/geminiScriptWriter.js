import fs from 'fs/promises';
import path from 'path';
import { safeReadJson, safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { textQuery } from '../utils/textClient.js';

const PROMPT_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '..', '..', 'prompts', 'narration-script.v1.md'
);

async function getPrompt() {
  try {
    const text = await fs.readFile(PROMPT_PATH, 'utf-8');
    return text;
  } catch {
    return `Based on the following manga/manhwa chapter analyses, write a compelling narration script for a short-form video recap.

Requirements:
- Write in an engaging, dramatic narrator voice
- Break the script into segments, each corresponding to a scene or moment
- Each segment should have: text (narration), mood (emotion/tone), panelHint (which panels to show)
- Include a catchy hook for the opening
- Include a title for the video

Return as JSON: { "title": "...", "hook": "...", "segments": [{ "text": "...", "mood": "...", "panelHint": "..." }] }`;
  }
}

export async function generateScript(projectId, onProgress = () => { }, { targetWordCount, previousStorySummary = '' } = {}) {

  // Load all analyses
  const allAnalyses = await safeReadJson(projectPath(projectId, 'analysis', '_all.json'), []);
  if (allAnalyses.length === 0) throw new Error('No chapter analyses found. Run analysis first.');

  onProgress('Generating narration script...', 30);

  const prompt = await getPrompt();
  const analysisText = allAnalyses.map((a, i) =>
    `--- ${a.chapter || `Chapter ${i + 1}`} ---\n${a.analysis}`
  ).join('\n\n');

  // Build the word count hint if a target duration was provided
  const wordCountHint = targetWordCount
    ? `\n\nIMPORTANT: The target video is approximately ${targetWordCount} words long (about ${Math.round(targetWordCount / 150)} minutes at normal speaking pace). Write approximately ${targetWordCount} words of narration total across all segments.\n`
    : '';

  const contextBlock = previousStorySummary
    ? `\n\nSTORY SO FAR (previous episodes — maintain continuity, do NOT re-introduce characters already established):\n${previousStorySummary}\n`
    : '';

  const result = await retry(async () => {
    return textQuery(
      `${prompt}${contextBlock}${wordCountHint}\n\nHere are the chapter analyses:\n\n${analysisText}`,
      { temperature: 0.7 }
    );
  }, { maxAttempts: 3, label: 'script-generation' });

  onProgress('Parsing script...', 80);
  logger.debug(`Script raw response length: ${result.length} chars`);

  // Parse JSON — handle: code fences, thinking-mode preamble, raw JSON
  let script;
  try {
    // 1. Try code fence first
    const fenceMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    // 2. Fallback: first { ... } block in the response
    const objectMatch = result.match(/\{[\s\S]*\}/);
    const raw = fenceMatch ? fenceMatch[1].trim() : (objectMatch ? objectMatch[0] : null);
    if (!raw) throw new Error('No JSON found in response');
    script = JSON.parse(raw);
  } catch (parseErr) {
    logger.warn(`Script JSON parse failed (${parseErr.message}) — wrapping as single segment`);
    script = {
      title: 'Untitled',
      hook: '',
      segments: [{ text: result.replace(/```[\s\S]*?```/g, '').trim(), mood: 'dramatic', panelHint: 'all' }]
    };
  }

  // Ensure structure
  if (!script.segments) script.segments = [];
  if (!script.title) script.title = 'Untitled';
  if (!script.hook) script.hook = '';

  // Normalize segment text field -- Gemini may use narration/content/script_text instead of text
  script.segments = script.segments.map(seg => {
    if (seg.text) return seg;
    const narration = seg.narration || seg.content || seg.script_text || seg.voiceover || seg.script || '';
    return { ...seg, text: narration };
  }).filter(seg => seg.text);

  await safeWriteJson(projectPath(projectId, 'script.json'), script);
  onProgress('Script generation complete', 100);
  logger.flow(`Script generated: ${script.segments.length} segments, ${script.title}`);
  return script;
}

/**
 * Generate a concise story summary for series continuity.
 * Called after script generation when the project belongs to a series.
 */
export async function generateStorySummary(previousSummary, newAnalysisText, episodeTitle) {
  const prompt = previousSummary
    ? `You are maintaining a running story summary for a manga/manhwa series.

Previous summary:
${previousSummary}

New episode "${episodeTitle}" analysis:
${newAnalysisText}

Update the summary to include events from this new episode. Keep it under 400 words. Focus on: key characters introduced, major plot events, current story state, and unresolved conflicts. Write in present tense.`
    : `Summarize this manga/manhwa episode in under 300 words for series continuity tracking.
Focus on: key characters, major plot events, current story state, unresolved conflicts.
Write in present tense.

Episode "${episodeTitle}" analysis:
${newAnalysisText}`;

  return textQuery(prompt, { temperature: 0.3 });
}
