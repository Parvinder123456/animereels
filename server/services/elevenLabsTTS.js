import { ElevenLabsClient } from 'elevenlabs';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import { ensureDir, safeReadJson, projectPath } from '../utils/fileHelpers.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const MAX_CHUNK_CHARS = 4500;

// Mood-based breathing room (seconds of silence injected between segments).
// Prevents the "machine gun" narration effect — matches pro recap pacing.
const MOOD_BREATHING_ROOM = {
  action: 0.15,
  horror: 0.40,
  suspense: 0.55,
  dramatic: 0.45,
  reveal: 0.60,
  emotional: 0.55,
  calm: 0.35,
  comedic: 0.25,
};
const DEFAULT_BREATHING_ROOM = 0.35;

function alignmentToWords(alignment) {
  const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
  const words = [];
  let currentWord = '';
  let wordStart = null;
  let wordEnd = null;

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    if (char === ' ' || char === '\n') {
      if (currentWord) {
        words.push({ word: currentWord, start: wordStart, end: wordEnd });
        currentWord = '';
        wordStart = null;
        wordEnd = null;
      }
    } else {
      if (wordStart === null) wordStart = character_start_times_seconds[i];
      wordEnd = character_end_times_seconds[i];
      currentWord += char;
    }
  }
  if (currentWord) {
    words.push({ word: currentWord, start: wordStart, end: wordEnd });
  }
  return words;
}

/**
 * Split text into chunks of at most maxChars, breaking at sentence boundaries.
 * Falls back to breaking at word boundaries if a single sentence exceeds maxChars.
 */
