/**
 * Audio transcription router. Backends:
 *
 *   gemini  (default, cheapest) — Gemini Flash native audio understanding
 *                                 via the existing GEMINI_API_KEY. Free tier
 *                                 eligible. Returns segment-level timestamps.
 *   groq                        — Groq-hosted Whisper-large-v3-turbo
 *                                 (~$0.04/hr). Returns word + segment timestamps.
 *   openai                      — OpenAI's whisper-1 (~$0.36/hr). Reference
 *                                 implementation, kept for fallback.
 *
 * Selected via `transcriptionBackend` in settings.json (overridable per call).
 *
 * For the translate feature we only need segment-level timestamps — words
 * are unused downstream (the burned-in subs come from the English TTS's
 * own word boundaries, not the source-language transcript).
 */

import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ensureDir, projectPath } from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { getSettings } from '../utils/appSettings.js';
import { logger } from '../utils/logger.js';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com';

// ─── Audio extraction (shared) ───────────────────────────────────────────────

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

// ─── Gemini Flash (native audio) ─────────────────────────────────────────────

const GEMINI_TRANSCRIBE_PROMPT = `
You are a transcription engine. Transcribe the attached audio. Return a single
JSON object — no prose, no markdown, no code fence:

{
  "language": "<ISO 639-1 code of the dominant language, e.g. 'hi' for Hindi>",
  "duration": <total audio duration in seconds, number>,
  "segments": [
    { "id": 0, "start": <sec>, "end": <sec>, "text": "<verbatim transcript of this chunk>" },
    { "id": 1, "start": <sec>, "end": <sec>, "text": "..." }
  ]
}

RULES:
- Break the audio into segments of 5-15 seconds each at natural pauses.
- "start" and "end" are seconds from the start of the audio.
- "text" must be the verbatim transcript in the ORIGINAL language (do not translate).
- Cover the entire audio — every second between 0 and duration must be in some segment.
- IDs are 0-based and increment by 1.
- Output ONLY the JSON object.
`.trim();

function extractJsonObject(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
  if (!raw) throw new Error('No JSON object in transcription response');
  return JSON.parse(raw);
}

const INLINE_LIMIT_MB = 19; // Gemini inline-data cap is ~20 MB; use Files API above this

// ─── Gemini Files API (REST) ─────────────────────────────────────────────────

/**
 * Upload a file via the Gemini Files API (direct REST) and poll until ACTIVE.
 * Returns { name, uri, mimeType } for use in generateContent fileData parts.
 */
