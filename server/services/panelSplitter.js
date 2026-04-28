import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { ensureDir, listImages, projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const CONFIG = {
  // Horizontal separator detection
  darkRowThreshold: 100,
  whiteRowThreshold: 200,
  minGapHeight: 5,
  maxGapHeight: 60,
  minPanelHeight: 80,
  darkRowRatio: 0.60,
  whiteRowRatio: 0.85,
  // Vertical separator detection (side-by-side panels within a row band)
  whiteColRatio: 0.85,
  minColGapWidth: 3,
  maxColGapWidth: 80,
  minPanelWidth: 50,
};

function classifyRows(data, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    let sum = 0, darkCount = 0, whiteCount = 0;
    for (let x = 0; x < width; x++) {
      const val = data[offset + x];
      sum += val;
      if (val < CONFIG.darkRowThreshold) darkCount++;
      if (val > CONFIG.whiteRowThreshold) whiteCount++;
    }
    rows.push({
      avg: sum / width,
      isDark: (darkCount / width) >= CONFIG.darkRowRatio,
      isWhite: (whiteCount / width) >= CONFIG.whiteRowRatio,
    });
  }
  return rows;
}

function findSeparators(rows, height) {
  const separators = [];
  let i = 0;
  while (i < height) {
    if (!rows[i].isDark) { i++; continue; }
    const darkStart1 = i;
    while (i < height && rows[i].isDark) i++;

    const gapStart = i;
    while (i < height && rows[i].isWhite) i++;
    const gapEnd = i;

    const gapHeight = gapEnd - gapStart;
    if (gapHeight < CONFIG.minGapHeight || gapHeight > CONFIG.maxGapHeight) continue;

    if (i < height && rows[i].isDark) {
      while (i < height && rows[i].isDark) i++;
      separators.push({
        splitY: Math.round((gapStart + gapEnd) / 2),
        topBorder: darkStart1,
        gapStart,
        gapEnd,
        bottomBorder: i,
      });
    }
  }
  return separators;
}

/**
 * Find vertical (column) separators within a horizontal row band.
 * Detects white gutters between side-by-side panels (manhwa columns, etc.).
 */
function findColumnSeparators(data, width, rowStart, rowEnd) {
  const bandHeight = rowEnd - rowStart;
  if (bandHeight <= 0) return [];

  const colIsWhite = [];
  for (let x = 0; x < width; x++) {
    let whiteCount = 0;
    for (let y = rowStart; y < rowEnd; y++) {
      if (data[y * width + x] > CONFIG.whiteRowThreshold) whiteCount++;
    }
    colIsWhite.push(whiteCount / bandHeight >= CONFIG.whiteColRatio);
  }

  const separators = [];
  let i = 0;
  while (i < width) {
    if (!colIsWhite[i]) { i++; continue; }
    const gapStart = i;
    while (i < width && colIsWhite[i]) i++;
    const gapWidth = i - gapStart;
    if (gapWidth >= CONFIG.minColGapWidth && gapWidth <= CONFIG.maxColGapWidth) {
      separators.push({ splitX: Math.round((gapStart + i) / 2) });
    }
  }
  return separators;
}

/**
 * Detect panels in a page image.
 * Returns 2D bounding boxes { x, y, w, h } in pixel coordinates.
 */
