/**
 * Pick scenes from a Gemini visual breakdown to fit a target output duration.
 *
 * Selection criteria:
 *   - Cover the full arc of the source (story-arc coverage: pick from every
 *     third of the timeline)
 *   - Bias toward importance >= 3
 *   - Prefer scene types that carry the story (insight, action, reveal, emotional)
 *     over transitions and intro/outro
 *   - Preserve setup-payoff pairs: if a scene references an earlier one via
 *     callbackTo, both are kept or neither
 *
 * Modes:
 *   - cut         (ratio > 3.5): pick a sparse subset
 *   - hybrid      (2.5-3.5):     pick most scenes, drop low-importance
 *   - continuous  (< 2.5):       keep nearly all scenes, drop only filler
 */

import { logger } from '../utils/logger.js';

const TYPE_SCORES = {
  insight:      1.0,
  action:       1.0,
  reveal:       1.0,
  story:        0.9,
  emotional:    0.9,
  explanation:  0.8,
  debate:       0.8,
  dialogue:     0.7,
  exposition:   0.6,
  transition:   0.2,
  intro_outro:  0.0,
};

export function pickMode(sourceSec, targetSec) {
  const ratio = sourceSec / Math.max(1, targetSec);
  if (ratio > 3.5) return 'cut';
  if (ratio < 2.5) return 'continuous';
  return 'hybrid';
}

/**
 * Build a per-scene composite score.
 */
function scoreScene(scene) {
  const typeScore = TYPE_SCORES[scene.type] ?? 0.5;
  const importanceScore = (scene.importance ?? 3) / 5;
  const hasDialogue = scene.dialogueGist?.length > 0 ? 0.15 : 0;
  const hasTakeaway = scene.keyTakeaway?.length > 0 ? 0.2 : 0;
  return typeScore * 0.4 + importanceScore * 0.4 + hasDialogue + hasTakeaway;
}

/**
 * Ensure setup-payoff pairs are kept together. If a selected scene
 * has callbackTo referencing an unselected scene, add it.
 */
function reindexWithCallbacks(scenes) {
  const oldToNew = new Map();
  scenes.forEach((s, i) => {
    oldToNew.set(s.idx, i);
    s.idx = i;
  });
  for (const s of scenes) {
    if (s.callbackTo != null) {
      s.callbackTo = oldToNew.has(s.callbackTo) ? oldToNew.get(s.callbackTo) : null;
    }
  }
}

function resolveCallbacks(selected, allScenes) {
  const selectedIdxs = new Set(selected.map(s => s.idx));
  const allByIdx = new Map(allScenes.map(s => [s.idx, s]));
  const toAdd = [];

  for (const s of selected) {
    if (s.callbackTo != null && !selectedIdxs.has(s.callbackTo)) {
      const ref = allByIdx.get(s.callbackTo);
      if (ref) {
        toAdd.push({ ...ref });
        selectedIdxs.add(ref.idx);
      }
    }
  }

  if (toAdd.length > 0) {
    const combined = [...selected, ...toAdd].sort((a, b) => a.startSec - b.startSec);
    reindexWithCallbacks(combined);
    logger.info(`[sceneSelector] callbackTo: added ${toAdd.length} referenced scene(s) for setup-payoff`);
    return combined;
  }
  return selected;
}

/**
 * @param {Array<{startSec, endSec, type, importance, mood, visualDescription, dialogueGist}>} scenes
 * @param {number} targetSec
 * @param {'cut'|'hybrid'|'continuous'} mode
 * @returns {Array<scene>}  selected scenes in chronological order
 */
export function selectScenes(scenes, targetSec, mode) {
  if (!scenes.length) return [];

  const scored = scenes.map(s => ({ ...s, _score: scoreScene(s) }));
  const totalSec = scenes[scenes.length - 1].endSec - scenes[0].startSec;

  // Continuous mode: keep most scenes, drop only the bottom-scoring filler.
  if (mode === 'continuous') {
    const sorted = [...scored].sort((a, b) => b._score - a._score);
    let usedSec = 0;
    const keep = new Set();
    for (const s of sorted) {
      if (usedSec >= targetSec * 1.05) break;
      keep.add(s.idx);
      usedSec += (s.endSec - s.startSec);
    }
    let out = scenes.filter(s => keep.has(s.idx));
    out = resolveCallbacks(out, scenes);
    reindexWithCallbacks(out);
    logger.info(`[sceneSelector] continuous: kept ${out.length}/${scenes.length} scenes (${usedSec.toFixed(1)}s)`);
    return out;
  }

  // Cut + hybrid: ensure story-arc coverage by picking from every third.
  const thirdSize = totalSec / 3;
  const thirds = [[], [], []];
  for (const s of scored) {
    const relStart = s.startSec - scenes[0].startSec;
    const which = Math.min(2, Math.floor(relStart / thirdSize));
    thirds[which].push(s);
  }
  thirds.forEach(t => t.sort((a, b) => b._score - a._score));

  // Pass 1: take the top-scored from each third, round-robin, until target hit.
  const picked = [];
  let usedSec = 0;
  const consumed = [0, 0, 0];
  outer: while (true) {
    let added = false;
    for (let t = 0; t < 3; t++) {
      if (consumed[t] >= thirds[t].length) continue;
      const cand = thirds[t][consumed[t]++];
      if (usedSec + (cand.endSec - cand.startSec) > targetSec * (mode === 'hybrid' ? 1.1 : 1.05)) {
        continue;
      }
      picked.push(cand);
      usedSec += cand.endSec - cand.startSec;
      added = true;
      if (usedSec >= targetSec) break outer;
    }
    if (!added) break;
  }

  picked.sort((a, b) => a.startSec - b.startSec);
  let result = picked.map(s => {
    const { _score, ...rest } = s;
    return rest;
  });
  result = resolveCallbacks(result, scenes);
  reindexWithCallbacks(result);
  logger.info(
    `[sceneSelector] ${mode}: kept ${result.length}/${scenes.length} scenes (${usedSec.toFixed(1)}s / target ${targetSec}s)`
  );
  return result;
}
