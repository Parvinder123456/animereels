/**
 * Translation feature routes.
 *
 *   POST /api/translate
 *     Body: { name?, url, topic?, language? = 'hi', mode? = 'auto' | 'manual' }
 *     mode='auto':   download → Whisper → topic-find → DeepSeek translate → script.json
 *     mode='manual': download + extract audio only — STOPS, waits for the user
 *                    to paste a transcript via /translate/manual-transcript.
 *     Returns { id }.
 *
 *   POST /api/projects/:id/translate/manual-transcript
 *     Body: { transcript: string, format? = 'auto' | 'plain' | 'json',
 *             language?, topic? }
 *     Accepts a user-supplied transcript (e.g. from the Gemini consumer
 *     mobile app). 'plain' text is auto-segmented across the audio
 *     duration. 'json' expects {segments:[{id,start,end,text}]}.
 *     Runs topic-find + translate from there.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import {
  ensureDir, safeReadJson, safeWriteJson, projectDir, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { downloadYouTubeVideo } from '../services/youtubeDownloader.js';
import { transcribeForTranslation } from '../services/whisperTranscribe.js';
import { findTopicWindow } from '../services/segmentFinder.js';
import { translateAndScript } from '../services/translationService.js';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import ffprobeStatic from 'ffprobe-static';
ffmpeg.setFfprobePath(ffprobeStatic.path);

const router = Router();

function newProject(name, mode) {
  const id = `proj_${uuidv4().slice(0, 8)}`;
  return {
    id,
    name: name || 'Translated Clip',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: { upload: 'pending', panels: 'pending', script: 'pending', voice: 'pending', render: 'pending' },
    config: {
      voiceId: '',
      duration: 60,
      detail: 'medium',
      projectType: 'translate',
      transcribeMode: mode === 'manual' ? 'manual' : 'auto',
    },
    stats: { chapterCount: 0, pageCount: 0, panelCount: 0, scriptWordCount: 0, audioDurationSec: 0, videoDurationSec: 0 },
    errors: [],
  };
}

async function probeDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data?.format?.duration) return resolve(0);
      resolve(parseFloat(data.format.duration));
    });
  });
}

// ─── POST / ──────────────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { name, url, topic, language = 'hi', mode = 'auto' } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required (YouTube link)' });
    }

    const project = newProject(name, mode);
    await ensureDir(projectDir(project.id));
    await safeWriteJson(projectPath(project.id, 'project.json'), project);
    if (topic) await safeWriteJson(projectPath(project.id, 'translate-meta.json'), { topic, language, url });
    logger.info(`[translate] created ${project.id} mode=${mode} url=${url} topic="${topic || ''}"`);

    if (isRunning(project.id)) return res.status(409).json({ error: 'Job already running' });

    runJob(project.id, async () => {
      const onStep = (step) => (message, percent) => {
        logger.info(`[translate/${step}] ${percent}% — ${message}`);
        emit(project.id, step, message, percent);
      };

      try {
        project.state.upload = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        const dl = await downloadYouTubeVideo(project.id, url, onStep('upload'));
        project.state.upload = 'complete';
        project.stats.videoDurationSec = dl.durationSec;
        if (!project.name || project.name === 'Translated Clip') project.name = dl.title || project.name;
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'upload', 'Download complete', 100);

        if (mode === 'manual') {
          project.state.panels = 'processing';
          await safeWriteJson(projectPath(project.id, 'project.json'), project);

          // Extract audio so the user can grab it and feed to Gemini mobile.
          const audioDir = projectPath(project.id, 'audio');
          await ensureDir(audioDir);
          const audioPath = path.join(audioDir, 'source-audio.mp3');
          await new Promise((resolve, reject) => {
            ffmpeg(dl.path)
              .noVideo()
              .audioCodec('libmp3lame')
              .audioBitrate('64k')
              .audioChannels(1)
              .audioFrequency(16000)
              .output(audioPath)
              .on('end', resolve)
              .on('error', reject)
              .run();
          });

          project.state.panels = 'complete';
          await safeWriteJson(projectPath(project.id, 'project.json'), project);
          emit(project.id, 'panels', 'Audio extracted — paste your transcript to continue', 100);
          return;
        }

        // Auto mode: run Whisper.
        project.state.panels = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        const transcript = await transcribeForTranslation(
          project.id, dl.path,
          { language, prompt: topic ? `Discussion about ${topic}.` : undefined },
          onStep('panels'),
        );

        await runWindowAndTranslate(project, transcript, topic, language, onStep);
      } catch (err) {
        project.state.script = 'error';
        project.errors.push({ step: 'translate', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'script', `Error: ${err.message}`, -1);
        logger.error(`[translate] ${project.id} failed: ${err.message}`);
      }
    }).catch(() => {});

    res.status(202).json({ id: project.id, message: 'Translation job started' });
  } catch (err) { next(err); }
});

// ─── POST /api/translate/:id/manual-transcript ──────────────────────────────

router.post('/:id/manual-transcript', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { transcript, format = 'auto', language, topic } = req.body || {};
    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'transcript (string) is required' });
    }

    const project = await safeReadJson(projectPath(id, 'project.json'));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (isRunning(id)) return res.status(409).json({ error: 'Job already running' });

    const meta = await safeReadJson(projectPath(id, 'translate-meta.json'), {});
    const useTopic = topic ?? meta.topic;
    const useLanguage = language ?? meta.language ?? 'hi';

    runJob(id, async () => {
      const onStep = (step) => (message, percent) => emit(id, step, message, percent);
      try {
        const segments = await parseTranscript(id, transcript, format);
        if (!segments.length) throw new Error('Transcript parsed to zero segments');

        const fakeTranscript = {
          language: useLanguage,
          duration: segments.at(-1).end,
          text: segments.map(s => s.text).join(' '),
          segments,
          words: [],
        };
        await safeWriteJson(
          projectPath(id, 'audio', 'source-transcript.json'),
          { backend: 'manual', ...fakeTranscript },
        );

        project.state.panels = 'complete';
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'panels', `Manual transcript accepted (${segments.length} segments)`, 100);

        await runWindowAndTranslate(project, fakeTranscript, useTopic, useLanguage, onStep);
      } catch (err) {
        project.state.script = 'error';
        project.errors.push({ step: 'translate', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'script', `Error: ${err.message}`, -1);
        logger.error(`[translate/manual] ${id} failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Manual transcript accepted, translating' });
  } catch (err) { next(err); }
});

// ─── POST /api/translate/:id/manual-script ──────────────────────────────────
// Skips Whisper AND the DeepSeek translation step entirely. The user
// pastes an already-English narration script (e.g. produced by the Gemini
// consumer mobile app) and we write it directly to script.json.

router.post('/:id/manual-script', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { script: scriptIn, startSec, endSec } = req.body || {};
    if (!scriptIn) return res.status(400).json({ error: 'script (string or object) is required' });

    const project = await safeReadJson(projectPath(id, 'project.json'));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (isRunning(id)) return res.status(409).json({ error: 'Job already running' });

    const sourcePath = projectPath(id, 'source.mp4');
    const sourceDuration = await probeDuration(sourcePath);
    if (sourceDuration <= 0) {
      return res.status(400).json({ error: 'Source video missing or unreadable — wait for download to finish' });
    }

    const window = {
      startSec: Math.max(0, Number(startSec) || 0),
      endSec:   Math.min(sourceDuration, Number(endSec) || Math.min(sourceDuration, 180)),
    };
    if (window.endSec <= window.startSec) {
      return res.status(400).json({ error: `endSec (${window.endSec}) must be greater than startSec (${window.startSec})` });
    }

    const script = parseEnglishScript(scriptIn, window);
    if (!script.segments.length) return res.status(400).json({ error: 'Script parsed to zero segments' });
    script.sourceWindow = window;
    script.sourceLanguage = 'manual';

    await safeWriteJson(projectPath(id, 'script.json'), script);
    await safeWriteJson(projectPath(id, 'translate-window.json'), { window, topic: null });

    project.state.panels = 'complete';
    project.state.script = 'complete';
    project.config.duration = Math.round(window.endSec - window.startSec);
    project.stats.panelCount = 1;
    project.stats.scriptWordCount = script.segments.reduce(
      (n, s) => n + (s.text ? s.text.split(/\s+/).filter(Boolean).length : 0), 0
    );
    project.updatedAt = new Date().toISOString();
    await safeWriteJson(projectPath(id, 'project.json'), project);
    emit(id, 'script', `Manual English script accepted (${script.segments.length} segments)`, 100);

    res.json({ success: true, segments: script.segments.length, window });
  } catch (err) { next(err); }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Accept either:
 *   - a JSON object  { title, hook?, segments: [{text, mood?}] }
 *   - a JSON array   [{text, mood?}, ...]
 *   - plain English text — auto-segmented across the window by sentence
 *
 * Returns { title, hook, segments: [{text, mood, sourceStart, sourceEnd}] }
 * with timestamps interpolated linearly across the source window so the
 * existing renderer (which uses sourceStart/sourceEnd) Just Works.
 */
