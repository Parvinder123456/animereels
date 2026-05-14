import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { ensureDir, safeReadJson, projectPath } from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const MAX_CHUNK_CHARS = 3500;

// Mood-based breathing room (seconds of silence injected between segments).
// Prevents the "machine gun" narration effect — matches pro recap pacing.
const MOOD_BREATHING_ROOM = {
  action:        0.15,   // fast cuts — minimal pause
  energetic:     0.20,
  horror:        0.40,
  suspense:      0.55,   // let tension hang
  dramatic:      0.45,   // dramatic weight
  reveal:        0.60,   // let reveals land
  emotional:     0.55,   // emotional beats need air
  inspirational: 0.40,
  calm:          0.35,
  comedic:       0.25,
  breathe:       0.30,   // after a breathe segment
};
const DEFAULT_BREATHING_ROOM = 0.35;

// SSML prosody settings per mood — vary rate/pitch for natural delivery.
// Edge TTS respects <prosody> tags inside the SSML voice element.
const MOOD_PROSODY = {
  energetic:     { rate: '+10%', pitch: '+3%' },
  action:        { rate: '+12%', pitch: '+3%' },
  inspirational: { rate: '+5%', pitch: '+2%' },
  dramatic:      { rate: '-8%', pitch: '-5%' },
  emotional:     { rate: '-10%', pitch: '-3%' },
  suspense:      { rate: '-8%', pitch: '-8%' },
  reveal:        { rate: '-5%' },
  comedic:       { rate: '+5%' },
  calm:          {},
};

export const EDGE_VOICES = [
  { id: 'en-US-GuyNeural',         label: 'Guy — Deep Male Narrator' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher — Authoritative Male' },
  { id: 'en-US-EricNeural',        label: 'Eric — Friendly Male' },
  { id: 'en-US-RogerNeural',       label: 'Roger — Warm Male' },
  { id: 'en-US-AriaNeural',        label: 'Aria — Versatile Female' },
  { id: 'en-US-JennyNeural',       label: 'Jenny — Conversational Female' },
  { id: 'en-US-SaraNeural',        label: 'Sara — Smooth Female' },
  { id: 'en-US-TonyNeural',        label: 'Tony — Casual Male' },
];

/**
 * Build ProsodyOptions for toStream() based on mood.
 * These are passed as the second argument to tts.toStream(), which applies
 * them via its own <prosody> wrapper in _SSMLTemplate — no manual SSML needed.
 */
function getProsodyOptions(mood) {
  const settings = MOOD_PROSODY[mood] || {};
  if (!Object.keys(settings).length) return undefined;
  return settings;
}

/**
 * Collect a Readable stream into a single Buffer.
 */
function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', chunk => chunks.push(chunk));
    readable.on('end', () => {
      logger.info(`[edgeTTS streamToBuffer] Stream ended, ${chunks.length} chunk(s) collected`);
      resolve(Buffer.concat(chunks));
    });
    readable.on('error', err => {
      logger.error(`[edgeTTS streamToBuffer] Stream error: ${err.message}`);
      reject(err);
    });
    readable.on('close', () => {
      logger.info(`[edgeTTS streamToBuffer] Stream closed`);
    });
  });
}

/**
 * Collect metadata stream into an array of word boundary entries.
 * Each chunk is JSON: { Metadata: [{ Type, Data: { Offset, Duration, text: { Text } } }] }
 * Offset and Duration are in 100-nanosecond units.
 */
