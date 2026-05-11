import path from 'path';
import { logger } from '../utils/logger.js';

// Minimum time a panel must be visible. If a segment is too short to show all
// its assigned panels at this duration, panels are dropped (not squashed).
const MIN_PANEL_DURATION = 2.5;

// Hard cap on panels shown per script segment. Even if 8 panels were split from
// the hinted pages, we only show 3 so the viewer can absorb each one.
const MAX_PANELS_PER_SEGMENT = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a panelHint string to extract ALL referenced page numbers.
 * Handles: "Page 12", "Pages 4-5", "Pages 8, 13-15", "Pages 18-19, then Page 38"
 *
 * Strategy: scan the full string for any "page(s)" keyword or "," token followed
 * by a number (optionally a range). This catches multi-reference hints like
 * "Pages 8, 13-15 - text, then Page 38 - more text".
 */
function parsePanelHint(hint) {
  if (!hint) return [];
  const re = /(?:pages?|,)\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi;
  const pages = new Set();
  let m;
  while ((m = re.exec(hint)) !== null) {
    const start = parseInt(m[1], 10);
    if (m[2]) {
      const end = parseInt(m[2], 10);
      // Sanity cap: don't expand "1-200" style accidents
      if (end - start < 30) for (let p = start; p <= end; p++) pages.add(p);
    } else {
      pages.add(start);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Derive the chapter page filename from a panel path.
 * "05_panel_001.png" → "05.png"
 */
function panelToPageFile(panelPath) {
  const base = path.basename(panelPath);
  const match = base.match(/^(\d+)_panel_/);
  if (match) return match[1] + '.png';
  return base;
}

// ─── Panel Selection ──────────────────────────────────────────────────────────

/**
 * Build a map from page number → sorted array of panel paths.
 * Handles both split panels ("05_panel_001.png") and full-page images ("05.png").
 */
function buildPageMap(allPanelPaths) {
  const pageMap = new Map();
  for (const p of allPanelPaths) {
    const base = path.basename(p);
    const splitMatch = base.match(/^(\d+)_panel_/);
    const pageMatch = base.match(/^(\d+)\./);
    const pageNum = splitMatch
      ? parseInt(splitMatch[1], 10)
      : pageMatch ? parseInt(pageMatch[1], 10) : null;
    if (pageNum !== null) {
      if (!pageMap.has(pageNum)) pageMap.set(pageNum, []);
      pageMap.get(pageNum).push(p);
    }
  }
  for (const panels of pageMap.values()) panels.sort();
  return pageMap;
}

/**
 * Given a desired page number, return panels for that page.
 *
 * Resolution order:
 *  1. Exact match — panel file is literally numbered pageNum.
 *  2. Index fallback — treat pageNum as a 1-based index into sortedPages.
 *     This handles the common case where the AI writes "Page 3" meaning
 *     "the 3rd page I analyzed" but the actual files start at 31, 100, etc.
 *  3. Nearest absolute — last resort for edge cases.
 */
function panelsForPage(pageNum, pageMap, sortedPages) {
  if (pageMap.has(pageNum)) return [...pageMap.get(pageNum)];

  // Index-based: treat hint as 1-based position in available pages
  const idx = Math.min(pageNum - 1, sortedPages.length - 1);
  if (idx >= 0) return [...pageMap.get(sortedPages[idx])];

  return [];
}

/**
 * Select and assign panels to each segment based on panelHint.
 *
 * Returns segmentPanels: an array (one entry per segment) of panel path arrays.
 * segmentPanels[i] = the panels that should be shown during segment i.
 *
 * Rules:
 *  - Segment has panelHint → use panels from those pages (capped to MAX_PANELS_PER_SEGMENT)
 *  - Segment has no hint  → advance to the next sequential page
 *  - No segment has a hint → one representative panel per page, spread across segments
 */
function selectPanelsForTimeline(segments, allPanelPaths) {
  const pageMap = buildPageMap(allPanelPaths);
  const sortedPages = [...pageMap.keys()].sort((a, b) => a - b);

  logger.info(`[selectPanels] ${allPanelPaths.length} panel files, ${sortedPages.length} unique pages: [${sortedPages.slice(0, 10).join(', ')}${sortedPages.length > 10 ? '...' : ''}]`);

  const anyHint = segments.some(s => parsePanelHint(s.panelHint).length > 0);
  logger.info(`[selectPanels] panelHints present: ${anyHint}`);

  if (!anyHint) {
    // No hints at all — use the first (most impactful) panel from each page,
    // then distribute pages evenly across segments.
    const repPanels = sortedPages.map(pNum => pageMap.get(pNum)[0]);
    logger.info(`[selectPanels] No hints — using ${repPanels.length} representative panels spread across ${segments.length} segments`);

    return segments.map((_, i) => {
      const startIdx = Math.floor((i / segments.length) * repPanels.length);
      const endIdx = Math.floor(((i + 1) / segments.length) * repPanels.length);
      const slice = repPanels.slice(startIdx, endIdx);
      return slice.length > 0 ? slice : [repPanels[Math.min(i, repPanels.length - 1)]];
    });
  }

  // Hint-driven selection
  const segmentPanels = [];
  let lastAssignedPageIdx = 0;

  for (let i = 0; i < segments.length; i++) {
    const hintPages = parsePanelHint(segments[i].panelHint);
    let panels = [];

    if (hintPages.length > 0) {
      for (const pageNum of hintPages) {
        panels.push(...panelsForPage(pageNum, pageMap, sortedPages));
      }
      // Advance the sequential cursor to the last hinted page
      const lastHint = Math.max(...hintPages);
      const idx = sortedPages.findIndex(p => p >= lastHint);
      if (idx >= 0) lastAssignedPageIdx = idx;

      logger.info(`[selectPanels] Segment ${i + 1}: hint="${segments[i].panelHint}" → pages [${hintPages.join(',')}] → ${panels.length} panel(s)`);
    } else {
      // Advance one page past the last assigned
      lastAssignedPageIdx = Math.min(lastAssignedPageIdx + 1, sortedPages.length - 1);
      const nextPage = sortedPages[lastAssignedPageIdx];
      panels = nextPage !== undefined ? panelsForPage(nextPage, pageMap, sortedPages) : [];
      logger.info(`[selectPanels] Segment ${i + 1}: no hint → sequential page ${nextPage} → ${panels.length} panel(s)`);
    }

    // Evenly subsample down to MAX_PANELS_PER_SEGMENT
    if (panels.length > MAX_PANELS_PER_SEGMENT) {
      const step = panels.length / MAX_PANELS_PER_SEGMENT;
      panels = Array.from({ length: MAX_PANELS_PER_SEGMENT }, (_, k) =>
        panels[Math.min(Math.floor(k * step), panels.length - 1)]
      );
      logger.info(`[selectPanels] Segment ${i + 1}: subsampled to ${panels.length} panel(s)`);
    }

    segmentPanels.push(panels);
  }

  // ── Variety check ────────────────────────────────────────────────────────────
  // If hint resolution produced fewer than 2 unique panels (all segments collapsed
  // to the same 1-2 images because panelHints referenced non-existent pages),
  // fall back to evenly distributing ALL available panels across segments.
  const uniquePanels = new Set(segmentPanels.flat());
  if (uniquePanels.size < Math.min(2, sortedPages.length) && allPanelPaths.length > 1) {
    logger.warn(`[selectPanels] Only ${uniquePanels.size} unique panel(s) from hints — hint pages likely don't match actual pages. Falling back to even distribution.`);
    const repPanels = sortedPages.map(pNum => pageMap.get(pNum)[0]);
    return segments.map((_, i) => {
      const startIdx = Math.floor((i / segments.length) * repPanels.length);
      const endIdx = Math.floor(((i + 1) / segments.length) * repPanels.length);
      const slice = repPanels.slice(startIdx, endIdx);
      return slice.length > 0 ? slice : [repPanels[Math.min(i, repPanels.length - 1)]];
    });
  }

  const total = segmentPanels.reduce((s, p) => s + p.length, 0);
  logger.info(`[selectPanels] Selection complete: ${total} panels across ${segments.length} segments (was ${allPanelPaths.length}), ${uniquePanels.size} unique`);

  return segmentPanels;
}

// ─── Timeline builders ────────────────────────────────────────────────────────

/**
 * Build timeline using segment boundary timestamps (most accurate).
 * Each segment's panels are timed exactly to the narration audio for that segment.
 * Panels are dropped (never squashed) if the segment is too short for MIN_PANEL_DURATION.
 */
function buildBoundaryTimeline(segments, segmentPanels, words, boundaries) {
  const timeline = [];

  for (const b of boundaries) {
    if (b.endTime <= b.startTime) continue;
    const segment = segments[b.segmentIndex] || {};
    const panels = segmentPanels[b.segmentIndex] || [];
    if (panels.length === 0) {
      logger.warn(`[buildBoundaryTimeline] Segment ${b.segmentIndex + 1} has no panels, skipping`);
      continue;
    }

    const segDuration = b.endTime - b.startTime;
    // How many panels fit at MIN_PANEL_DURATION?
    const maxByDuration = Math.max(1, Math.floor(segDuration / MIN_PANEL_DURATION));
    const panelCount = Math.min(panels.length, maxByDuration);
    const panelDuration = segDuration / panelCount;

    logger.info(`[buildBoundaryTimeline] Segment ${b.segmentIndex + 1}: ${segDuration.toFixed(2)}s, ${panels.length} panel(s) selected, showing ${panelCount}, each ${panelDuration.toFixed(2)}s`);

    for (let p = 0; p < panelCount; p++) {
      const pStart = b.startTime + p * panelDuration;
      const pEnd = b.startTime + (p + 1) * panelDuration;
      timeline.push({
        panelPath: panels[p],
        startTime: +pStart.toFixed(3),
        endTime: +pEnd.toFixed(3),
        words: words.filter(w => w.start >= pStart && w.start < pEnd),
        mood: segment.mood || 'dramatic',
        pageFile: panelToPageFile(panels[p]),
        hintPages: parsePanelHint(segment.panelHint),
      });
    }
  }

  return timeline;
}

/**
 * Build timeline from character-position fractions (fallback when no boundaries).
 */
function buildNaturalTimeline(segments, segmentPanels, words, totalDuration) {
  const timeline = [];
  const totalChars = segments.reduce((sum, s) => sum + (s.text || '').length, 0);
  let charOffset = 0;

  for (let si = 0; si < segments.length; si++) {
    const segment = segments[si];
    const segText = (segment.text || '').trim();
    const panels = segmentPanels[si] || [];

    if (!segText || panels.length === 0) {
      charOffset += (segment.text || '').length;
      if (panels.length === 0) logger.warn(`[buildNaturalTimeline] Segment ${si + 1} has no panels, skipping`);
      continue;
    }

    const segChars = (segment.text || '').length;
    const startFraction = totalChars > 0 ? charOffset / totalChars : 0;
    const endFraction = totalChars > 0 ? (charOffset + segChars) / totalChars : 1;
    charOffset += segChars;

    const segStartWordIdx = Math.min(Math.round(startFraction * words.length), words.length - 1);
    const segEndWordIdx = Math.min(Math.round(endFraction * words.length), words.length);

    const segStart = words[segStartWordIdx]?.start ?? (startFraction * totalDuration);
    const segEnd = words[Math.max(segEndWordIdx - 1, segStartWordIdx)]?.end ?? (endFraction * totalDuration);
    const segDuration = segEnd - segStart;

    const maxByDuration = Math.max(1, Math.floor(segDuration / MIN_PANEL_DURATION));
    const panelCount = Math.min(panels.length, maxByDuration);
    const panelDuration = segDuration / panelCount;

    logger.info(`[buildNaturalTimeline] Segment ${si + 1}: ${segDuration.toFixed(2)}s, ${panels.length} panel(s), showing ${panelCount}, each ${panelDuration.toFixed(2)}s`);

    for (let p = 0; p < panelCount; p++) {
      const pStart = segStart + p * panelDuration;
      const pEnd = segStart + (p + 1) * panelDuration;
      timeline.push({
        panelPath: panels[p],
        startTime: +pStart.toFixed(3),
        endTime: +pEnd.toFixed(3),
        words: words.filter(w => w.start >= pStart && w.start < pEnd),
        mood: segment.mood || 'dramatic',
        pageFile: panelToPageFile(panels[p]),
        hintPages: parsePanelHint(segment.panelHint),
      });
    }
  }

  return timeline;
}

// ─── Gap filling & scaling ────────────────────────────────────────────────────

/**
 * Close any gaps between entries and extend the last entry to cover the full duration.
 */
function fillAndExtend(timeline, fullDuration) {
  if (!timeline.length) return timeline;
  const result = timeline.map(e => ({ ...e }));
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].endTime < result[i + 1].startTime) {
      result[i].endTime = result[i + 1].startTime;
    }
  }
  const last = result[result.length - 1];
  if (fullDuration && last.endTime < fullDuration) {
    last.endTime = +fullDuration.toFixed(3);
  }
  return result;
}

