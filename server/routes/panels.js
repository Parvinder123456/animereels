import { Router } from 'express';
import path from 'path';
import { validateProject } from '../middleware/validateProject.js';
import { safeReadJson, safeWriteJson, listImages, projectPath } from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { splitAllChapters } from '../services/panelSplitter.js';
import { detectAllPanels } from '../services/panelDetector.js';
import { logger } from '../utils/logger.js';
import sharp from 'sharp';

const router = Router();

// POST /:id/split - trigger panel splitting
router.post('/:id/split', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: 'A job is already running for this project' });
    }

    const project = req.project;

    runJob(req.params.id, async () => {
      try {
        project.state.panels = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        const panelCount = await splitAllChapters(req.params.id, (message, percent) => {
          emit(req.params.id, 'panels', message, percent);
        }, project.config?.format || 'manga');

        project.state.panels = 'complete';
        project.stats.panelCount = panelCount;
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', 'Panel splitting complete', 100);
      } catch (err) {
        project.state.panels = 'error';
        project.errors.push({ step: 'panels', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', `Error: ${err.message}`, -1);
        logger.error(`Panel split failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Panel splitting started' });
  } catch (err) {
    next(err);
  }
});

// POST /:id/detect - AI panel detection (Gemini Vision bounding boxes)
router.post('/:id/detect', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: 'A job is already running for this project' });
    }

    const project = req.project;

    runJob(req.params.id, async () => {
      try {
        project.state.panels = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        const panelCount = await detectAllPanels(req.params.id, (message, percent) => {
          emit(req.params.id, 'panels', message, percent);
        }, project.config?.format || 'manga');

        project.state.panels = 'complete';
        project.stats.panelCount = panelCount;
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', 'AI panel detection complete', 100);
      } catch (err) {
        project.state.panels = 'error';
        project.errors.push({ step: 'panels', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', `Error: ${err.message}`, -1);
        logger.error(`AI panel detection failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'AI panel detection started' });
  } catch (err) {
    next(err);
  }
});

// GET /:id/panels - list panels
router.get('/:id/panels', validateProject, async (req, res, next) => {
  try {
    const panelsDir = projectPath(req.params.id, 'panels');
    const images = await listImages(panelsDir);

    const panels = await Promise.all(images.map(async (imgPath) => {
      try {
        const meta = await sharp(imgPath).metadata();
        return {
          filename: path.basename(imgPath),
          path: `/data/${req.params.id}/panels/${path.basename(imgPath)}`,
          width: meta.width,
          height: meta.height
        };
      } catch {
        return {
          filename: path.basename(imgPath),
          path: `/data/${req.params.id}/panels/${path.basename(imgPath)}`,
          width: 0,
          height: 0
        };
      }
    }));

    res.json(panels);
  } catch (err) {
    next(err);
  }
});

export default router;
