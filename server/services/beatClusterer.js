/**
 * Cluster Whisper transcript segments into "story beats" suitable for
 * narrator commentary.
 *
 * The cluster size depends on the render mode:
 *   - cut mode      (high compression):    20-40 sec beats
 *   - hybrid mode   (medium compression):  40-70 sec beats
 *   - continuous mode (low compression):   60-90 sec beats
 *
 * Beats respect:
 *   - skip windows from OP/ED detection (segments inside are dropped)
 *   - episode boundaries (no beat crosses an episode)
 *   - long silences in the transcript (gaps > 3s break the beat)
 *
 * Output: array of beats each with {beatIndex, episodeIdx, startSec,
 * endSec, durationSec, segments[]} where segments are the original
 * transcript segments that fall inside this beat.
 */

import { logger } from '../utils/logger.js';

const MODE_TARGETS = {
  cut:        { min: 20, max: 40 },
  hybrid:     { min: 40, max: 70 },
  continuous: { min: 60, max: 90 },
};

const SILENCE_BREAK_SEC = 3.0; // gap >3s between segments forces a beat break

/**
 * @param {Array<{id, start, end, text}>} segments  whisper transcript segments
 * @param {Array<{idx:number, startSec:number, durationSec:number}>} episodes
 * @param {Array<{startSec:number, endSec:number}>} skipWindows  merged OP/ED cuts
 * @param {'cut'|'hybrid'|'continuous'} mode
 * @returns {Array<{beatIndex, episodeIdx, startSec, endSec, durationSec, segments:Array}>}
 */
export function clusterIntoBeats(segments, episodes, skipWindows, mode) {
  const target = MODE_TARGETS[mode] || MODE_TARGETS.hybrid;
  if (!segments.length) return [];

  // 1. Filter out segments that fall entirely inside skip windows (OP/ED).
  const kept = segments.filter(s => !isFullyInSkip(s, skipWindows));

  // 2. Assign each segment to an episode by its start timestamp.
  const tagged = kept.map(s => ({ ...s, episodeIdx: findEpisode(s.start, episodes) }));

  // 3. Greedily pack segments into beats up to target.max, breaking on:
  //    a) episode change
  //    b) silence gap >= SILENCE_BREAK_SEC
  //    c) beat would exceed target.max
  //    d) but never finalize a beat below target.min unless we hit (a) or end-of-stream
  const beats = [];
  let current = null;

  for (const seg of tagged) {
    const gapFromCurrent = current ? seg.start - current.endSec : 0;
    const wouldExceed = current && (seg.end - current.startSec) > target.max;
    const episodeChanged = current && seg.episodeIdx !== current.episodeIdx;
    const silenceBreak = current && gapFromCurrent >= SILENCE_BREAK_SEC;

    const closeNow = current && (
      episodeChanged ||
      (current.durationSec >= target.min && (wouldExceed || silenceBreak))
    );

    if (closeNow) {
      beats.push(current);
      current = null;
    }

    if (!current) {
      current = {
        beatIndex: beats.length,
        episodeIdx: seg.episodeIdx,
        startSec: seg.start,
        endSec: seg.end,
        durationSec: seg.end - seg.start,
        segments: [seg],
      };
    } else {
      current.endSec = seg.end;
      current.durationSec = current.endSec - current.startSec;
      current.segments.push(seg);
    }
  }
  if (current) beats.push(current);

  // 4. Re-index after clustering.
  beats.forEach((b, i) => { b.beatIndex = i; });

  logger.info(
    `[beatClusterer] mode=${mode} · ${segments.length} segments → ${beats.length} beats ` +
    `(avg ${avg(beats.map(b => b.durationSec)).toFixed(1)}s, ` +
    `min ${Math.min(...beats.map(b => b.durationSec)).toFixed(1)}s, ` +
    `max ${Math.max(...beats.map(b => b.durationSec)).toFixed(1)}s)`
  );
  return beats;
}

function isFullyInSkip(seg, skipWindows) {
  for (const w of skipWindows) {
    if (seg.start >= w.startSec && seg.end <= w.endSec) return true;
  }
  return false;
}

function findEpisode(timeSec, episodes) {
  if (!episodes?.length) return 0;
  for (let i = episodes.length - 1; i >= 0; i--) {
    if (timeSec >= episodes[i].startSec) return episodes[i].idx;
  }
  return 0;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Decide render mode from source duration + target duration.
 * Returns 'cut' | 'hybrid' | 'continuous'.
 */
export function pickMode(sourceSec, targetSec) {
  const ratio = sourceSec / Math.max(1, targetSec);
  if (ratio > 3.5) return 'cut';
  if (ratio < 2.5) return 'continuous';
  return 'hybrid';
}

/**
 * For cut mode: pick a subset of beats whose total duration sums to ~targetSec.
 * Beats stay in chronological order. Importance scoring is left to the
 * script writer (we keep all beats and trim there); here we just bias toward
 * dialogue density and episode coverage.
 */
export function pickBeatsForCutMode(beats, targetSec, episodes) {
  if (!beats.length) return [];

  // Score each beat by word density + first/last-in-episode bonus.
  const wordCount = b => b.segments.reduce((n, s) => n + (s.text || '').split(/\s+/).filter(Boolean).length, 0);
  const epIndexes = new Set(episodes.map(e => e.idx));
  const firstOfEp = new Set();
  const lastOfEp = new Set();
  for (const epIdx of epIndexes) {
    const epBeats = beats.filter(b => b.episodeIdx === epIdx);
    if (epBeats.length) {
      firstOfEp.add(epBeats[0].beatIndex);
      lastOfEp.add(epBeats[epBeats.length - 1].beatIndex);
    }
  }

  const scored = beats.map(b => ({
    ...b,
    _score: wordCount(b) / Math.max(1, b.durationSec) +
            (firstOfEp.has(b.beatIndex) ? 0.5 : 0) +
            (lastOfEp.has(b.beatIndex)  ? 0.5 : 0),
  })).sort((a, b) => b._score - a._score);

  // Greedy pick until we hit target duration.
  const picked = [];
  let usedSec = 0;
  for (const b of scored) {
    if (usedSec >= targetSec) break;
    picked.push(b);
    usedSec += b.durationSec;
  }
  picked.sort((a, b) => a.startSec - b.startSec);
  picked.forEach((b, i) => { b.beatIndex = i; delete b._score; });
  logger.info(`[beatClusterer] cut mode pick: ${picked.length}/${beats.length} beats (${usedSec.toFixed(1)}s)`);
  return picked;
}
