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

async function geminiTranscribe(audioPath, { language, prompt }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env (transcriptionBackend=gemini)');

  const buf = fs.readFileSync(audioPath);
  const sizeMB = buf.length / (1024 * 1024);
  if (sizeMB > 19) {
    throw new Error(
      `Audio is ${sizeMB.toFixed(1)} MB — Gemini inline-audio limit is ~20 MB. ` +
      `Use transcriptionBackend=groq for longer audio (Phase 4 will add Files-API chunking).`
    );
  }

  const settings = await getSettings();
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: settings.geminiModel,
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });

  const langHint = language ? `\nThe primary language is "${language}".` : '';
  const ctxHint  = prompt   ? `\nContext (use to bias spelling): ${prompt}` : '';

  const result = await model.generateContent([
    GEMINI_TRANSCRIBE_PROMPT + langHint + ctxHint,
    { inlineData: { data: buf.toString('base64'), mimeType: 'audio/mp3' } },
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
