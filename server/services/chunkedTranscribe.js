/**
 * Chunked Whisper transcription for long sources (anything >20 min).
 *
 * Splits the source audio into N chunks via ffmpeg, transcribes each
 * through the existing whisperTranscribe backend router (gemini / groq /
 * openai), then merges the chunked segments back into one stream with
 * timestamps offset to absolute time.
 *
 * Why chunking is necessary:
 *  - Gemini inline-data: hard cap ~20 MB (~30 min @ 64 kbps mono)
 *  - Gemini Files API: 2 GB cap but the JSON OUTPUT is capped at ~64 K
 *    tokens → a 60+ min single-call transcript silently truncates.
 *  - Groq Whisper / OpenAI Whisper: 25 MB file cap.
 *
 * Strategy: ~18-min audio chunks. Keeps each call well under every limit
 * for every backend and keeps output JSON comfortably below truncation.
 */

import fs from 'fs/promises';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import { ensureDir, projectPath, safeWriteJson } from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { transcribeRawAudio, transcribeForTranslation } from './whisperTranscribe.js';
import { logger } from '../utils/logger.js';

const CHUNK_SEC = 18 * 60; // 18 minutes per chunk

function extractAudioChunk(srcPath, startSec, durationSec, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .seekInput(startSec)
      .duration(durationSec)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .audioChannels(1)
      .audioFrequency(16000)
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Audio chunk extract failed @${startSec}s: ${err.message}`)))
      .run();
  });
}

/**
 * Plan chunk windows that cover [0, totalSec] with each chunk ≤ CHUNK_SEC.
 * Returns [{startSec, durationSec}] — the last chunk may be shorter.
 */
function planChunks(totalSec) {
  const windows = [];
  let cursor = 0;
  while (cursor < totalSec) {
    const remaining = totalSec - cursor;
    const dur = Math.min(CHUNK_SEC, remaining);
    windows.push({ startSec: cursor, durationSec: dur });
    cursor += dur;
  }
  return windows;
}

/**
 * Transcribe a long source video. Writes the merged transcript to
 * audio/source-transcript.json (same shape as the existing single-shot
 * whisperTranscribe.js output) so downstream code is unchanged.
 *
 * @param {string} projectId
 * @param {string} videoPath
 * @param {number} totalSec  total duration of videoPath (pre-probed)
 * @param {{language?:string, prompt?:string, backend?:string}} opts
 */
export async function transcribeChunked(projectId, videoPath, totalSec, opts = {}, onProgress = () => {}) {
  const audioDir = projectPath(projectId, 'audio');
  await ensureDir(audioDir);

  const chunks = planChunks(totalSec);
  if (chunks.length === 1) {
    // Short source — just call the existing single-shot transcriber.
    return transcribeForTranslation(projectId, videoPath, opts, onProgress);
  }

  logger.info(`[chunkedTranscribe] ${(totalSec / 60).toFixed(1)} min source → ${chunks.length} chunks of ${CHUNK_SEC / 60} min`);

  const merged = {
    backend: opts.backend || 'auto',
    language: opts.language || null,
    duration: totalSec,
    text: '',
    segments: [],
    words: [],
    chunked: true,
    chunkCount: chunks.length,
  };

  let segmentId = 0;
  const tmpDir = path.join(audioDir, '_chunks_tmp');
  await ensureDir(tmpDir);

  for (let i = 0; i < chunks.length; i++) {
    const { startSec, durationSec } = chunks[i];
    const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(2, '0')}.mp3`);

    onProgress(
      `Extracting chunk ${i + 1}/${chunks.length} (${(startSec / 60).toFixed(1)}-${((startSec + durationSec) / 60).toFixed(1)} min)`,
      Math.round((i / chunks.length) * 10)
    );
    await extractAudioChunk(videoPath, startSec, durationSec, chunkPath);

    onProgress(
      `Transcribing chunk ${i + 1}/${chunks.length}...`,
      10 + Math.round((i / chunks.length) * 85)
    );

    const chunkResult = await transcribeRawAudio(chunkPath, opts).catch(err => {
      logger.warn(`[chunkedTranscribe] chunk ${i + 1} failed: ${err.message} — continuing with empty segments`);
      return { language: opts.language || null, duration: durationSec, text: '', segments: [], words: [] };
    });

    if (!merged.language && chunkResult.language) merged.language = chunkResult.language;
    if (chunkResult.text) merged.text += (merged.text ? ' ' : '') + chunkResult.text;

    for (const seg of (chunkResult.segments || [])) {
      merged.segments.push({
        id:    segmentId++,
        start: +(seg.start + startSec).toFixed(3),
        end:   +(seg.end   + startSec).toFixed(3),
        text:  seg.text,
      });
    }
    for (const w of (chunkResult.words || [])) {
      merged.words.push({
        word:  w.word,
        start: +(w.start + startSec).toFixed(3),
        end:   +(w.end   + startSec).toFixed(3),
      });
    }

    // Clean up the chunk file as we go.
    try { await fs.unlink(chunkPath); } catch {}
  }

  try { await fs.rmdir(tmpDir); } catch {}

  await safeWriteJson(path.join(audioDir, 'source-transcript.json'), merged);
  onProgress(`Transcription complete (${merged.segments.length} segments)`, 100);
  logger.info(
    `[chunkedTranscribe] merged ${chunks.length} chunks → ${merged.segments.length} segments · ${merged.language}`
  );
  return merged;
}
