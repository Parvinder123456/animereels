/**
 * Convert character-level alignment to word-level timestamps.
 */
export function charAlignmentToWords(alignment, timeOffset = 0) {
  if (!alignment || !alignment.characters) return [];

  const words = [];
  let currentWord = '';
  let wordStart = null;
  let wordEnd = null;

  for (const char of alignment.characters) {
    if (char.character === ' ' || char.character === '\n') {
      if (currentWord) {
        words.push({
          word: currentWord,
          start: wordStart + timeOffset,
          end: wordEnd + timeOffset
        });
        currentWord = '';
        wordStart = null;
        wordEnd = null;
      }
    } else {
      if (wordStart === null) wordStart = char.start_time;
      wordEnd = char.end_time;
      currentWord += char.character;
    }
  }

  // Push last word
  if (currentWord) {
    words.push({
      word: currentWord,
      start: wordStart + timeOffset,
      end: wordEnd + timeOffset
    });
  }

  return words;
}

/**
 * Merge timestamp results from multiple TTS chunks.
 */
export function mergeChunkTimestamps(chunkResults) {
  const allWords = [];
  let timeOffset = 0;

  for (const chunk of chunkResults) {
    if (!chunk || !chunk.words) continue;

    for (const word of chunk.words) {
      allWords.push({
        word: word.word,
        start: word.start + timeOffset,
        end: word.end + timeOffset
      });
    }

    // Offset by the duration of this chunk
    if (chunk.words.length > 0) {
      timeOffset = chunk.words[chunk.words.length - 1].end;
    }
  }

  return allWords;
}