function parseEnglishScript(input, window) {
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


async function runWindowAndTranslate(project, transcript, topic, language, onStep) {
  let window = null;
  if (topic) {
    const found = await findTopicWindow(transcript.segments, topic);
    if (!found.found) throw new Error(`Topic "${topic}" not found in transcript: ${found.rationale}`);
    window = { startSec: found.startSec, endSec: found.endSec };
  } else {
    const lastEnd = transcript.segments.at(-1)?.end || transcript.duration || 0;
    window = { startSec: 0, endSec: Math.min(lastEnd, 180) };
  }
  await safeWriteJson(projectPath(project.id, 'translate-window.json'), { window, topic: topic || null });
  project.state.panels = 'complete';
  project.stats.panelCount = 1;
  await safeWriteJson(projectPath(project.id, 'project.json'), project);

  project.state.script = 'processing';
  await safeWriteJson(projectPath(project.id, 'project.json'), project);
  const script = await translateAndScript(
    project.id, transcript.segments,
    { window, sourceLanguage: transcript.language || language },
    onStep('script'),
  );
  project.state.script = 'complete';
  project.stats.scriptWordCount = (script.segments || []).reduce(
    (n, s) => n + (s.text ? s.text.split(/\s+/).filter(Boolean).length : 0), 0
  );
  project.config.duration = Math.round(window.endSec - window.startSec);
  project.updatedAt = new Date().toISOString();
  await safeWriteJson(projectPath(project.id, 'project.json'), project);
  emit(project.id, 'script', 'Translation complete', 100);
}

/**
 * Turn a user-pasted transcript into Whisper-shaped segments.
 *
 * - format='json': expects {segments:[{id,start,end,text}]} or just an array.
 * - format='plain' or 'auto' (and not parseable as JSON): split by sentence
 *   boundary and distribute timestamps evenly across the source audio's
 *   duration (probed from source.mp4 / source-audio.mp3).
 */
async function parseTranscript(projectId, raw, format) {
  const trimmed = raw.trim();

  if (format === 'json' || (format === 'auto' && trimmed.startsWith('{')) || (format === 'auto' && trimmed.startsWith('['))) {
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch (e) { throw new Error(`Could not parse transcript as JSON: ${e.message}`); }
    const arr = Array.isArray(parsed) ? parsed : (parsed.segments || []);
    return arr
      .map((s, i) => ({
        id: typeof s.id === 'number' ? s.id : i,
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text || s.transcript || s.content || '').trim(),
      }))
      .filter(s => s.text);
  }

  // Plain text path — split into sentences and distribute timestamps evenly.
  const sourcePath = projectPath(projectId, 'source.mp4');
  const audioPath  = projectPath(projectId, 'audio', 'source-audio.mp3');
  const probePath = (await fileExists(sourcePath)) ? sourcePath : audioPath;
  const totalSec = await probeDuration(probePath);
  if (totalSec <= 0) throw new Error('Could not determine audio duration for plain transcript distribution');

  const sentences = trimmed
    .replace(/\r/g, '')
    .split(/(?<=[\.\?!।॥])\s+|\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!sentences.length) return [];

  const totalChars = sentences.reduce((n, s) => n + s.length, 0);
  let cursor = 0;
  return sentences.map((text, i) => {
    const share = (text.length / totalChars) * totalSec;
    const start = cursor;
    const end = Math.min(totalSec, cursor + share);
    cursor = end;
    return { id: i, start: +start.toFixed(3), end: +end.toFixed(3), text };
  });
}

export default router;
