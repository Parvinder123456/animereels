/**
 * subtitleGenerator.js
 *
 * Converts word-level timestamps into a burned-in ASS subtitle file.
 * Style: Clean podcast recap —
 *   - Bold white text, black outline, no karaoke highlight
 *   - 3-4 words per line grouped by natural speech pauses
 *   - Positioned at the bottom-center
 */

import fs from 'fs/promises';
import path from 'path';
import { projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const WORDS_PER_LINE = 4;         // max words before wrapping to a new line
const MAX_GAP_FOR_SAME_LINE = 0.5; // seconds — gap bigger than this = new subtitle event
const FONT_SIZE = 68;             // large, readable at mobile
const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;

// Colours in ASS &HAABBGGRR format
const COLOUR_WHITE = '&H00FFFFFF';
const COLOUR_OUTLINE = '&H00000000';  // black
const COLOUR_SHADOW = '&H80000000';  // semi-transparent black

// ─── ASS header ──────────────────────────────────────────────────────────────

function assHeader() {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${VIDEO_WIDTH}
PlayResY: ${VIDEO_HEIGHT}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Recap,Montserrat,${FONT_SIZE},${COLOUR_WHITE},${COLOUR_WHITE},${COLOUR_OUTLINE},${COLOUR_SHADOW},-1,0,0,0,100,100,2,0,1,4,2,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

// ─── Time formatting ──────────────────────────────────────────────────────────

/**
 * Converts seconds to ASS timestamp: H:MM:SS.cc
 */
function toAssTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.floor((secs % 1) * 100); // centiseconds
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ─── Word grouping ────────────────────────────────────────────────────────────

/**
 * Groups words into subtitle "chunks" — a chunk is one displayed line.
 * A new chunk starts when:
 *  - WORDS_PER_LINE words have been accumulated, OR
 *  - The gap to the next word exceeds MAX_GAP_FOR_SAME_LINE (speech pause)
 */
function groupWordsIntoChunks(words) {
  const chunks = [];
  let current = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    current.push(w);

    const isLastWord = !next;
    const pauseBreak = next && (next.start - w.end) > MAX_GAP_FOR_SAME_LINE;
    const lengthBreak = current.length >= WORDS_PER_LINE;

    if (isLastWord || pauseBreak || lengthBreak) {
      chunks.push([...current]);
      current = [];
    }
  }

  return chunks;
}

// ─── ASS event builder ───────────────────────────────────────────────────────

/**
 * Builds one ASS Dialogue line for a chunk of words.
 * Plain white text — no karaoke highlight. Clean podcast style.
 */
function buildDialogueLine(chunk) {
  const startTime = chunk[0].start;
  const endTime = chunk[chunk.length - 1].end;
  const text = chunk.map(w => w.word).join(' ');

  const start = toAssTime(startTime);
  const end = toAssTime(endTime + 0.10); // slight hold

  return `Dialogue: 0,${start},${end},Recap,,0,0,0,,${text}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an ASS subtitle file from word timestamps.
 *
 * @param {string} projectId
 * @param {Array} words  - [{word, start, end}]
 * @param {string} outputPath - where to write the .ass file
 * @returns {string} path to the generated .ass file
 */
export async function generateSubtitles(projectId, words, outputPath) {
  if (!words || words.length === 0) {
    logger.warn('generateSubtitles: no words provided, skipping');
    return null;
  }

  // Clean words: strip punctuation from display but keep timing
  const cleanWords = words.map(w => ({
    ...w,
    word: w.word.replace(/^["'\u201c\u2018]+|["'\u201d\u2019.,!?;:]+$/g, '').trim() || w.word,
  })).filter(w => w.word.length > 0);

  const chunks = groupWordsIntoChunks(cleanWords);
  const lines = chunks.map(buildDialogueLine);

  const assContent = assHeader() + lines.join('\n') + '\n';
  await fs.writeFile(outputPath, assContent, 'utf-8');

  logger.flow(`Subtitles generated: ${lines.length} lines, ${cleanWords.length} words → ${path.basename(outputPath)}`);
  return outputPath;
}

/**
 * Generate subtitles for a project from its timestamps.json.
 * Saves to output/subtitles.ass and returns the path.
 */
export async function generateProjectSubtitles(projectId, timestamps) {
  const outputPath = projectPath(projectId, 'output', 'subtitles.ass');
  const words = timestamps?.words || [];
  return generateSubtitles(projectId, words, outputPath);
}