async function uploadToFilesAPI(apiKey, filePath, mimeType) {
  const displayName = path.basename(filePath);
  const fileBytes = fs.readFileSync(filePath);
  const numBytes = fileBytes.length;

  // Step 1: Start resumable upload to get the upload URI
  logger.info(`[whisperTranscribe] Uploading ${displayName} (${(numBytes / 1048576).toFixed(1)} MB) via Files API...`);
  const startRes = await fetch(
    `${GEMINI_FILES_BASE}/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { displayName } }),
    }
  );
  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Files API start upload failed (${startRes.status}): ${errText.slice(0, 500)}`);
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API did not return an upload URL');

  // Step 2: Upload the file bytes
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBytes,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Files API upload failed (${uploadRes.status}): ${errText.slice(0, 500)}`);
  }
  let fileInfo = (await uploadRes.json()).file;

  // Step 3: Poll until processing is complete
  while (fileInfo.state === 'PROCESSING') {
    logger.info(`[whisperTranscribe] Files API: state=PROCESSING, waiting...`);
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(
      `${GEMINI_FILES_BASE}/v1beta/${fileInfo.name}?key=${apiKey}`
    );
    if (!pollRes.ok) throw new Error(`Files API poll failed: ${pollRes.status}`);
    fileInfo = await pollRes.json();
  }
  if (fileInfo.state === 'FAILED') {
    throw new Error(`Gemini Files API processing failed for ${displayName}`);
  }

  logger.info(`[whisperTranscribe] Files API upload ready: ${fileInfo.uri}`);
  return fileInfo; // { name, uri, mimeType, ... }
}

/** Delete a file from Gemini Files API storage */
async function deleteFromFilesAPI(apiKey, fileName) {
  await fetch(`${GEMINI_FILES_BASE}/v1beta/${fileName}?key=${apiKey}`, { method: 'DELETE' });
}

async function geminiTranscribe(audioPath, { language, prompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env (transcriptionBackend=gemini)');

  const buf = fs.readFileSync(audioPath);
  const sizeMB = buf.length / (1024 * 1024);
  const useFilesAPI = sizeMB > INLINE_LIMIT_MB;

  const settings = await getSettings();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: settings.geminiModel,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });

  const langHint = language ? `\nThe primary language is "${language}".` : '';
  const ctxHint  = prompt   ? `\nContext (use to bias spelling): ${prompt}` : '';

  let audioPart;
  let uploadedFileName = null;

  if (useFilesAPI) {
    logger.info(`[whisperTranscribe] Audio is ${sizeMB.toFixed(1)} MB (>${INLINE_LIMIT_MB} MB) — using Files API`);
    const fileInfo = await uploadToFilesAPI(apiKey, audioPath, 'audio/mp3');
    uploadedFileName = fileInfo.name;
    audioPart = { fileData: { mimeType: fileInfo.mimeType, fileUri: fileInfo.uri } };
  } else {
    audioPart = { inlineData: { data: buf.toString('base64'), mimeType: 'audio/mp3' } };
  }

  try {
    const result = await model.generateContent([
      GEMINI_TRANSCRIBE_PROMPT + langHint + ctxHint,
      audioPart,
    ]);

    const text = result.response.text();
    const data = extractJsonObject(text);

    return {
      language: data.language || language || null,
      duration: Number(data.duration) || 0,
      text: (data.segments || []).map(s => s.text).join(' '),
      segments: (data.segments || []).map((s, i) => ({
        id: typeof s.id === 'number' ? s.id : i,
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text || '').trim(),
      })),
      words: [], // Gemini doesn't return word-level timestamps; not needed downstream
    };
  } finally {
    // Clean up the uploaded file from Gemini's storage
    if (uploadedFileName) {
      try {
        await deleteFromFilesAPI(apiKey, uploadedFileName);
        logger.info(`[whisperTranscribe] Cleaned up Files API upload: ${uploadedFileName}`);
      } catch (e) {
        logger.warn(`[whisperTranscribe] Failed to delete uploaded file: ${e.message}`);
      }
    }
  }
}

// ─── Groq Whisper (whisper-large-v3-turbo) ───────────────────────────────────

async function groqTranscribe(audioPath, { language, prompt }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set in .env (transcriptionBackend=groq)');

  const settings = await getSettings();
  const model = settings.groqWhisperModel || 'whisper-large-v3-turbo';

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)]), 'audio.mp3');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  if (language) form.append('language', language);
  if (prompt)   form.append('prompt', prompt);

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq Whisper ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const data = await res.json();
  return {
    language: data.language || language || null,
    duration: data.duration,
    text: data.text || '',
    segments: (data.segments || []).map(s => ({
      id: s.id, start: s.start, end: s.end, text: s.text.trim(),
    })),
    words: (data.words || []).map(w => ({ word: w.word, start: w.start, end: w.end })),
  };
}

// ─── OpenAI Whisper (whisper-1) ──────────────────────────────────────────────

async function openaiTranscribe(audioPath, { language, prompt }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set in .env (transcriptionBackend=openai)');

  const sizeMB = fs.statSync(audioPath).size / (1024 * 1024);
  if (sizeMB > 24.5) throw new Error(`Audio ${sizeMB.toFixed(1)} MB exceeds OpenAI Whisper 25 MB cap`);

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(audioPath)]), 'audio.mp3');
  form.append('model', OPENAI_MODEL);
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
  if (!res.ok) throw new Error(`OpenAI Whisper ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const data = await res.json();
  return {
    language: data.language || language || null,
    duration: data.duration,
    text: data.text || '',
    segments: (data.segments || []).map(s => ({
      id: s.id, start: s.start, end: s.end, text: s.text.trim(),
    })),
    words: (data.words || []).map(w => ({ word: w.word, start: w.start, end: w.end })),
  };
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * @param {string} projectId
 * @param {string} videoPath
 * @param {{language?:string, prompt?:string, backend?:'gemini'|'groq'|'openai'}} opts
 */
export async function transcribeForTranslation(projectId, videoPath, opts = {}, onProgress = () => {}) {
  const settings = await getSettings();
  const backend = opts.backend || settings.transcriptionBackend || 'gemini';

  const audioDir = projectPath(projectId, 'audio');
  await ensureDir(audioDir);
  const audioPath = path.join(audioDir, 'source-audio.mp3');

  onProgress('Extracting audio for transcription...', 10);
  await extractAudio(videoPath, audioPath);
  const sizeMB = fs.statSync(audioPath).size / (1024 * 1024);

  onProgress(`Transcribing ${sizeMB.toFixed(1)} MB via ${backend} (${opts.language || 'auto'})...`, 30);

  let result;
  if (backend === 'gemini')      result = await geminiTranscribe(audioPath, opts);
  else if (backend === 'groq')   result = await groqTranscribe(audioPath, opts);
  else if (backend === 'openai') result = await openaiTranscribe(audioPath, opts);
  else throw new Error(`Unknown transcriptionBackend: ${backend}`);

  await fs.promises.writeFile(
    path.join(audioDir, 'source-transcript.json'),
    JSON.stringify({ backend, ...result }, null, 2),
  );

  onProgress('Transcription complete', 100);
  logger.info(
    `[whisperTranscribe] backend=${backend} · ${result.language} · ` +
    `${result.segments.length} segments · ${result.duration?.toFixed?.(1) || '?'}s`
  );
  return result;
}
