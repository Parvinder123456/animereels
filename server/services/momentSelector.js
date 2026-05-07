/**
 * Pick the top-N scenes that fit the user's target reel duration.
 *
 * Selection biases:
 *   - Importance score from videoAnalyzer (heaviest weight)
 *   - Story arc coverage: ensure at least one pick from each third of the timeline
 *   - Drop scenes flagged as `intro_outro` unless nothing else fits
 *   - Cap individual clip duration so one long scene can't eat the whole reel
 */

import { logger } from '../utils/logger.js';

const MAX_CLIP_SEC = 12;
const MIN_CLIP_SEC = 2;
const PER_THIRD_MIN_PICKS = 1;

function clipDurationFor(scene, type) {
  // Action / reveal beats hold longer; dialogue beats stay short.
  const base = type === 'action' || type === 'reveal' ? 6 : type === 'emotion' ? 5 : 4;
  return Math.min(MAX_CLIP_SEC, Math.max(MIN_CLIP_SEC, Math.min(scene.durationSec, base)));
}

/**
 * @param {Array<{startSec, endSec, durationSec}>} scenes
 * @param {Array<{sceneIndex, atSec, importance, type, summary}>} scores
 * @param {number} targetReelSec
 */
export function selectMoments(scenes, scores, targetReelSec) {
  const totalDuration = scenes.length ? scenes[scenes.length - 1].endSec : 0;
  const thirds = totalDuration / 3;

  const enriched = scores
    .filter(s => s.type !== 'intro_outro')
    .map(s => {
      const scene = scenes[s.sceneIndex];
      if (!scene) return null;
      const clipSec = clipDurationFor(scene, s.type);
      const third = Math.min(2, Math.floor(scene.startSec / thirds));
      return { ...s, scene, clipSec, third };
    })
    .filter(Boolean)
    .sort((a, b) => b.importance - a.importance || a.scene.startSec - b.scene.startSec);

  const picked = [];
  const usedSceneIdx = new Set();
  let usedSec = 0;

  // Pass 1 — guarantee coverage: pick the best in each third of the timeline.
  for (let third = 0; third < 3; third++) {
    const candidates = enriched.filter(e => e.third === third && !usedSceneIdx.has(e.sceneIndex));
    let count = 0;
    for (const cand of candidates) {
      if (count >= PER_THIRD_MIN_PICKS) break;
      if (usedSec + cand.clipSec > targetReelSec) continue;
      picked.push(cand);
      usedSceneIdx.add(cand.sceneIndex);
      usedSec += cand.clipSec;
      count++;
    }
  }

  // Pass 2 — fill remaining time with the next-best beats.
  for (const cand of enriched) {
    if (usedSceneIdx.has(cand.sceneIndex)) continue;
    if (usedSec + cand.clipSec > targetReelSec) continue;
    picked.push(cand);
    usedSceneIdx.add(cand.sceneIndex);
    usedSec += cand.clipSec;
  }

  picked.sort((a, b) => a.scene.startSec - b.scene.startSec);

  const clips = picked.map((p, idx) => {
    const center = (p.scene.startSec + p.scene.endSec) / 2;
    const half = p.clipSec / 2;
    const startSec = Math.max(p.scene.startSec, center - half);
    const endSec   = Math.min(p.scene.endSec,   startSec + p.clipSec);
    return {
      clipIndex: idx,
      sceneIndex: p.sceneIndex,
      startSec,
      endSec,
      durationSec: endSec - startSec,
      importance: p.importance,
      type: p.type,
      summary: p.summary,
    };
  });

  logger.info(
    `[momentSelector] picked ${clips.length} clips · ${usedSec.toFixed(1)}s / ${targetReelSec}s ` +
    `(target). avg importance ${avg(clips.map(c => c.importance)).toFixed(2)}`
  );
  return clips;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
