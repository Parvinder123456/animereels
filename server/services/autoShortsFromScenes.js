/**
 * Auto-shorts cluster picker for video_explainer projects.
 *
 * Takes the Gemini scene plan we already paid for and turns it into a
 * list of "Short" candidate windows — 30-60s vertical clips, each
 * anchored on one or more high-importance scenes. Output shape matches
 * what shortsRenderer.renderShortClips() expects:
 *   [{ startSec, endSec, title, reason, sceneIndexes }]
 *
 * No additional Gemini calls; the importance + keyTakeaway already in the
 * scene plan is enough to rank and label clips.
 */

import { logger } from '../utils/logger.js';

const MERGE_GAP_SEC = 12;     // adjacent high-importance scenes with this gap merge into one Short
const DEFAULT_MIN_SEC = 30;
const DEFAULT_MAX_SEC = 60;
const DEFAULT_MIN_IMPORTANCE = 4;
const DEFAULT_COUNT = 8;

/**
 * @param {Array<object>} scenes  scene plan from geminiVideoBreakdown
 * @param {object} opts
 * @param {number} opts.count           max Shorts to emit (default 8)
 * @param {number} opts.minSec          minimum Short duration (default 30)
 * @param {number} opts.maxSec          maximum Short duration (default 60)
 * @param {number} opts.minImportance   importance floor for candidates (default 4)
 * @param {Array<{startSec, endSec}>} opts.skipWindows  ranges to drop entirely (OP/ED + manual)
 * @param {number} opts.totalSec        total source duration for end-clamping
 * @returns {Array<{startSec, endSec, durationSec, title, reason, sceneIndexes, score}>}
 */
export function pickShortsFromScenes(scenes, opts = {}) {
  const {
    count = DEFAULT_COUNT,
    minSec = DEFAULT_MIN_SEC,
    maxSec = DEFAULT_MAX_SEC,
    minImportance = DEFAULT_MIN_IMPORTANCE,
    skipWindows = [],
    totalSec = Infinity,
  } = opts;

  if (!scenes?.length) return [];

  const inSkip = (sec) => skipWindows.some(w => sec >= w.startSec && sec < w.endSec);
  const overlapsSkip = (a, b) => skipWindows.some(w => a < w.endSec && b > w.startSec);

  // Filter to importance>=floor, drop filler types, drop scenes inside skip windows.
  const candidates = scenes
    .filter(s =>
      s.type !== 'transition' &&
      s.type !== 'intro_outro' &&
      (s.importance || 0) >= minImportance &&
      !inSkip((s.startSec + s.endSec) / 2)
    )
    .sort((a, b) => a.startSec - b.startSec);

  if (!candidates.length) return [];

  // Greedy cluster: merge adjacent candidates whose gap is small and whose
  // combined duration would still fit under maxSec.
  const clusters = [];
  for (const s of candidates) {
    const last = clusters[clusters.length - 1];
    if (last) {
      const gap = s.startSec - last.endSec;
      const merged = { startSec: last.startSec, endSec: s.endSec };
      const mergedDur = merged.endSec - merged.startSec;
      if (gap <= MERGE_GAP_SEC && mergedDur <= maxSec * 1.1) {
        last.endSec = s.endSec;
        last.scenes.push(s);
        continue;
      }
    }
    clusters.push({ startSec: s.startSec, endSec: s.endSec, scenes: [s] });
  }

  // Pad short clusters out to minSec (try not to bleed into a skip window),
  // truncate over-long clusters to maxSec from the start.
  for (const c of clusters) {
    const dur = c.endSec - c.startSec;
    if (dur < minSec) {
      const needed = minSec - dur;
      const padBefore = Math.min(needed * 0.4, c.startSec);
      const padAfter  = needed - padBefore;
      const newStart = Math.max(0, c.startSec - padBefore);
      const newEnd   = Math.min(totalSec, c.endSec + padAfter);
      if (!overlapsSkip(newStart, c.startSec) && !overlapsSkip(c.endSec, newEnd)) {
        c.startSec = newStart;
        c.endSec   = newEnd;
      } else {
        // Skip-window adjacency — pad only one side
        const safeEnd = Math.min(totalSec, c.endSec + needed);
        if (!overlapsSkip(c.endSec, safeEnd)) c.endSec = safeEnd;
        else c.startSec = Math.max(0, c.startSec - needed);
      }
    } else if (dur > maxSec) {
      c.endSec = c.startSec + maxSec;
    }
  }

  // Score: sum of importance + small bonus for multi-scene clusters (denser content).
  for (const c of clusters) {
    c.score =
      c.scenes.reduce((n, s) => n + (s.importance || 0), 0) +
      Math.min(2, c.scenes.length - 1) * 0.5;
  }

  // Pick top-N by score, then resort chronologically.
  const picked = [...clusters]
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.startSec - b.startSec);

  // Build the output shape.
  const out = picked.map((c) => {
    // Best-scoring scene's keyTakeaway / dialogueGist / visualDescription becomes the title.
    const best = c.scenes.reduce(
      (max, s) => ((s.importance || 0) > (max?.importance || 0) ? s : max),
      c.scenes[0]
    );
    const titleSource =
      best.keyTakeaway ||
      best.dialogueGist ||
      best.visualDescription ||
      'Highlight';
    const title = String(titleSource).split(/[\.\?!]/)[0].slice(0, 80).trim();

    // Reason is a one-line "why this clip" — short list of takeaways.
    const reason = c.scenes
      .map(s => s.keyTakeaway || s.dialogueGist)
      .filter(Boolean)
      .slice(0, 3)
      .join(' · ');

    return {
      startSec: +c.startSec.toFixed(3),
      endSec:   +c.endSec.toFixed(3),
      durationSec: +(c.endSec - c.startSec).toFixed(3),
      title,
      reason,
      sceneIndexes: c.scenes.map(s => s.idx),
      score: +c.score.toFixed(2),
      mood: best.mood || 'energetic',
      importance: best.importance || minImportance,
    };
  });

  logger.info(
    `[autoShortsFromScenes] picked ${out.length} Shorts from ${candidates.length} candidate scenes ` +
    `(importance>=${minImportance}, ${minSec}-${maxSec}s)`
  );
  return out;
}

/**
 * Build a synthetic transcript (the shape shortsRenderer expects) from the
 * scene plan's per-scene dialogueVerbatim/dialogueGist. This lets the
 * existing renderShortClips() burn subtitles without us having to ship a
 * separate Whisper pass.
 */
export function sceneSegmentsToTranscript(scenes) {
  return scenes
    .filter(s => (s.dialogueVerbatim && s.dialogueVerbatim.trim()) || (s.dialogueGist && s.dialogueGist.trim()))
    .map((s, i) => ({
      id: i,
      start: s.startSec,
      end: s.endSec,
      text: (s.dialogueVerbatim || s.dialogueGist || '').trim(),
    }));
}