function collectWordBoundaries(metadataStream) {
  return new Promise((resolve, reject) => {
    if (!metadataStream) {
      logger.warn(`[edgeTTS collectWordBoundaries] metadataStream is null — no word boundaries available`);
      return resolve([]);
    }
    const allItems = [];
    metadataStream.on('data', chunk => {
      try {
        const parsed = JSON.parse(chunk.toString());
        const items = parsed.Metadata || [];
        logger.info(`[edgeTTS collectWordBoundaries] Metadata chunk received — ${items.length} item(s)`);
        for (const item of items) {
          if (item.Type === 'WordBoundary') {
            allItems.push({
              text: item.Data.text.Text,
              offset: item.Data.Offset,
              duration: item.Data.Duration,
            });
          } else {
            logger.info(`[edgeTTS collectWordBoundaries] Skipping metadata type: ${item.Type}`);
          }
        }
      } catch (e) {
        logger.warn(`[edgeTTS collectWordBoundaries] Failed to parse metadata chunk: ${e.message}`);
      }
    });
    metadataStream.on('end', () => {
      logger.info(`[edgeTTS collectWordBoundaries] Metadata stream ended — ${allItems.length} word boundary item(s) collected`);
      resolve(allItems);
    });
    metadataStream.on('close', () => {
      logger.info(`[edgeTTS collectWordBoundaries] Metadata stream closed — resolving with ${allItems.length} item(s)`);
      resolve(allItems);
    });
    metadataStream.on('error', err => {
      logger.error(`[edgeTTS collectWordBoundaries] Metadata stream error: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Convert raw word boundary items to timestamps array, applying a time offset (seconds).
 */
function wordBoundariesToTimestamps(items, timeOffset) {
  return items.map(item => ({
    word: item.text,
    start: +(item.offset / 10_000_000 + timeOffset).toFixed(3),
    end:   +((item.offset + item.duration) / 10_000_000 + timeOffset).toFixed(3),
  }));
}

/**
 * Split text into chunks of at most maxChars, breaking at sentence boundaries.
 */
function splitTextIntoChunks(text, maxChars = MAX_CHUNK_CHARS) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];

  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current.trim()) { chunks.push(current.trim()); current = ''; }
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
  logger.info(`[edgeTTS concatAudioFiles] Merging ${filePaths.length} file(s) into ${outputPath}`);
  const listContent = filePaths.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  const listFile = outputPath.replace(/\.mp3$/, '-concat-list.txt');
  logger.info(`[edgeTTS concatAudioFiles] Writing concat list to ${listFile}`);
  await fs.writeFile(listFile, listContent);

  const cmd = `"${ffmpegStatic}" -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`;
  logger.info(`[edgeTTS concatAudioFiles] Running ffmpeg: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 120000 });
    logger.info(`[edgeTTS concatAudioFiles] ffmpeg concat finished successfully`);
  } catch (err) {
    logger.error(`[edgeTTS concatAudioFiles] ffmpeg failed: ${err.message}`);
    if (err.stderr) logger.error(`[edgeTTS concatAudioFiles] ffmpeg stderr: ${err.stderr.toString()}`);
    throw err;
  } finally {
    try { await fs.unlink(listFile); } catch { }
  }
}

/**
 * Generate a short silence MP3 matching Edge TTS output format (24kHz mono).
 */
function generateSilenceFile(durationSec, outputPath) {
  const cmd = `"${ffmpegStatic}" -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${durationSec.toFixed(3)} -c:a libmp3lame -b:a 96k "${outputPath}"`;
  execSync(cmd, { stdio: 'pipe', timeout: 10000 });
}

/**
 * Synthesise a single chunk of text using Edge TTS.
 * Returns { audioBuffer, wordBoundaries }.
 */
async function synthesiseChunk(voiceName, text, prosodyOptions) {
  logger.info(`[edgeTTS synthesiseChunk] Creating MsEdgeTTS instance, voice: ${voiceName}`);
  const tts = new MsEdgeTTS();

  logger.info(`[edgeTTS synthesiseChunk] Calling setMetadata with wordBoundaryEnabled=true, format=AUDIO_24KHZ_96KBITRATE_MONO_MP3`);
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: true,
  });
  logger.info(`[edgeTTS synthesiseChunk] setMetadata complete`);

  logger.info(`[edgeTTS synthesiseChunk] Calling toStream (${text.length} chars)${prosodyOptions ? ` prosody: ${JSON.stringify(prosodyOptions)}` : ''}`);
  const { audioStream, metadataStream } = tts.toStream(text, prosodyOptions);
  logger.info(`[edgeTTS synthesiseChunk] toStream returned — audioStream: ${!!audioStream}, metadataStream: ${!!metadataStream}`);

  logger.info(`[edgeTTS synthesiseChunk] Collecting audio and metadata streams in parallel`);
  const [audioBuffer, wordBoundaries] = await Promise.all([
    streamToBuffer(audioStream),
    collectWordBoundaries(metadataStream),
  ]);

  logger.info(`[edgeTTS synthesiseChunk] Audio buffer: ${audioBuffer.length} bytes, word boundaries: ${wordBoundaries.length}`);

  tts.close();
  logger.info(`[edgeTTS synthesiseChunk] WebSocket closed`);

  return { audioBuffer, wordBoundaries };
}