/**
 * Scale timeline entry timestamps proportionally to a new target duration.
 */
function scaleTimeline(timeline, fromDuration, toDuration) {
  if (!timeline.length) return timeline;
  const ratio = toDuration / fromDuration;
  return timeline.map(entry => ({
    ...entry,
    startTime: +(entry.startTime * ratio).toFixed(3),
    endTime: +(entry.endTime * ratio).toFixed(3),
  }));
}

function isUsableBoundaries(b) {
  return Array.isArray(b) && b.length > 0 && b.some(x => x.endTime > x.startTime);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a video timeline mapping story-relevant panels to narration audio.
 *
 * Only panels referenced by segment panelHints are used — irrelevant panels are
 * dropped entirely. Each panel is guaranteed at least MIN_PANEL_DURATION seconds
 * of screen time so nothing flashes by too fast.
 *
 * @param {Array}  segments         - Script segments [{ text, mood, panelHint }]
 * @param {Array}  panelPaths       - ALL panel image paths in the project
 * @param {Array}  words            - Word-level timestamps [{ word, start, end }]
 * @param {number} targetDuration   - Desired video duration in seconds (null = auto)
 * @param {Array}  segmentBoundaries- Per-segment audio boundaries from timestamps.json
 * @param {number} audioDuration    - Total audio duration in seconds
 * @returns {Array} Timeline entries [{ panelPath, startTime, endTime, words, mood, pageFile }]
 */
export function buildTimeline(segments, panelPaths, words, targetDuration = null, segmentBoundaries = null, audioDuration = null) {
  if (!panelPaths.length) {
    logger.warn('[buildTimeline] No panels available');
    return [];
  }

  // Step 1: select only story-relevant panels, assigned per segment
  const segmentPanels = selectPanelsForTimeline(segments, panelPaths);
  const selectedCount = segmentPanels.reduce((s, p) => s + p.length, 0);
  logger.info(`[buildTimeline] ${panelPaths.length} panels → ${selectedCount} selected, MIN_PANEL_DURATION=${MIN_PANEL_DURATION}s, MAX_PER_SEGMENT=${MAX_PANELS_PER_SEGMENT}`);

  // Step 2: handle no-word-timestamps case
  if (!words.length) {
    logger.warn('[buildTimeline] No word timestamps — building duration-based timeline');
    const flat = segmentPanels.flat();
    if (!flat.length) return [];
    const duration = targetDuration || audioDuration || 60;
    const panelDuration = Math.max(MIN_PANEL_DURATION, duration / flat.length);
    return flat.map((p, i) => ({
      panelPath: p,
      startTime: +(i * panelDuration).toFixed(3),
      endTime: +((i + 1) * panelDuration).toFixed(3),
      words: [],
      mood: segments[0]?.mood || 'dramatic',
      pageFile: panelToPageFile(p),
      hintPages: [],
    }));
  }

  const narrationDuration = words[words.length - 1].end;
  const fullDuration = targetDuration || audioDuration || narrationDuration;

  // Step 3: boundary-driven build (most accurate — uses real per-segment audio timing)
  if (isUsableBoundaries(segmentBoundaries)) {
    logger.info('[buildTimeline] Using boundary timeline');
    const raw = buildBoundaryTimeline(segments, segmentPanels, words, segmentBoundaries);
    if (raw.length > 0) {
      const boundaryDuration = segmentBoundaries[segmentBoundaries.length - 1].endTime;
      logger.flow(`Timeline built (boundary): ${raw.length} entries over ${boundaryDuration.toFixed(1)}s`);
      // NEVER scale when we have audio segment boundaries — the audio plays at its
      // original speed, so video clips must match exactly. Scaling creates a desync
      // where subtitles (which reference audio timestamps) drift from the audio.
      // targetDuration only controls script generation length, not video compression.
      return fillAndExtend(raw, boundaryDuration);
    }
    logger.warn('[buildTimeline] Boundary build returned empty, falling back to natural');
  }

  // Step 4: natural (character-fraction) build
  logger.info('[buildTimeline] Using natural timeline');
  const raw = buildNaturalTimeline(segments, segmentPanels, words, narrationDuration);
  logger.flow(`Timeline built (natural): ${raw.length} entries over ${narrationDuration.toFixed(1)}s`);
  if (!targetDuration || Math.abs(targetDuration - narrationDuration) / narrationDuration < 0.1) {
    return fillAndExtend(raw, fullDuration);
  }
  return fillAndExtend(scaleTimeline(raw, narrationDuration, targetDuration), fullDuration);
}
