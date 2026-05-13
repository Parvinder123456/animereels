/**
 * Music bed selector for video_explainer renders.
 *
 * Looks for royalty-free music files in `music/` at the repo root, picks
 * the best match for the dominant mood of the script, and returns its
 * absolute path. The renderer mixes it in at low volume under the
 * sidechain-ducked source bed.
 *
 * Drop-in convention: place .mp3 files in `music/` named with mood keywords
 * (e.g. "lofi-calm.mp3", "cinematic-dramatic.mp3", "upbeat-motivational.mp3").
 * The selector matches by keyword substring.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_DIR = path.resolve(__dirname, '..', '..', 'music');

const MOOD_KEYWORDS = {
  calm:          ['lofi', 'chill', 'calm', 'ambient', 'peaceful'],
  inspirational: ['inspirational', 'motivational', 'uplifting', 'epic', 'rising'],
  energetic:     ['upbeat', 'energetic', 'driving', 'modern'],
  dramatic:      ['cinematic', 'dramatic', 'epic', 'tense'],
  emotional:     ['emotional', 'sad', 'melancholy', 'piano'],
  comedic:       ['playful', 'comedic', 'quirky', 'bouncy'],
  reveal:        ['cinematic', 'dramatic', 'tense'],
  suspense:      ['tense', 'suspense', 'dark'],
  action:        ['action', 'driving', 'intense', 'rock'],
};

/**
 * @returns {Promise<{path:string|null, dominantMood:string, file:string|null}>}
 */
export async function pickMusicBed(script) {
  const segs = script?.segments || [];
  if (!segs.length) return { path: null, dominantMood: null, file: null };

  const moodCounts = {};
  for (const s of segs) {
    if (s.mood && s.mood !== 'breathe') {
      moodCounts[s.mood] = (moodCounts[s.mood] || 0) + 1;
    }
  }
  const dominantMood = Object.entries(moodCounts)
    .sort(([, a], [, b]) => b - a)[0]?.[0] || 'calm';

  let files;
  try {
    files = await fs.readdir(MUSIC_DIR);
  } catch {
    logger.info(`[musicBed] no music/ directory at ${MUSIC_DIR} — bed disabled`);
    return { path: null, dominantMood, file: null };
  }
  const audio = files.filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f));
  if (!audio.length) return { path: null, dominantMood, file: null };

  const keywords = MOOD_KEYWORDS[dominantMood] || MOOD_KEYWORDS.calm;
  const match = audio.find(f => {
    const lower = f.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
  });
  const chosen = match || audio[0];
  logger.info(`[musicBed] mood=${dominantMood} → ${chosen}${match ? '' : ' (fallback)'}`);
  return {
    path: path.join(MUSIC_DIR, chosen),
    dominantMood,
    file: chosen,
  };
}
