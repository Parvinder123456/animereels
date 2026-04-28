import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { ensureDir, listImages, projectPath } from '../utils/fileHelpers.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { visionQuery } from '../utils/visionClient.js';

const DETECT_PROMPT = `You are analyzing a manga or manhwa page image. Identify every individual panel (comic frame) visible on this page.

For each panel provide its bounding box as normalized coordinates where 0,0 is the top-left corner and 1,1 is the bottom-right corner of the entire page.

Reading order rules:
- Japanese manga: right-to-left within each row, rows go top-to-bottom
- Manhwa / webtoon (single vertical column): top-to-bottom
- Western / English comics: left-to-right, top-to-bottom

Respond with ONLY a raw JSON array — no explanation, no markdown, no code fences.
Each element must have keys x, y, w, h as decimal fractions.
Example: [{"x":0.0,"y":0.0,"w":1.0,"h":0.45},{"x":0.5,"y":0.47,"w":0.5,"h":0.53}]`;

function getMimeType(filePath) {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function parseResponse(text, pageWidth, pageHeight) {
  let json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const match = json.match(/\[[\s\S]*\]/);
  if (!match) return null;

  let arr;
  try { arr = JSON.parse(match[0]); } catch { return null; }
  if (!Array.isArray(arr) || arr.length === 0) return null;

  return arr
    .filter(p => ['x', 'y', 'w', 'h'].every(k => typeof p[k] === 'number'))
    .map(p => ({
      x: Math.max(0, Math.round(p.x * pageWidth)),
      y: Math.max(0, Math.round(p.y * pageHeight)),
      w: Math.min(pageWidth, Math.round(p.w * pageWidth)),
      h: Math.min(pageHeight, Math.round(p.h * pageHeight)),
    }))
    .filter(p => p.w >= 20 && p.h >= 20);
}

async function detectOnePage(imagePath) {
  const { width, height } = await sharp(imagePath).metadata();

  try {
    const imageBuffer = await fs.readFile(imagePath);
    const mimeType = getMimeType(imagePath);

    const text = await retry(async () => {
      return visionQuery(DETECT_PROMPT, imageBuffer, mimeType);
    }, { maxAttempts: 3, label: `panel-detect-${path.basename(imagePath)}` });

    const panels = parseResponse(text, width, height);
    if (panels && panels.length > 0) {
      logger.debug(`${path.basename(imagePath)}: ${panels.length} panels detected`);
      return { panels, width, height };
    }
    logger.warn(`${path.basename(imagePath)}: Gemini returned no valid panels, using full-page fallback`);
  } catch (err) {
    logger.warn(`Panel detection failed for ${path.basename(imagePath)}: ${err.message}`);
  }

  // Fallback: whole page as single panel
  return { panels: [{ x: 0, y: 0, w: width, h: height }], width, height };
}

/**
 * Run AI panel detection on all chapter pages for a project.
 * Re-crops panel images and writes panels/metadata.json.
 * This replaces any earlier pixel-based metadata.
 */
export async function detectAllPanels(projectId, onProgress = () => {}, format = 'manga') {
  if (!process.env.OLLAMA_MODEL && !process.env.GEMINI_API_KEY) {
    throw new Error('Set OLLAMA_MODEL (local) or GEMINI_API_KEY (cloud) in .env');
  }

  const chaptersDir = projectPath(projectId, 'chapters');
  const panelsDir = projectPath(projectId, 'panels');
  await ensureDir(panelsDir);

  const pages = await listImages(chaptersDir);
  if (pages.length === 0) throw new Error('No chapter images found');

  const isWebtoon = format === 'webtoon';
  logger.flow(`AI panel detection: ${pages.length} pages (format: ${format})`);

  const allMeta = [];

  for (let i = 0; i < pages.length; i++) {
    const pagePath = pages[i];
    const pageFile = path.basename(pagePath);
    const pageBase = path.basename(pagePath, path.extname(pagePath));

    onProgress(
      `Detecting panels: ${pageFile} (${i + 1}/${pages.length})`,
      Math.round((i / pages.length) * 90)
    );

    // Webtoon: bypass AI detection, use single full-page panel
    let panels, width, height;
    if (isWebtoon) {
      const meta = await sharp(pagePath).metadata();
      width = meta.width;
      height = meta.height;
      panels = [{ x: 0, y: 0, w: width, h: height }];
    } else {
      ({ panels, width, height } = await detectOnePage(pagePath));
    }

    for (let p = 0; p < panels.length; p++) {
      const rect = panels[p];
      const panelFile = `${pageBase}_panel_${String(p + 1).padStart(3, '0')}.png`;
      const panelPath = path.join(panelsDir, panelFile);

      // Clamp rect to valid image bounds before cropping
      const left = Math.max(0, rect.x);
      const top = Math.max(0, rect.y);
      const cropW = Math.min(rect.w, width - left);
      const cropH = Math.min(rect.h, height - top);

      if (cropW > 0 && cropH > 0) {
        await sharp(pagePath)
          .extract({ left, top, width: cropW, height: cropH })
          .png()
          .toFile(panelPath);
      }

      allMeta.push({
        panelFile,
        pageFile,
        pageWidth: width,
        pageHeight: height,
        rect: { x: left, y: top, w: cropW, h: cropH },
      });
    }
  }

  await fs.writeFile(
    path.join(panelsDir, 'metadata.json'),
    JSON.stringify(allMeta, null, 2)
  );

  onProgress('AI panel detection complete', 100);
  logger.flow(`Detection complete: ${allMeta.length} panels from ${pages.length} pages`);
  return allMeta.length;
}
