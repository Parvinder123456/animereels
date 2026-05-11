/**
 * Parse a user-supplied English script into timestamped segments.
 *
 * Accepts:
 *   - a JSON object  { title, hook?, segments: [{text, mood?}] }
 *   - a JSON array   [{text, mood?}, ...]
 *   - plain English text — auto-segmented by sentence across the window
 *
 * Returns { title, hook, segments: [{text, mood, sourceStart, sourceEnd}] }
 * with timestamps interpolated linearly across the source window.
 */
export function parseEnglishScript(input, window) {
  const span = window.endSec - window.startSec;

  let title = 'Translated Clip';
  let hook = '';
  let raw = [];

  if (typeof input === 'string') {
    const trimmed = input.trim();
    const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (looksJson) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) raw = parsed;
        else { title = parsed.title || title; hook = parsed.hook || ''; raw = parsed.segments || []; }
      } catch {
        // fall through to plain-text path
      }
    }
    if (!raw.length) {
      const sentences = trimmed
        .replace(/\r/g, '')
        .split(/(?<=[\.\?!])\s+|\n{2,}/)
        .map(s => s.trim())
        .filter(Boolean);
      raw = sentences.map(text => ({ text, mood: 'calm' }));
    }
  } else if (Array.isArray(input)) {
    raw = input;
  } else if (input && typeof input === 'object') {
    title = input.title || title;
    hook  = input.hook  || '';
    raw   = input.segments || [];
  }

  const cleaned = raw
    .map(s => ({
      text: String(s.text || s.english || s.content || '').trim(),
      mood: String(s.mood || 'calm').toLowerCase(),
    }))
    .filter(s => s.text);
  if (!cleaned.length) return { title, hook, segments: [] };

  const totalChars = cleaned.reduce((n, s) => n + s.text.length, 0);
  let cursor = window.startSec;
  const segments = cleaned.map((s, i) => {
    const share = (s.text.length / totalChars) * span;
    const sourceStart = cursor;
    const sourceEnd = i === cleaned.length - 1 ? window.endSec : cursor + share;
    cursor = sourceEnd;
    return {
      sourceSegmentId: i,
      sourceStart: +sourceStart.toFixed(3),
      sourceEnd:   +sourceEnd.toFixed(3),
      text: s.text,
      mood: s.mood,
    };
  });

  return { title, hook, segments };
}
