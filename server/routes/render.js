import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { validateProject } from '../middleware/validateProject.js';
import { safeWriteJson, projectPath, fileExists } from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { renderVideo } from '../services/videoRenderer.js';
import { logger } from '../utils/logger.js';

const router = Router();

const VALID_DETAILS = ['low', 'medium', 'high'];

// POST /:id/render - trigger video render
router.post('/:id/render', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: 'A job is already running for this project' });
    }

    // Extract render config from request body
    const { duration, detail, format } = req.body;
    const renderConfig = {};

    if (duration && typeof duration === 'number' && duration > 0) {
      renderConfig.duration = duration;
    }
    if (detail && VALID_DETAILS.includes(detail)) {
      renderConfig.detail = detail;
    }
    if (format && ['manga', 'webtoon'].includes(format)) {
      renderConfig.format = format;
    }

    const project = req.project;

    // Persist render config to project
    project.config = project.config || {};
    if (renderConfig.duration) project.config.duration = renderConfig.duration;
    if (renderConfig.detail) project.config.detail = renderConfig.detail;
    if (renderConfig.format) project.config.format = renderConfig.format;

    runJob(req.params.id, async () => {
      try {
        logger.info(`[render] Job started — project: ${req.params.id}, config: ${JSON.stringify(renderConfig)}`);
        project.state.render = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        logger.info(`[render] Project state set to "processing", calling renderVideo...`);

        await renderVideo(req.params.id, (message, percent) => {
          logger.info(`[render] Progress: ${percent}% — ${message}`);
          emit(req.params.id, 'render', message, percent);
        }, renderConfig);

        project.state.render = 'complete';
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'render', 'Video render complete', 100);
      } catch (err) {
        project.state.render = 'error';
        project.errors.push({ step: 'render', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'render', `Error: ${err.message}`, -1);
        logger.error(`Render failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Video render started' });
  } catch (err) {
    next(err);
  }
});

// GET /:id/download - download final video
router.get('/:id/download', validateProject, async (req, res, next) => {
  try {
    const videoPath = projectPath(req.params.id, 'output', 'final.mp4');
    const exists = await fileExists(videoPath);
    if (!exists) {
      return res.status(404).json({ error: 'Video not yet rendered' });
    }
    res.download(videoPath, `${req.project.name || 'animereels'}.mp4`);
  } catch (err) {
    next(err);
  }
});

export default router;
