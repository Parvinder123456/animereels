import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import {
  ensureDir, safeReadJson, safeWriteJson,
  projectDir, projectPath, fileExists
} from '../utils/fileHelpers.js';
import { logger } from '../utils/logger.js';

const router = Router();

function createProject(name) {
  const id = `proj_${uuidv4().slice(0, 8)}`;
  return {
    id,
    name: name || 'Untitled Project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: {
      upload: 'pending',
      panels: 'pending',
      script: 'pending',
      voice: 'pending',
      render: 'pending'
    },
    config: {
      voiceId: '',
      musicMood: 'suspense',
      videoResolution: '1920x1080',
      duration: 60,
      detail: 'medium',
      format: 'manga'
    },
    stats: {
      chapterCount: 0,
      pageCount: 0,
      panelCount: 0,
      scriptWordCount: 0,
      audioDurationSec: 0,
      videoDurationSec: 0
    },
    errors: []
  };
}

// GET / - list all projects
router.get('/', async (req, res, next) => {
  try {
    const dataDir = projectDir('').replace(/[/\\]$/, '');
    await ensureDir(dataDir);
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const proj = await safeReadJson(projectPath(entry.name, 'project.json'));
        if (proj) projects.push(proj);
      }
    }

    projects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(projects);
  } catch (err) {
    next(err);
  }
});

// POST / - create project
router.post('/', async (req, res, next) => {
  try {
    const project = createProject(req.body.name);
    const dir = projectDir(project.id);
    await ensureDir(dir);
    await safeWriteJson(projectPath(project.id, 'project.json'), project);
    logger.info(`Created project: ${project.id} - ${project.name}`);
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

// GET /:id - get project
router.get('/:id', async (req, res, next) => {
  try {
    const proj = await safeReadJson(projectPath(req.params.id, 'project.json'));
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    res.json(proj);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/config - update project config (duration, detail, etc.)
router.patch('/:id/config', async (req, res, next) => {
  try {
    const proj = await safeReadJson(projectPath(req.params.id, 'project.json'));
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const { duration, detail, format } = req.body;
    proj.config = proj.config || {};
    if (duration !== undefined && typeof duration === 'number' && duration > 0) {
      proj.config.duration = duration;
    }
    if (detail !== undefined && ['low', 'medium', 'high'].includes(detail)) {
      proj.config.detail = detail;
    }
    if (format !== undefined && ['manga', 'webtoon'].includes(format)) {
      proj.config.format = format;
    }
    proj.updatedAt = new Date().toISOString();
    await safeWriteJson(projectPath(req.params.id, 'project.json'), proj);
    res.json(proj);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id - delete project
router.delete('/:id', async (req, res, next) => {
  try {
    const dir = projectDir(req.params.id);
    const exists = await fileExists(projectPath(req.params.id, 'project.json'));
    if (!exists) return res.status(404).json({ error: 'Project not found' });

    await fs.rm(dir, { recursive: true, force: true });
    logger.info(`Deleted project: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
