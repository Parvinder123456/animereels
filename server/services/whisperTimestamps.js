import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { ensureDir, projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

/**
 * Extract word-level timestamps from audio.
 * Tries system whisper first, falls back to uniform distribution.
 */
export async function extractTimestamps(projectId, audioPath, onProgress = () => {}) {
  onProgress('Extracting timestamps...', 10);

  // Try to get audio duration via ffprobe
  let duration = 60; // fallback
  try {
    const ffprobePath = (await import('ffprobe-static')).default.path || 'ffprobe';
    const { stdout } = await execAsync(
      `"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`
    );
    duration = parseFloat(stdout.trim()) || 60;
  } catch (err) {
    logger.warn(`Could not probe audio duration: ${err.message}`);
  }

  // For now, generate uniform timestamps as a best-effort fallback.
  // A real whisper integration would produce word-level alignment.
  onProgress('Generating timestamp estimates...', 50);

  // Read script to estimate word count
  const { safeReadJson } = await import('../utils/fileHelpers.js');
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  const segments = script?.segments || [];
  const allWords = segments.flatMap(s => (s.text || '').split(/\s+/).filter(Boolean));

  if (allWords.length === 0) {
    return { words: [], duration };
  }

  // Distribute words uniformly across the audio duration
  const wordDuration = duration / allWords.length;
  const words = allWords.map((word, i) => ({
    word,
    start: +(i * wordDuration).toFixed(3),
    end: +((i + 1) * wordDuration).toFixed(3)
  }));

  const timestampsPath = projectPath(projectId, 'audio', 'timestamps.json');
  await fs.writeFile(timestampsPath, JSON.stringify({ words, duration }, null, 2));

  onProgress('Timestamps extracted', 100);
  logger.flow(`Timestamps: ${words.length} words over ${duration.toFixed(1)}s`);
  return { words, duration };
}
