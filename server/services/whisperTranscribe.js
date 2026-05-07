/**
 * Audio transcription via the OpenAI Whisper API (verbose_json with
 * word-level timestamps). Used by the translation feature to get a clean
 * Hindi transcript with timing we can later cut on.
 *
 * Requires OPENAI_API_KEY in .env.
 *
 * Why not local Whisper for v1: install pain on Windows + slower wall-clock.
 * The API is $0.006/min — ~$0.18 for a 30-min video. Local-Whisper swap
 * is a Phase 4 polish.
 */

import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { ensureDir, projectPath } from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { logger } from '../utils/logger.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';

/**
 * Pull the audio out of the source video as a 16kHz mono mp3 — keeps the
 * upload size to Whisper small (Whisper API caps at 25 MB).
 */
function extractAudio(srcPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .setFfmpegPath(getFfmpegPath())
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .audioChannels(1)
      .audioFrequency(16000)
      .output(outPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Audio extract failed: ${err.message}`)))
      .run();
  });
}

/**
 * @param {string} projectId
 * @param {string} videoPath
 * @param {{language?: string, prompt?: string}} opts
 *   language: ISO code (e.g. 'hi'). Omit to let Whisper auto-detect.
 *   prompt:   optional context string Whisper uses to bias punctuation/spelling.
 */
export async function transcribeForTranslation(projectId, videoPath, { language, prompt } = {}, onProgress = () => {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set in .env (needed for Whisper transcription)');

  const audioDir = projectPath(projectId, 'audio');
  await ensureDir(audioDir);
  const audioPath = path.join(audioDir, 'source-audio.mp3');

  onProgress('Extracting audio for transcription...', 10);
  await extractAudio(videoPath, audioPath);

  const stats = fs.statSync(audioPath);
  const sizeMB = stats.size / (1024 * 1024);
  if (sizeMB > 24.5) {
    throw new Error(
      `Extracted audio is ${sizeMB.toFixed(1)} MB — Whisper API limit is 25 MB. ` +
      `Source is too long; lower the cap or chunk before sending (Phase 4 enhancement).`
    );
  }

  onProgress(`Sending ${sizeMB.toFixed(1)} MB to Whisper (${language || 'auto-detect'})...`, 30);

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)]), 'audio.mp3');
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  if (prompt)   form.append('prompt', prompt);

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Whisper API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const data = await res.json();
  const result = {
    language: data.language || language || null,
    duration: data.duration,
    text: data.text || '',
    segments: (data.segments || []).map(s => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    })),
    words: (data.words || []).map(w => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })),
  };

  await fs.promises.writeFile(
    path.join(audioDir, 'source-transcript.json'),
    JSON.stringify(result, null, 2)
  );

  onProgress('Transcription complete', 100);
  logger.info(
    `[whisperTranscribe] ${result.language} · ${result.segments.length} segments · ` +
    `${result.words.length} words · ${result.duration?.toFixed(1)}s`
  );
  return result;
}
