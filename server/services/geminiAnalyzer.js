import fs from 'fs/promises';
import path from 'path';
import { ensureDir, listImages, safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { visionQueryBatch, visionBatchSize } from '../utils/visionClient.js';
import { getSettings } from '../utils/appSettings.js';

const PROMPT_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '..', '..', 'prompts', 'chapter-analysis.v1.md'
);

async function getPrompt() {
  try {
    const text = await fs.readFile(PROMPT_PATH, 'utf-8');
    return text;
  } catch {
    return `Analyze these manhwa chapter pages as a complete story. Describe characters, dialogue, plot progression, and emotional beats across all pages.`;
  }
}

/**
 * Determine MIME type from file extension.
 */
function getMimeType(filePath) {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Split an array into chunks of a given size.
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Analyze all chapter images by sending them in batches to Gemini
 * so the model can understand the full story arc across pages.
 *
 * Gemini supports multiple images per request. We batch pages together
 * (up to 20 per call to stay within limits) so the model sees the
 * narrative flow rather than isolated pages.
 */
export async function analyzeChapters(projectId, onProgress = () => { }, { previousStorySummary = '' } = {}) {
  const { visionBackend } = await getSettings();
  if (visionBackend === 'gemini' && !process.env.GEMINI_API_KEY)
    throw new Error('GEMINI_API_KEY not set in .env');
  if (visionBackend === 'groq' && !process.env.GROQ_API_KEY)
    throw new Error('GROQ_API_KEY not set in .env');

  const chaptersDir = projectPath(projectId, 'chapters');
  const analysisDir = projectPath(projectId, 'analysis');
  await ensureDir(analysisDir);

  const images = await listImages(chaptersDir);
  if (images.length === 0) throw new Error('No chapter images found');

  const prompt = await getPrompt();

  // Local models need smaller batches (slower but more reliable); cloud can handle more
  const BATCH_SIZE = await visionBatchSize();
  logger.info(`[Analysis] Batch size: ${BATCH_SIZE} images/batch`);
  const batches = chunk(images, BATCH_SIZE);
  const allAnalyses = [];
  let blockedBatches = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchStart = b * BATCH_SIZE;
    const batchLabel = batches.length === 1
      ? 'all pages'
      : `pages ${batchStart + 1}-${batchStart + batch.length}`;

    onProgress(
      `Analyzing ${batchLabel} (${batch.length} images)...`,
      Math.round((b / batches.length) * 90)
    );

    let result;
    try {
      result = await retry(async () => {
        const contextBlock = previousStorySummary
          ? `\n\nSTORY SO FAR (previous episodes):\n${previousStorySummary}\n\nContinue analyzing from where the story left off.`
          : '';
        const batchPrompt = `${prompt}${contextBlock}\n\nThis batch contains ${batch.length} consecutive pages (pages ${batchStart + 1} to ${batchStart + batch.length}). Analyze them as a cohesive story sequence.`;
        const pageImages = await Promise.all(batch.map(async imgPath => ({
          buffer: await fs.readFile(imgPath),
          mimeType: getMimeType(imgPath),
        })));
        return visionQueryBatch(batchPrompt, pageImages);
      }, { maxAttempts: 3, label: `analyze-batch-${b + 1}` });
    } catch (err) {
      // Gemini may block batches with graphic content (OTHER reason) — skip and continue
      blockedBatches++;
      logger.warn(`Batch ${b + 1} blocked/failed — skipping (${err.message})`);
      result = `[Pages ${batchStart + 1}-${batchStart + batch.length}: content blocked by AI filter — panels will still be included in video]`;
    }

    const batchEntry = {
      chapter: `batch_${b + 1}_pages_${batchStart + 1}_to_${batchStart + batch.length}`,
      pages: batch.map(img => path.basename(img, path.extname(img))),
      analysis: result,
    };

    allAnalyses.push(batchEntry);
    await safeWriteJson(path.join(analysisDir, `batch_${b + 1}.json`), batchEntry);
    logger.debug(`Analyzed batch ${b + 1}: ${batch.length} pages`);
  }

  if (blockedBatches > 0) {
    logger.warn(`${blockedBatches}/${batches.length} batches were blocked — switch to Local (Ollama) in the AI backend dropdown for full analysis`);
  }

  await safeWriteJson(projectPath(projectId, 'analysis', '_all.json'), allAnalyses);
  onProgress('Chapter analysis complete', 100);
  logger.flow(`Analysis complete: ${images.length} pages in ${batches.length} batch(es)`);
  return allAnalyses;
}
