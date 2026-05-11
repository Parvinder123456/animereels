/**
 * Audio transcription via Gemini Flash native audio understanding.
 *
 * The file name is legacy ("whisper") — there is no actual Whisper involved.
 * The single backend is Gemini, called either with inline audio (≤19 MB)
 * or via the Files API for longer audio (≤2 GB per upload, but downstream
 * chunkedTranscribe.js splits into 18-min chunks well below that).
 *
 * Why Gemini-only: free tier eligible, single API key with the rest of the
 * pipeline, no extra vendor. Whisper backends were removed to keep one
 * canonical audio path.
 */

import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ensureDir, projectPath } from '../utils/fileHelpers.js';
import { getFfmpegPath } from './gpuDetect.js';
import { getSettings } from '../utils/appSettings.js';
import { logger } from '../utils/logger.js';

const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com';
const INLINE_LIMIT_MB = 19; // Gemini inline-data cap is ~20 MB; Files API above this

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

// ─── Gemini transcription prompt ─────────────────────────────────────────────

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

// ─── Gemini Files API (REST) ─────────────────────────────────────────────────

async function uploadToFilesAPI(apiKey, filePath, mimeType) {
  const displayName = path.basename(filePath);
  const fileBytes = fs.readFileSync(filePath);
  const numBytes = fileBytes.length;

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

  while (fileInfo.state === 'PROCESSING') {
    logger.info(`[whisperTranscribe] Files API: state=PROCESSING, waiting...`);
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(`${GEMINI_FILES_BASE}/v1beta/${fileInfo.name}?key=${apiKey}`);
    if (!pollRes.ok) throw new Error(`Files API poll failed: ${pollRes.status}`);
    fileInfo = await pollRes.json();
  }
  if (fileInfo.state === 'FAILED') {
    throw new Error(`Gemini Files API processing failed for ${displayName}`);
  }

  logger.info(`[whisperTranscribe] Files API upload ready: ${fileInfo.uri}`);
  return fileInfo;
}

async function deleteFromFilesAPI(apiKey, fileName) {
  await fetch(`${GEMINI_FILES_BASE}/v1beta/${fileName}?key=${apiKey}`, { method: 'DELETE' });
}

async function geminiTranscribe(audioPath, { language, prompt } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');

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
      words: [],
    };
  } finally {
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

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Transcribe a pre-extracted audio file via Gemini. Pure in/out — no
 * project file writes. Used by chunkedTranscribe.js.
 */
export async function transcribeRawAudio(audioPath, opts = {}) {
  return geminiTranscribe(audioPath, opts);
}

/**
 * Single-shot: extract audio from a video and transcribe it. Writes the
 * result to data/projects/<id>/audio/source-transcript.json.
 */
export async function transcribeForTranslation(projectId, videoPath, opts = {}, onProgress = () => {}) {
  const audioDir = projectPath(projectId, 'audio');
  await ensureDir(audioDir);
  const audioPath = path.join(audioDir, 'source-audio.mp3');

  onProgress('Extracting audio for transcription...', 10);
  await extractAudio(videoPath, audioPath);
  const sizeMB = fs.statSync(audioPath).size / (1024 * 1024);

  onProgress(`Transcribing ${sizeMB.toFixed(1)} MB via Gemini (${opts.language || 'auto'})...`, 30);
  const result = await geminiTranscribe(audioPath, opts);

  await fs.promises.writeFile(
    path.join(audioDir, 'source-transcript.json'),
    JSON.stringify({ backend: 'gemini', ...result }, null, 2),
  );

  onProgress('Transcription complete', 100);
  logger.info(
    `[whisperTranscribe] ${result.language} · ${result.segments.length} segments · ` +
    `${result.duration?.toFixed?.(1) || '?'}s`
  );
  return result;
}
