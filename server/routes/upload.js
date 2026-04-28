import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { ensureDir, safeReadJson, safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { validateProject } from '../middleware/validateProject.js';
import { runJob, emit } from '../jobs/processor.js';
import { splitAllChapters } from '../services/panelSplitter.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Configure multer for chapter image uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = projectPath(req.params.id, 'chapters');
    await ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Preserve original name with sanitization
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${ext}. Allowed: ${allowedExts.join(', ')}`));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

// POST /:id/upload - upload chapter images
router.post('/:id/upload', validateProject, upload.array('chapterImages', 1000), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Update project state
    const project = req.project;
    project.state.upload = 'complete';
    project.stats.chapterCount = req.files.length;
    project.updatedAt = new Date().toISOString();
    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

    logger.info(`Uploaded ${req.files.length} chapter images for project ${req.params.id}`);

    // Kick off panel splitting in background
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
        logger.error(`Panel split failed for ${req.params.id}: ${err.message}`);
      }
    }).catch(() => {}); // Error already handled inside

    res.json({
      success: true,
      fileCount: req.files.length,
      files: req.files.map(f => f.filename)
    });
  } catch (err) {
    next(err);
  }
});

export default router;
