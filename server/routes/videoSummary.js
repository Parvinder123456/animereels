/**
 * Video-summary feature routes:
 *
 *   POST /api/projects/:id/video-source       — upload source episode (multer)
 *   POST /api/projects/:id/video-summary/run  — run ingest → analyze → script
 *
 * After /run completes, the existing voice-generation and render endpoints
 * (POST /:id/voice/generate, POST /:id/render) finish the pipeline. The
 * render endpoint branches on `config.projectType === 'video_summary'`.
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { validateProject } from '../middleware/validateProject.js';
import {
  ensureDir, safeReadJson, safeWriteJson, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { ingestVideo } from '../services/videoIngestion.js';
import { detectScenes } from '../services/sceneDetector.js';
import { sampleFramesForScenes } from '../services/frameSampler.js';
import { analyzeScenes } from '../services/videoAnalyzer.js';
import { selectMoments } from '../services/momentSelector.js';
import { generateVideoSummaryScript } from '../services/videoSummaryScriptWriter.js';
import { logger } from '../utils/logger.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const dir = projectPath(req.params.id);
      await ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, _file, cb) => cb(null, 'source.mp4'),
  }),
  fileFilter: (_req, file, cb) => {
    const ok = ['.mp4', '.mkv', '.mov', '.webm'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only .mp4 / .mkv / .mov / .webm accepted'), ok);
  },
  limits: { fileSize: 3 * 1024 * 1024 * 1024 }, // 3 GB cap
});

// POST /:id/video-source — upload source episode
router.post('/:id/video-source', validateProject, upload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

    const project = req.project;
    project.config = project.config || {};
    project.config.projectType = 'video_summary';
    project.state.upload = 'complete';
    project.updatedAt = new Date().toISOString();
    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

    logger.info(`[videoSummary] uploaded source for ${req.params.id}: ${req.file.size} bytes`);
    res.json({ success: true, filename: req.file.filename, size: req.file.size });
  } catch (err) { next(err); }
});

// POST /:id/video-summary/run — kick off ingest → analyze → select → script
router.post('/:id/video-summary/run', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: 'A job is already running for this project' });
    }

    const project = req.project;
    const sourcePath = projectPath(req.params.id, 'source.mp4');
    if (!await fileExists(sourcePath)) {
      return res.status(400).json({ error: 'No source video uploaded — POST /:id/video-source first' });
    }

    const targetReelSec = Number(req.body?.duration) > 0 ? Number(req.body.duration) : (project.config?.duration || 60);

    runJob(req.params.id, async () => {
      const onStep = (step) => (message, percent) => {
        logger.info(`[videoSummary/${step}] ${percent}% — ${message}`);
        emit(req.params.id, step, message, percent);
      };

      try {
        project.config = project.config || {};
        project.config.projectType = 'video_summary';
        project.config.duration = targetReelSec;
        project.state.panels = 'processing';
        project.state.script = 'pending';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        // 1. Ingest
        onStep('panels')('Probing source video...', 2);
        const meta = await ingestVideo(sourcePath);
        await safeWriteJson(projectPath(req.params.id, 'video-meta.json'), meta);

        // 2. Scene detection
        onStep('panels')('Detecting scene cuts...', 10);
        const scenes = await detectScenes(sourcePath, meta.durationSec);
        await safeWriteJson(projectPath(req.params.id, 'scenes.json'), scenes);
        if (!scenes.length) throw new Error('No scenes detected — source may be too short or static');

        // 3. Frame sampling
        onStep('panels')('Sampling representative frames...', 25);
        const framesDir = projectPath(req.params.id, 'frames');
        const frames = await sampleFramesForScenes(sourcePath, scenes, framesDir);

        // 4. Vision scoring
        const scores = await analyzeScenes(frames, (msg, pct) =>
          onStep('panels')(msg, 30 + Math.round(pct * 0.45))
        );
        await safeWriteJson(projectPath(req.params.id, 'scene-scores.json'), scores);

        // 5. Pick clips
        onStep('panels')('Selecting best moments...', 78);
        const picked = selectMoments(scenes, scores, targetReelSec);
        if (!picked.length) throw new Error('No clips selected — try a longer source or higher duration');

        // Persist clips with both clip and scene boundaries (for renderer recutting)
        const clipsForDisk = picked.map(c => ({
          ...c,
          sceneStartSec: scenes[c.sceneIndex].startSec,
          sceneEndSec:   scenes[c.sceneIndex].endSec,
        }));
        await safeWriteJson(projectPath(req.params.id, 'clips.json'), clipsForDisk);

        project.state.panels = 'complete';
        project.stats.panelCount = picked.length;
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', 'Scene analysis & clip selection complete', 100);

        // 6. Script
        project.state.script = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        const script = await generateVideoSummaryScript(req.params.id, picked, {
          targetReelSec,
          onProgress: onStep('script'),
        });

        project.state.script = 'complete';
        project.stats.scriptWordCount = (script.segments || []).reduce(
          (n, s) => n + (s.text ? s.text.split(/\s+/).filter(Boolean).length : 0), 0
        );
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'script', 'Script generation complete', 100);
      } catch (err) {
        project.state.panels = project.state.panels === 'complete' ? 'complete' : 'error';
        project.state.script = 'error';
        project.errors.push({ step: 'video_summary', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'script', `Error: ${err.message}`, -1);
        logger.error(`[videoSummary] ${req.params.id} failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Video-summary analysis started' });
  } catch (err) { next(err); }
});

export default router;
