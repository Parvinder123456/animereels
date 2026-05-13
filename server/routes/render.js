import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { validateProject } from '../middleware/validateProject.js';
import { safeWriteJson, projectPath, fileExists } from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { renderVideo } from '../services/videoRenderer.js';
import { renderVideoSummary } from '../services/videoSummaryRenderer.js';
import { renderTranslatedClip } from '../services/translatedRenderer.js';
import { renderVideoExplainer } from '../services/videoExplainerRenderer.js';
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
    const { duration, detail, format, aspect, copyrightHardening } = req.body;
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
    if (aspect && ['9:16', '16:9', '1:1', 'original'].includes(aspect)) {
      renderConfig.aspect = aspect;
    }

    // Copyright hardening: accept either a boolean (use defaults) or an object
    // { enabled, flip, pitchShift, watermark }
    let hardenCfg = null;
    if (copyrightHardening === true) {
      hardenCfg = { enabled: true, flip: true, pitchShift: true, watermark: '' };
    } else if (copyrightHardening && typeof copyrightHardening === 'object') {
      hardenCfg = {
        enabled: copyrightHardening.enabled !== false,
        flip: copyrightHardening.flip !== false,
        pitchShift: copyrightHardening.pitchShift !== false,
        watermark: typeof copyrightHardening.watermark === 'string'
          ? copyrightHardening.watermark.slice(0, 60)
          : '',
      };
    } else if (copyrightHardening === false) {
      hardenCfg = { enabled: false };
    }

    const project = req.project;

    // Persist render config to project
    project.config = project.config || {};
    if (renderConfig.duration) project.config.duration = renderConfig.duration;
    if (renderConfig.detail) project.config.detail = renderConfig.detail;
    if (renderConfig.format) project.config.format = renderConfig.format;
    if (renderConfig.aspect) project.config.aspect = renderConfig.aspect;
    if (hardenCfg) project.config.copyrightHardening = hardenCfg.enabled ? hardenCfg : false;

    runJob(req.params.id, async () => {
      try {
        logger.info(`[render] Job started — project: ${req.params.id}, config: ${JSON.stringify(renderConfig)}`);
        project.state.render = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        logger.info(`[render] Project state set to "processing", calling renderVideo...`);

        const projectType = project.config?.projectType || 'manga';
        const onProgress = (message, percent) => {
          logger.info(`[render] Progress: ${percent}% — ${message}`);
          emit(req.params.id, 'render', message, percent);
        };
        if (projectType === 'video_summary') {
          await renderVideoSummary(req.params.id, onProgress);
        } else if (projectType === 'translate') {
          await renderTranslatedClip(req.params.id, onProgress);
        } else if (projectType === 'video_explainer') {
          await renderVideoExplainer(req.params.id, onProgress);
        } else {
          await renderVideo(req.params.id, onProgress, renderConfig);
        }

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
