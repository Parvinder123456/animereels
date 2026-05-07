/**
 * Translation feature routes:
 *
 *   POST /api/translate
 *     Body: { name?, url, topic?, language? = 'hi' }
 *     Creates a project, downloads the YouTube video, transcribes with
 *     Whisper, finds the topic window if a topic is given (otherwise
 *     uses the whole video), translates with DeepSeek, writes script.json.
 *     Returns { id } on success — caller then triggers voice + render
 *     via the existing endpoints.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ensureDir, safeReadJson, safeWriteJson, projectDir, projectPath,
} from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { downloadYouTubeVideo } from '../services/youtubeDownloader.js';
import { transcribeForTranslation } from '../services/whisperTranscribe.js';
import { findTopicWindow } from '../services/segmentFinder.js';
import { translateAndScript } from '../services/translationService.js';
import { logger } from '../utils/logger.js';

const router = Router();

function newProject(name) {
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
    },
    stats: { chapterCount: 0, pageCount: 0, panelCount: 0, scriptWordCount: 0, audioDurationSec: 0, videoDurationSec: 0 },
    errors: [],
  };
}

// POST /
router.post('/', async (req, res, next) => {
  try {
    const { name, url, topic, language = 'hi' } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required (YouTube link)' });
    }

    const project = newProject(name);
    await ensureDir(projectDir(project.id));
    await safeWriteJson(projectPath(project.id, 'project.json'), project);
    logger.info(`[translate] created project ${project.id} for url=${url} topic="${topic || ''}"`);

    if (isRunning(project.id)) {
      return res.status(409).json({ error: 'Job already running' });
    }

    runJob(project.id, async () => {
      const onStep = (step) => (message, percent) => {
        logger.info(`[translate/${step}] ${percent}% — ${message}`);
        emit(project.id, step, message, percent);
      };

      try {
        // 1. Download
        project.state.upload = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        const dl = await downloadYouTubeVideo(project.id, url, onStep('upload'));
        project.state.upload = 'complete';
        project.stats.videoDurationSec = dl.durationSec;
        if (!project.name || project.name === 'Translated Clip') project.name = dl.title || project.name;
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'upload', 'Download complete', 100);

        // 2. Whisper
        project.state.panels = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        const transcript = await transcribeForTranslation(
          project.id, dl.path,
          { language, prompt: topic ? `Discussion about ${topic}.` : undefined },
          onStep('panels'),
        );

        // 3. Topic window (optional)
        let window = null;
        if (topic) {
          const found = await findTopicWindow(transcript.segments, topic);
          if (!found.found) {
            throw new Error(`Topic "${topic}" not found in transcript: ${found.rationale}`);
          }
          window = { startSec: found.startSec, endSec: found.endSec };
        } else {
          // Whole video — clamp to a sensible reel length even when no topic given.
          const lastEnd = transcript.segments.at(-1)?.end || transcript.duration || 0;
          window = { startSec: 0, endSec: Math.min(lastEnd, 180) };
        }
        await safeWriteJson(projectPath(project.id, 'translate-window.json'), { window, topic: topic || null });
        project.state.panels = 'complete';
        project.stats.panelCount = 1;
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'panels', 'Transcription + window selection complete', 100);

        // 4. Translate
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

export default router;
