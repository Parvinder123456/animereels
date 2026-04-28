import { Router } from 'express';
import multer from 'multer';
import { validateProject } from '../middleware/validateProject.js';
import { safeWriteJson, ensureDir, projectPath } from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { generateNarration, generatePreview } from '../services/elevenLabsTTS.js';
import { generateNarration as generateNarrationEdge, generatePreview as generatePreviewEdge } from '../services/edgeTTS.js';
import { logger } from '../utils/logger.js';

const router = Router();

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = projectPath(req.params.id, 'audio');
    await ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, 'narration-uploaded' + getExt(file.originalname));
  }
});

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '.mp3';
}

const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// POST /:id/voice/generate - generate TTS
router.post('/:id/voice/generate', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: 'A job is already running for this project' });
    }

    const { voiceId, engine } = req.body;
    if (!voiceId) return res.status(400).json({ error: 'voiceId is required' });

    const project = req.project;

    runJob(req.params.id, async () => {
      try {
        logger.info(`[voice/generate] Job started — project: ${req.params.id}, voiceId: ${voiceId}, engine: ${engine || 'elevenlabs'}`);
        project.state.voice = 'processing';
        project.config.voiceId = voiceId;
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        const narrationFn = engine === 'edge' ? generateNarrationEdge : generateNarration;
        await narrationFn(req.params.id, voiceId, (message, percent) => {
          logger.info(`[voice/generate] Progress: ${percent}% — ${message}`);
          emit(req.params.id, 'voice', message, percent);
        });

        project.state.voice = 'complete';
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'voice', 'Voice generation complete', 100);
      } catch (err) {
        project.state.voice = 'error';
        project.errors.push({ step: 'voice', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'voice', `Error: ${err.message}`, -1);
        logger.error(`Voice generation failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Voice generation started' });
  } catch (err) {
    next(err);
  }
});

// POST /:id/voice/upload - upload own audio
router.post('/:id/voice/upload', validateProject, upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const project = req.project;
    project.state.voice = 'complete';
    project.updatedAt = new Date().toISOString();
    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

    logger.info(`Uploaded audio for project ${req.params.id}`);
    res.json({ success: true, filename: req.file.filename });
  } catch (err) {
    next(err);
  }
});

// POST /:id/voice/preview - generate 15s preview
router.post('/:id/voice/preview', validateProject, async (req, res, next) => {
  try {
    const { voiceId, engine } = req.body;
    if (!voiceId) return res.status(400).json({ error: 'voiceId is required' });

    const previewFn = engine === 'edge' ? generatePreviewEdge : generatePreview;
    const previewPath = await previewFn(req.params.id, voiceId);
    res.json({
      success: true,
      audioUrl: `/data/${req.params.id}/audio/preview.mp3`
    });
  } catch (err) {
    next(err);
  }
});

export default router;