async function detectPanels(imagePath) {
  const image = sharp(imagePath);
  const { width, height } = await image.metadata();

  const { data } = await image.grayscale().raw().toBuffer({ resolveWithObject: true });
  const rows = classifyRows(data, width, height);
  const hSeparators = findSeparators(rows, height);

  // Build horizontal row bands with leading/trailing trim on first and last
  const bands = [];
  if (hSeparators.length === 0) {
    bands.push({ top: 0, bottom: height });
  } else {
    let firstTop = 0;
    while (firstTop < hSeparators[0].topBorder && (rows[firstTop].isWhite || rows[firstTop].isDark)) firstTop++;
    if (firstTop >= hSeparators[0].topBorder) firstTop = 0;
    bands.push({ top: firstTop, bottom: hSeparators[0].gapStart });

    for (let s = 0; s < hSeparators.length - 1; s++) {
      bands.push({ top: hSeparators[s].gapEnd, bottom: hSeparators[s + 1].gapStart });
    }

    const lastSep = hSeparators[hSeparators.length - 1];
    let lastEnd = height;
    while (lastEnd > lastSep.gapEnd && (rows[lastEnd - 1].isWhite || rows[lastEnd - 1].isDark)) lastEnd--;
    if (lastEnd <= lastSep.gapEnd) lastEnd = height;
    bands.push({ top: lastSep.gapEnd, bottom: lastEnd });
  }

  // Within each row band find vertical separators (side-by-side panels)
  const panels = [];
  for (const band of bands) {
    if (band.bottom - band.top < CONFIG.minPanelHeight) continue;
    const vSeps = findColumnSeparators(data, width, band.top, band.bottom);

    if (vSeps.length === 0) {
      panels.push({ x: 0, y: band.top, w: width, h: band.bottom - band.top });
    } else {
      let colStart = 0;
      for (const sep of vSeps) {
        if (sep.splitX - colStart >= CONFIG.minPanelWidth) {
          panels.push({ x: colStart, y: band.top, w: sep.splitX - colStart, h: band.bottom - band.top });
        }
        colStart = sep.splitX;
      }
      if (width - colStart >= CONFIG.minPanelWidth) {
        panels.push({ x: colStart, y: band.top, w: width - colStart, h: band.bottom - band.top });
      }
    }
  }

  if (panels.length === 0) panels.push({ x: 0, y: 0, w: width, h: height });

  return { panels, width, height };
}

/**
 * Split all chapter images into panels for a project.
 * Saves cropped panel PNGs to panels/ and writes panels/metadata.json
 * so the video renderer can zoom into original-page coordinates.
 */
export async function splitAllChapters(projectId, onProgress = () => {}, format = 'manga') {
  const chaptersDir = projectPath(projectId, 'chapters');
  const panelsDir = projectPath(projectId, 'panels');
  await ensureDir(panelsDir);

  const images = await listImages(chaptersDir);
  if (images.length === 0) {
    throw new Error('No chapter images found. Please upload chapter images first.');
  }

  const isWebtoon = format === 'webtoon';
  logger.flow(`Splitting ${images.length} chapter images into panels (format: ${format})`);
  let totalPanels = 0;
  const allMeta = [];

  for (let i = 0; i < images.length; i++) {
    const imgPath = images[i];
    const imgName = path.basename(imgPath, path.extname(imgPath));
    const imgFile = path.basename(imgPath);
    onProgress(`Processing ${imgFile}...`, Math.round((i / images.length) * 100));

    try {
      let panels, width, height;

      if (isWebtoon) {
        // Webtoon: treat entire page as single panel — no gutter detection
        const meta = await sharp(imgPath).metadata();
        width = meta.width;
        height = meta.height;
        panels = [{ x: 0, y: 0, w: width, h: height }];
      } else {
        ({ panels, width, height } = await detectPanels(imgPath));
      }

      for (let p = 0; p < panels.length; p++) {
        const panel = panels[p];
        const outputName = `${imgName}_panel_${String(p + 1).padStart(3, '0')}.png`;
        const outputPath = path.join(panelsDir, outputName);

        await sharp(imgPath)
          .extract({ left: panel.x, top: panel.y, width: panel.w, height: panel.h })
          .png()
          .toFile(outputPath);

        allMeta.push({
          panelFile: outputName,
          pageFile: imgFile,
          pageWidth: width,
          pageHeight: height,
          rect: panel,
        });

        totalPanels++;
      }

      logger.debug(`${imgFile}: ${panels.length} panels`);
    } catch (err) {
      logger.warn(`Failed to split ${path.basename(imgPath)}: ${err.message}`);
    }
  }

  // Write metadata so video renderer can do zoom-to-rect Ken Burns
  await fs.writeFile(
    path.join(panelsDir, 'metadata.json'),
    JSON.stringify(allMeta, null, 2)
  );

  onProgress(`Done! ${totalPanels} panels extracted`, 100);
  logger.flow(`Panel splitting complete: ${totalPanels} panels from ${images.length} images`);
  return totalPanels;
}
