import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_DIR = path.resolve(__dirname, '..', '..', 'music');

// Mood to keyword mapping for music selection
const MOOD_KEYWORDS = {
  suspense: ['suspense', 'tension', 'dark', 'mystery'],
  action: ['action', 'battle', 'fight', 'intense', 'epic'],
  emotional: ['emotional', 'sad', 'dramatic', 'melancholy'],
  happy: ['happy', 'upbeat', 'cheerful', 'light'],
  dramatic: ['dramatic', 'epic', 'cinematic', 'intense'],
  romantic: ['romantic', 'love', 'gentle', 'soft'],
  horror: ['horror', 'creepy', 'dark', 'eerie']
};

/**
 * Select a background music track based on script segment moods.
 * Returns the path to a music file, or null if none available.
 */
export async function selectMusicTrack(segments) {
  try {
    const files = await fs.readdir(MUSIC_DIR);
    const audioFiles = files.filter(f =>
      ['.mp3', '.wav', '.ogg', '.m4a'].includes(path.extname(f).toLowerCase())
    );

    if (audioFiles.length === 0) {
      logger.warn('No music files found in music/ directory');
      return null;
    }

    // Determine dominant mood
    const moodCounts = {};
    for (const seg of segments) {
      const mood = (seg.mood || 'dramatic').toLowerCase();
      moodCounts[mood] = (moodCounts[mood] || 0) + 1;
    }
    const dominantMood = Object.entries(moodCounts)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || 'dramatic';

    // Try to match music file name to mood
    const keywords = MOOD_KEYWORDS[dominantMood] || MOOD_KEYWORDS.dramatic;
    const matched = audioFiles.find(f => {
      const lower = f.toLowerCase();
      return keywords.some(kw => lower.includes(kw));
    });

    if (matched) {
      const trackPath = path.join(MUSIC_DIR, matched);
      logger.info(`Selected music: ${matched} (mood: ${dominantMood})`);
      return trackPath;
    }

    // Fallback: use first available track
    const fallback = path.join(MUSIC_DIR, audioFiles[0]);
    logger.info(`No mood match, using fallback music: ${audioFiles[0]}`);
    return fallback;
  } catch (err) {
    logger.warn(`Music selection failed: ${err.message}`);
    return null;
  }
}
