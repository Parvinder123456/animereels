import { Router } from 'express';
import path from 'path';
import multer from 'multer';
import { safeReadJson, projectPath } from '../utils/fileHelpers.js';
import { getAuthUrl, exchangeCode, isAuthenticated, uploadVideo } from '../services/youtubeUploader.js';
import { emit } from '../jobs/processor.js';
import { logger } from '../utils/logger.js';

const router = Router();
const upload = multer({ dest: 'data/thumbs/' });

// GET /api/youtube/status — check if OAuth token exists
router.get('/status', async (_req, res, next) => {
  try {
    res.json({ authenticated: await isAuthenticated() });
  } catch (err) { next(err); }
});

// GET /api/youtube/auth-url — get the Google OAuth URL
router.get('/auth-url', async (_req, res, next) => {
  try {
    res.json({ url: await getAuthUrl() });
  } catch (err) { next(err); }
});

// POST /api/youtube/callback — exchange auth code for token
router.post('/callback', async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    await exchangeCode(code);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/youtube/upload/:projectId — upload rendered video (non-blocking, progress via SSE)
// Body: { title?, description?, tags?, privacy? }
// Optional multipart field: thumbnail (image file)
router.post('/upload/:projectId', upload.single('thumbnail'), async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { title, description, tags, privacy } = req.body;

    // Load project script for auto title/description
    const script = await safeReadJson(projectPath(projectId, 'script.json'), {});
    const project = await safeReadJson(projectPath(projectId, 'project.json'), {});

    const videoTitle = (title || script.title || project.name || 'AnimeReels Video').slice(0, 100);
    const rawDesc = description || (script.hook ? `${script.hook}\n\n${script.segments?.map(s => s.text).join(' ') || ''}` : '');
    const videoDescription = rawDesc.slice(0, 4900);
    const videoTags = tags ? (typeof tags === 'string' ? JSON.parse(tags) : tags) : ['anime', 'manga', 'manhwa', 'recap'];

    const outputDir = projectPath(projectId, 'output');
    const videoPath = path.join(outputDir, 'final.mp4');
    const thumbPath = req.file?.path || null;

    // Respond immediately — upload runs in background, progress via SSE
    res.json({ started: true });

    uploadVideo({
      videoPath,
      title: videoTitle,
      description: videoDescription,
      tags: videoTags,
      thumbPath,
      privacy: privacy || 'private',
      onProgress: (msg, pct) => {
        logger.info(`[YouTube] ${msg} (${pct}%)`);
        emit(projectId, 'youtube', msg, pct);
      },
    }).then(result => {
      emit(projectId, 'youtube', `Uploaded: ${result.url}`, 100);
      logger.info(`[YouTube] Upload complete: ${result.url}`);
    }).catch(err => {
      emit(projectId, 'youtube', `Upload failed: ${err.message}`, -1);
      logger.error(`[YouTube] Upload failed: ${err.message}`);
    });
  } catch (err) { next(err); }
});

export default router;