function splitTextIntoChunks(text, maxChars = MAX_CHUNK_CHARS) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  // Split into sentences (keep the delimiter attached)
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];

  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // Flush current chunk first
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      // Break the long sentence by words
      const words = sentence.split(/\s+/);
      let wordChunk = '';
      for (const word of words) {
        if ((wordChunk + ' ' + word).trim().length > maxChars) {
          if (wordChunk.trim()) chunks.push(wordChunk.trim());
          wordChunk = word;
        } else {
          wordChunk = wordChunk ? wordChunk + ' ' + word : word;
        }
      }
      if (wordChunk.trim()) current = wordChunk;
      continue;
    }

    if ((current + sentence).length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/**
 * Concatenate multiple mp3 files using ffmpeg's concat demuxer.
 */
async function concatAudioFiles(filePaths, outputPath) {
  logger.info(`[concatAudioFiles] Merging ${filePaths.length} file(s) into ${outputPath}`);
  const listContent = filePaths
    .map(f => `file '${f.replace(/\\/g, '/')}'`)
    .join('\n');

  const listFile = outputPath.replace(/\.mp3$/, '-concat-list.txt');
  logger.info(`[concatAudioFiles] Writing concat list to ${listFile}`);
  await fs.writeFile(listFile, listContent);

  const cmd = `"${ffmpegStatic}" -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`;
  logger.info(`[concatAudioFiles] Running: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 120000 });
    logger.info(`[concatAudioFiles] ffmpeg finished successfully`);
  } catch (err) {
    logger.error(`[concatAudioFiles] ffmpeg failed: ${err.message}`);
    if (err.stderr) logger.error(`[concatAudioFiles] ffmpeg stderr: ${err.stderr.toString()}`);
    throw err;
  } finally {
    try { await fs.unlink(listFile); } catch { }
  }
}

/**
 * Generate a short silence MP3 matching ElevenLabs output format (44.1kHz stereo).
 */
function generateSilenceFile(durationSec, outputPath) {
  const cmd = `"${ffmpegStatic}" -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSec.toFixed(3)} -c:a libmp3lame -b:a 128k "${outputPath}"`;
  execSync(cmd, { stdio: 'pipe', timeout: 10000 });
}

function getClient() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set in .env');
  return new ElevenLabsClient({ apiKey });
}

export async function generateNarration(projectId, voiceId, onProgress = () => { }) {
  voiceId = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error('No ElevenLabs voice ID — set ELEVENLABS_VOICE_ID in .env or pass voiceId');
  logger.info(`[generateNarration] START — project: ${projectId}, voiceId: ${voiceId}`);

  const client = getClient();
  logger.info(`[generateNarration] ElevenLabs client initialised`);

  logger.info(`[generateNarration] Loading script from script.json...`);
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  if (!script || !script.segments?.length) {
    logger.error(`[generateNarration] No script found or script has no segments`);
    throw new Error('No script found. Generate or upload a script first.');
  }
  logger.info(`[generateNarration] Script loaded — ${script.segments.length} segments, hook: ${script.hook ? `"${script.hook.slice(0, 60)}..."` : 'none'}`);

  const audioDir = projectPath(projectId, 'audio');
  logger.info(`[generateNarration] Ensuring audio dir: ${audioDir}`);
  await ensureDir(audioDir);

  const narrationPath = path.join(audioDir, 'narration.mp3');
  const timestampsPath = path.join(audioDir, 'timestamps.json');
  logger.info(`[generateNarration] Output paths — narration: ${narrationPath}, timestamps: ${timestampsPath}`);

  const allAudioFiles = [];
  const allWords = [];
  const segmentBoundaries = [];
  let globalTimeOffset = 0.0;

  // Generate hook as a separate segment so it gets its own TTS timing slot.
  // Prepending it to segment 0 caused extreme video/narration mismatches.
  const hookText = (script.hook || '').trim();
  const segments = [];
  if (hookText) {
    const seg0 = script.segments[0];
    segments.push({ ...seg0, text: hookText, _isHook: true });
    logger.info(`[generateNarration] Hook as separate segment (${hookText.length} chars, scene from seg 0)`);
  }
  segments.push(...script.segments);
  logger.info(`[generateNarration] Processing ${segments.length} segments total`);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const segText = (segment.text || '').trim();
    const pct = 20 + Math.round((i / segments.length) * 55);
    logger.info(`[generateNarration] Segment ${i + 1}/${segments.length} — ${segText.length} chars, mood: ${segment.mood || 'unknown'}`);
    onProgress(`Generating narration for segment ${i + 1}/${segments.length}...`, pct);

    if (!segText) {
      logger.warn(`[generateNarration] Segment ${i + 1} has no text, skipping`);
      segmentBoundaries.push({
        segmentIndex: i,
        startTime: +globalTimeOffset.toFixed(3),
        endTime: +globalTimeOffset.toFixed(3),
        wordCount: 0,
        text: ''
      });
      continue;
    }

    const segStartTime = globalTimeOffset;
    const chunks = splitTextIntoChunks(segText);
    logger.info(`[generateNarration] Segment ${i + 1} split into ${chunks.length} chunk(s)`);
    let segWordCount = 0;

    for (let j = 0; j < chunks.length; j++) {
      const chunkPath = path.join(audioDir, `narration-seg${i}-chunk${j}.mp3`);
      logger.info(`[generateNarration] Calling ElevenLabs TTS — seg ${i + 1}, chunk ${j + 1}/${chunks.length} (${chunks[j].length} chars)`);

      const response = await retry(async () => {
        return await client.textToSpeech.convertWithTimestamps(voiceId, {
          text: chunks[j],
          model_id: 'eleven_multilingual_v2',
          output_format: 'mp3_44100_128',
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.75,
          },
        });
      }, { maxAttempts: 3, label: `tts-seg${i}-chunk${j}` });

      logger.info(`[generateNarration] TTS response received — seg ${i + 1}, chunk ${j + 1}, audio_base64 length: ${response.audio_base64?.length ?? 'N/A'}, has alignment: ${!!response.alignment}`);

      const audioBuffer = Buffer.from(response.audio_base64, 'base64');
      logger.info(`[generateNarration] Writing chunk audio to ${chunkPath} (${audioBuffer.length} bytes)`);
      await fs.writeFile(chunkPath, audioBuffer);
      allAudioFiles.push(chunkPath);

      if (response.alignment) {
        const localWords = alignmentToWords(response.alignment);
        logger.info(`[generateNarration] Alignment parsed — ${localWords.length} words, timeOffset before: ${globalTimeOffset.toFixed(3)}s`);
        const globalWords = localWords.map(w => ({
          word: w.word,
          start: +(w.start + globalTimeOffset).toFixed(3),
          end: +(w.end + globalTimeOffset).toFixed(3)
        }));
        allWords.push(...globalWords);
        const chunkDuration = localWords.length > 0 ? localWords[localWords.length - 1].end : 0;
        segWordCount += localWords.length;
        globalTimeOffset += chunkDuration;
        logger.info(`[generateNarration] Chunk duration: ${chunkDuration.toFixed(3)}s, new globalTimeOffset: ${globalTimeOffset.toFixed(3)}s`);
      } else {
        logger.warn(`[generateNarration] No alignment in response for seg ${i + 1}, chunk ${j + 1} — time offset unchanged`);
      }
    }

    logger.info(`[generateNarration] Segment ${i + 1} complete — ${segWordCount} words, startTime: ${segStartTime.toFixed(3)}s, endTime: ${globalTimeOffset.toFixed(3)}s`);
    segmentBoundaries.push({
      segmentIndex: i,
      startTime: +segStartTime.toFixed(3),
      endTime: +globalTimeOffset.toFixed(3),
      wordCount: segWordCount,
      text: segText.slice(0, 80)
    });

    // Breathing room: inject silence between segments for natural pacing
    if (i < segments.length - 1) {
      const moodKey = (segment.mood || '').toLowerCase();
      const pauseDuration = MOOD_BREATHING_ROOM[moodKey] || DEFAULT_BREATHING_ROOM;
      const silencePath = path.join(audioDir, `silence-seg${i}.mp3`);
      generateSilenceFile(pauseDuration, silencePath);
      allAudioFiles.push(silencePath);
      globalTimeOffset += pauseDuration;
      logger.info(`[elevenLabs] Breathing room: +${pauseDuration.toFixed(2)}s after segment ${i + 1} (mood: ${moodKey || 'default'})`);
    }
  }

  logger.info(`[generateNarration] All segments processed — ${allAudioFiles.length} chunk file(s) to merge`);
  onProgress('Merging audio segments...', 78);
  logger.info(`[generateNarration] Running ffmpeg concat on ${allAudioFiles.length} file(s) -> ${narrationPath}`);
  await concatAudioFiles(allAudioFiles, narrationPath);
  logger.info(`[generateNarration] ffmpeg concat complete`);

  logger.info(`[generateNarration] Writing timestamps.json — ${allWords.length} words, duration: ${globalTimeOffset.toFixed(3)}s`);
  await fs.writeFile(timestampsPath, JSON.stringify({
    words: allWords,
    duration: globalTimeOffset,
    segmentBoundaries
  }, null, 2));
  logger.flow(`Timestamps saved: ${allWords.length} words over ${globalTimeOffset.toFixed(1)}s, ${segmentBoundaries.length} segment boundaries`);

  // Cleanup chunk files
  logger.info(`[generateNarration] Cleaning up ${allAudioFiles.length} chunk file(s)`);
  for (const f of allAudioFiles) {
    try { await fs.unlink(f); } catch { }
  }

  onProgress('Narration audio saved', 90);
  logger.flow(`Narration generated for project ${projectId} (${segments.length} segments)`);
  logger.info(`[generateNarration] DONE — ${narrationPath}`);
  return narrationPath;
}

export async function generatePreview(projectId, voiceId) {
  voiceId = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error('No ElevenLabs voice ID — set ELEVENLABS_VOICE_ID in .env or pass voiceId');
  logger.info(`[generatePreview] START — project: ${projectId}, voiceId: ${voiceId}`);

  const client = getClient();
  logger.info(`[generatePreview] Loading script...`);
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  if (!script || !script.segments?.length) {
    logger.error(`[generatePreview] No script found or empty segments`);
    throw new Error('No script found');
  }
  logger.info(`[generatePreview] Script loaded — ${script.segments.length} segments`);

  const audioDir = projectPath(projectId, 'audio');
  await ensureDir(audioDir);

  // Take first segment or first 200 characters for preview
  const previewText = script.hook
    ? `${script.hook} ${script.segments[0]?.text || ''}`
    : script.segments[0]?.text || 'Preview text not available.';
  const trimmed = previewText.slice(0, 500);
  logger.info(`[generatePreview] Preview text length: ${trimmed.length} chars`);

  logger.info(`[generatePreview] Calling ElevenLabs TTS convert...`);
  const audioStream = await retry(async () => {
    return await client.textToSpeech.convert(voiceId, {
      text: trimmed,
      model_id: 'eleven_multilingual_v2',
      output_format: 'mp3_44100_128'
    });
  }, { maxAttempts: 2, label: 'tts-preview' });
  logger.info(`[generatePreview] TTS response received, writing to file...`);

  const outputPath = path.join(audioDir, 'preview.mp3');

  if (audioStream instanceof Readable || typeof audioStream[Symbol.asyncIterator] === 'function') {
    logger.info(`[generatePreview] Piping stream to ${outputPath}`);
    const readable = audioStream instanceof Readable ? audioStream : Readable.from(audioStream);
    await pipeline(readable, createWriteStream(outputPath));
  } else if (audioStream instanceof Buffer || audioStream instanceof Uint8Array) {
    logger.info(`[generatePreview] Writing buffer (${audioStream.length} bytes) to ${outputPath}`);
    await fs.writeFile(outputPath, audioStream);
  } else {
    logger.info(`[generatePreview] Collecting async iterator chunks...`);
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    logger.info(`[generatePreview] Writing ${chunks.length} chunks to ${outputPath}`);
    await fs.writeFile(outputPath, Buffer.concat(chunks));
  }

  logger.flow(`Preview generated for project ${projectId}`);
  logger.info(`[generatePreview] DONE — ${outputPath}`);
  return outputPath;
}