export async function generateNarration(projectId, voiceName, onProgress = () => {}) {
  logger.info(`[edgeTTS generateNarration] START — project: ${projectId}, voice: ${voiceName}`);

  logger.info(`[edgeTTS generateNarration] Loading script.json...`);
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  if (!script || !script.segments?.length) {
    logger.error(`[edgeTTS generateNarration] No script found or empty segments`);
    throw new Error('No script found. Generate or upload a script first.');
  }
  logger.info(`[edgeTTS generateNarration] Script loaded — ${script.segments.length} segments, hook: ${script.hook ? `"${script.hook.slice(0, 60)}..."` : 'none'}`);

  const audioDir = projectPath(projectId, 'audio');
  logger.info(`[edgeTTS generateNarration] Ensuring audio dir: ${audioDir}`);
  await ensureDir(audioDir);

  const narrationPath = path.join(audioDir, 'narration.mp3');
  const timestampsPath = path.join(audioDir, 'timestamps.json');
  logger.info(`[edgeTTS generateNarration] Output — narration: ${narrationPath}, timestamps: ${timestampsPath}`);

  const allAudioFiles = [];
  const allWords = [];
  const segmentBoundaries = [];
  let globalTimeOffset = 0.0;

  const hookText = (script.hook || '').trim();

  // Generate hook as a separate segment so it gets its own TTS timing slot.
  // Prepending it to segment 0 caused extreme video/narration mismatches
  // (e.g. 3s video clip with 25s of narration → frozen frames).
  const segments = [];
  if (hookText) {
    const seg0 = script.segments[0];
    segments.push({ ...seg0, text: hookText, _isHook: true });
    logger.info(`[edgeTTS generateNarration] Hook as separate segment (${hookText.length} chars, scene from seg 0)`);
  }
  segments.push(...script.segments);
  logger.info(`[edgeTTS generateNarration] Processing ${segments.length} segment(s) total`);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const segText = (segment.text || '').trim();
    const moodKey = (segment.mood || '').toLowerCase();
    const isBreathe = !segText || moodKey === 'breathe';
    const pct = 20 + Math.round((i / segments.length) * 55);
    logger.info(`[edgeTTS generateNarration] === Segment ${i + 1}/${segments.length} — ${segText.length} chars, mood: ${moodKey || 'unknown'}${isBreathe ? ' (BREATHE)' : ''} ===`);
    onProgress(`Generating narration for segment ${i + 1}/${segments.length}...`, pct);

    // Breathe segment: inject silence so original audio plays through
    if (isBreathe) {
      const breatheDur = Math.min(15, Math.max(2, (segment.sourceEnd - segment.sourceStart) || 3));
      const silencePath = path.join(audioDir, `breathe-seg${i}.mp3`);
      generateSilenceFile(breatheDur, silencePath);
      allAudioFiles.push(silencePath);

      const segStartTime = globalTimeOffset;
      globalTimeOffset += breatheDur;

      segmentBoundaries.push({
        segmentIndex: i,
        startTime: +segStartTime.toFixed(3),
        endTime: +globalTimeOffset.toFixed(3),
        wordCount: 0,
        text: '(breathe)',
      });
      logger.info(`[edgeTTS] Breathe segment ${i + 1}: ${breatheDur.toFixed(1)}s silence (source: ${segment.sourceStart?.toFixed(1)}-${segment.sourceEnd?.toFixed(1)}s)`);

      // Breathing room after breathe segments
      if (i < segments.length - 1) {
        const pauseDuration = MOOD_BREATHING_ROOM.breathe;
        const gapPath = path.join(audioDir, `silence-seg${i}.mp3`);
        generateSilenceFile(pauseDuration, gapPath);
        allAudioFiles.push(gapPath);
        globalTimeOffset += pauseDuration;
      }
      continue;
    }

    const segStartTime = globalTimeOffset;

    // Pass prosody options to toStream() instead of wrapping in SSML tags
    const prosodyOpts = getProsodyOptions(moodKey);
    const chunks = splitTextIntoChunks(segText);
    logger.info(`[edgeTTS generateNarration] Segment ${i + 1} split into ${chunks.length} chunk(s)${prosodyOpts ? ` prosody: ${JSON.stringify(prosodyOpts)}` : ''}`);
    let segWordCount = 0;

    for (let j = 0; j < chunks.length; j++) {
      const chunkPath = path.join(audioDir, `narration-seg${i}-chunk${j}.mp3`);
      logger.info(`[edgeTTS generateNarration] Chunk ${j + 1}/${chunks.length} — ${chunks[j].length} chars, output: ${chunkPath}`);
      logger.info(`[edgeTTS generateNarration] Chunk text preview: "${chunks[j].slice(0, 80)}..."`);

      const { audioBuffer, wordBoundaries } = await synthesiseChunk(voiceName, chunks[j], prosodyOpts);

      logger.info(`[edgeTTS generateNarration] Writing ${audioBuffer.length} bytes to ${chunkPath}`);
      await fs.writeFile(chunkPath, audioBuffer);
      allAudioFiles.push(chunkPath);

      if (wordBoundaries.length > 0) {
        const globalWords = wordBoundariesToTimestamps(wordBoundaries, globalTimeOffset);
        logger.info(`[edgeTTS generateNarration] ${wordBoundaries.length} word(s) mapped — first: "${globalWords[0]?.word}" @${globalWords[0]?.start}s, last: "${globalWords[globalWords.length - 1]?.word}" @${globalWords[globalWords.length - 1]?.end}s`);
        allWords.push(...globalWords);
        segWordCount += globalWords.length;

        const last = wordBoundaries[wordBoundaries.length - 1];
        const chunkDuration = (last.offset + last.duration) / 10_000_000;
        logger.info(`[edgeTTS generateNarration] Chunk duration from last word boundary: ${chunkDuration.toFixed(3)}s`);
        globalTimeOffset += chunkDuration;
        logger.info(`[edgeTTS generateNarration] globalTimeOffset now: ${globalTimeOffset.toFixed(3)}s`);
      } else {
        logger.warn(`[edgeTTS generateNarration] No word boundaries for seg ${i + 1} chunk ${j + 1} — time offset unchanged at ${globalTimeOffset.toFixed(3)}s`);
      }
    }

    const segEnd = +globalTimeOffset.toFixed(3);
    logger.info(`[edgeTTS generateNarration] Segment ${i + 1} complete — ${segWordCount} words, start: ${segStartTime.toFixed(3)}s, end: ${segEnd}s`);
    segmentBoundaries.push({
      segmentIndex: i,
      startTime: +segStartTime.toFixed(3),
      endTime: segEnd,
      wordCount: segWordCount,
      text: segText.slice(0, 80),
    });

    // Breathing room: inject silence between segments for natural pacing
    if (i < segments.length - 1) {
      const pauseDuration = MOOD_BREATHING_ROOM[moodKey] || DEFAULT_BREATHING_ROOM;
      const silencePath = path.join(audioDir, `silence-seg${i}.mp3`);
      generateSilenceFile(pauseDuration, silencePath);
      allAudioFiles.push(silencePath);
      globalTimeOffset += pauseDuration;
      logger.info(`[edgeTTS] Breathing room: +${pauseDuration.toFixed(2)}s after segment ${i + 1} (mood: ${moodKey || 'default'})`);
    }
  }

  logger.info(`[edgeTTS generateNarration] All segments done — ${allAudioFiles.length} chunk file(s), ${allWords.length} total words, total duration: ${globalTimeOffset.toFixed(3)}s`);
  onProgress('Merging audio segments...', 78);

  if (allAudioFiles.length === 1) {
    logger.info(`[edgeTTS generateNarration] Single chunk — copying directly to ${narrationPath}`);
    await fs.copyFile(allAudioFiles[0], narrationPath);
  } else {
    logger.info(`[edgeTTS generateNarration] Running ffmpeg concat on ${allAudioFiles.length} files`);
    await concatAudioFiles(allAudioFiles, narrationPath);
  }

  logger.info(`[edgeTTS generateNarration] Writing timestamps.json — ${allWords.length} words`);
  await fs.writeFile(timestampsPath, JSON.stringify({
    words: allWords,
    duration: globalTimeOffset,
    segmentBoundaries,
  }, null, 2));

  logger.info(`[edgeTTS generateNarration] Cleaning up ${allAudioFiles.length} chunk file(s)`);
  for (const f of allAudioFiles) { try { await fs.unlink(f); } catch { } }

  onProgress('Narration audio saved', 90);
  logger.info(`[edgeTTS generateNarration] DONE — ${narrationPath}`);
  return narrationPath;
}

