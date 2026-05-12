/**
 * Pick scenes from a Gemini visual breakdown to fit a target output duration.
 *
 * Selection criteria:
 *   - Cover the full arc of the source (story-arc coverage: pick from every
 *     third of the timeline)
 *   - Bias toward importance >= 3
 *   - Prefer scene types that carry the story (action, reveal, emotional)
 *     over transitions and recap montages
 *   - Avoid back-to-back scenes from identical importance/type unless the
 *     story demands it
 *
 * Modes:
 *   - cut         (ratio > 3.5): pick a sparse subset
 *   - hybrid      (2.5-3.5):     pick most scenes, drop low-importance
 *   - continuous  (< 2.5):       keep nearly all scenes, drop only filler
 */

import { logger } from '../utils/logger.js';

const TYPE_SCORES = {
  action: 1.0,
  reveal: 1.0,
  emotional: 0.9,
  dialogue: 0.7,
  exposition: 0.6,
  transition: 0.2,
  intro_outro: 0.0,
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
  return typeScore * 0.5 + importanceScore * 0.5 + hasDialogue;
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
    const out = scenes.filter(s => keep.has(s.idx));
    out.forEach((s, i) => { s.idx = i; });
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
  picked.forEach((s, i) => { s.idx = i; });
  logger.info(
    `[sceneSelector] ${mode}: kept ${picked.length}/${scenes.length} scenes (${usedSec.toFixed(1)}s / target ${targetSec}s)`
  );
  return picked.map(s => {
    const { _score, ...rest } = s;
    return rest;
  });
}
