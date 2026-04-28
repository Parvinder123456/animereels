import fs from 'fs/promises';
import path from 'path';
import { ensureDir, listImages, safeReadJson, safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { visionQuery } from '../utils/visionClient.js';
import { retry } from '../utils/retry.js';
import { analyzeWebtoonStrip, buildScrollPath } from './webtoonCamera.js';
import { logger } from '../utils/logger.js';

/**
 * Prompt sent to Gemini Vision for each chapter page (manga mode).
 * Asks for 2-4 focus regions with normalised bounding boxes.
 */
const FOCUS_PROMPT = `You are a professional manga/manhwa video editor creating a cinematic recap video. Analyze this comic page and identify the 3-4 most visually STRIKING regions a camera should zoom into.

For each region, return:
- x, y: top-left corner as a fraction of image width/height (0.0 to 1.0)
- w, h: width and height as a fraction of image width/height (0.0 to 1.0)
- label: brief description

PRIORITY ORDER (most important first):
1. Character FACES and EXPRESSIONS (close-ups — the most important!)
2. Action impacts, punches, explosions, dramatic poses
3. Monster/villain reveals and transformations
4. Key emotional dialogue panels

STRICT RULES:
- NEVER include title cards, chapter headers, logos, or decorative text
- NEVER include credits, author names, or publisher info
- Each region must be TIGHT — focus on ONE face or ONE action moment
- Maximum region size: w ≤ 0.5 and h ≤ 0.4 (zoom IN, don't show the whole page)
- Regions must NOT overlap more than 20%
- If a panel has a character face, crop JUST the face (w ~0.3, h ~0.25)
- Order in story reading order (top-to-bottom for webtoons)

Return ONLY valid JSON array, no markdown:
[
  { "x": 0.15, "y": 0.05, "w": 0.35, "h": 0.25, "label": "character shocked face" },
  { "x": 0.2, "y": 0.4, "w": 0.5, "h": 0.3, "label": "action impact" }
]`;

// ─── Parallel execution helper ────────────────────────────────────────────────

async function parallelMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Detect focus regions for all chapter pages in a project.
 * In manga mode: calls Gemini for bounding-box regions.
 * In webtoon mode: calls Gemini for interest points + builds scroll path.
 * Results are cached to focus_regions.json.
 *
 * @param {string} projectId
 * @param {Function} onProgress
 * @param {string} format  'manga' | 'webtoon'
 * @returns {Object} Map of pageFile → focus data
 */
export async function detectFocusRegions(projectId, onProgress = () => { }, format = 'manga') {
  const chaptersDir = projectPath(projectId, 'chapters');
  const cacheFile = projectPath(projectId, 'panels', 'focus_regions.json');

  // Return cached results if available
  const cached = await safeReadJson(cacheFile);
  if (cached && Object.keys(cached).length > 0) {
    logger.flow(`Focus regions loaded from cache: ${Object.keys(cached).length} pages`);
    return cached;
  }

  const images = await listImages(chaptersDir);
  if (images.length === 0) {
    logger.warn('No chapter images for focus detection');
    return {};
  }

  await ensureDir(projectPath(projectId, 'panels'));

  const isWebtoon = format === 'webtoon';
  const focusMap = {};
  let done = 0;

  // Concurrency=4 respects Gemini free-tier rate limit (~15 RPM)
  await parallelMap(images, async (imgPath, i) => {
    const imgFile = path.basename(imgPath);

    try {
      if (isWebtoon) {
        // ── Webtoon mode: AI interest points → scroll path ──────────────────
        logger.info(`[detectFocusRegions] ${imgFile} (${done+1}/${images.length}) — webtoon mode, calling analyzeWebtoonStrip`);
        const interestPoints = await retry(async () => {
          return analyzeWebtoonStrip(imgPath);
        }, { maxAttempts: 2, label: `webtoon-focus-${imgFile}` });

        logger.info(`[detectFocusRegions] ${imgFile}: got ${interestPoints?.length ?? 0} interest point(s) from Gemini`);
        const scrollPath = buildScrollPath(interestPoints, 10); // placeholder duration, rebuilt at render time
        logger.info(`[detectFocusRegions] ${imgFile}: placeholder scroll path has ${scrollPath.length} keyframe(s)`);
        focusMap[imgFile] = { isWebtoon: true, regions: interestPoints || [], scrollPath };
      } else {
        // ── Manga mode: AI bounding-box regions ─────────────────────────────
        const imgBuffer = await fs.readFile(imgPath);
        const mimeType = imgPath.endsWith('.png') ? 'image/png'
          : imgPath.endsWith('.webp') ? 'image/webp'
            : 'image/jpeg';

        const raw = await retry(async () => {
          return visionQuery(FOCUS_PROMPT, imgBuffer, mimeType);
        }, { maxAttempts: 2, label: `focus-${imgFile}` });

        const regions = parseFocusResponse(raw, imgFile);
        focusMap[imgFile] = { regions };
        logger.debug(`${imgFile}: ${regions.length} focus regions detected`);
      }
    } catch (err) {
      logger.warn(`Focus detection failed for ${imgFile}: ${err.message}`);
      if (isWebtoon) {
        focusMap[imgFile] = { isWebtoon: true, regions: [], scrollPath: null };
      } else {
        focusMap[imgFile] = { regions: defaultRegions() };
      }
    }

    done++;
    onProgress(`Detecting focus regions: ${imgFile} (${done}/${images.length})...`,
      Math.round((done / images.length) * 100));
  }, 4);

  // Cache results
  await safeWriteJson(cacheFile, focusMap);
  onProgress('Focus detection complete', 100);
  logger.flow(`Focus regions detected for ${Object.keys(focusMap).length} pages`);
  return focusMap;
}

/**
 * Parse the Gemini Vision response into validated focus regions.
 */
function parseFocusResponse(raw, fileName) {
  try {
    // Handle code fences
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : (arrayMatch ? arrayMatch[0] : null);
    if (!jsonStr) throw new Error('No JSON array found');

    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Empty array');

    // Validate, clamp, and enforce tight regions
    const MAX_W = 0.55;  // max 55% of page width
    const MAX_H = 0.45;  // max 45% of page height

    const validated = arr
      .filter(r => typeof r.x === 'number' && typeof r.y === 'number' &&
        typeof r.w === 'number' && typeof r.h === 'number')
      .map(r => ({
        x: clamp(r.x, 0, 0.95),
        y: clamp(r.y, 0, 0.95),
        w: clamp(r.w, 0.05, MAX_W),
        h: clamp(r.h, 0.05, MAX_H),
        label: String(r.label || 'focus region').slice(0, 80),
      }))
      // Filter out likely title/header regions (top 8% of page, very wide)
      .filter(r => !(r.y < 0.08 && r.w > 0.6 && r.h < 0.12))
      .slice(0, 5);

    // If an oversized region slipped through, split it into two halves
    const result = [];
    for (const r of validated) {
      if (r.w * r.h > 0.2) {
        const halfH = r.h / 2;
        result.push({ ...r, h: halfH, label: r.label + ' (top)' });
        result.push({ ...r, y: r.y + halfH, h: halfH, label: r.label + ' (bottom)' });
      } else {
        result.push(r);
      }
    }
    return result.slice(0, 5);
  } catch (err) {
    logger.warn(`Parse focus failed for ${fileName}: ${err.message}`);
    return defaultRegions();
  }
}

/**
 * Fallback regions when AI detection fails: top third, middle third, bottom third.
 */
function defaultRegions() {
  return [
    { x: 0.1, y: 0.02, w: 0.45, h: 0.3, label: 'top panel' },
    { x: 0.1, y: 0.35, w: 0.45, h: 0.3, label: 'middle panel' },
    { x: 0.1, y: 0.65, w: 0.45, h: 0.3, label: 'bottom panel' },
  ];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