export async function generatePreview(projectId, voiceName) {
  logger.info(`[edgeTTS generatePreview] START — project: ${projectId}, voice: ${voiceName}`);

  logger.info(`[edgeTTS generatePreview] Loading script.json...`);
  const script = await safeReadJson(projectPath(projectId, 'script.json'));
  if (!script || !script.segments?.length) {
    logger.error(`[edgeTTS generatePreview] No script found or empty segments`);
    throw new Error('No script found');
  }

  const audioDir = projectPath(projectId, 'audio');
  await ensureDir(audioDir);

  const previewText = script.hook
    ? `${script.hook} ${script.segments[0]?.text || ''}`
    : script.segments[0]?.text || 'Preview text not available.';
  const trimmed = previewText.slice(0, 500);
  logger.info(`[edgeTTS generatePreview] Preview text: ${trimmed.length} chars — "${trimmed.slice(0, 80)}..."`);

  const { audioBuffer } = await synthesiseChunk(voiceName, trimmed);

  const outputPath = path.join(audioDir, 'preview.mp3');
  logger.info(`[edgeTTS generatePreview] Writing ${audioBuffer.length} bytes to ${outputPath}`);
  await fs.writeFile(outputPath, audioBuffer);

  logger.info(`[edgeTTS generatePreview] DONE — ${outputPath}`);
  return outputPath;
}
