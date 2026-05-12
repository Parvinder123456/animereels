/**
 * Video-explainer routes.
 *
 *   POST /api/projects/:id/explainer-sources
 *     Multipart upload — `videos` (1-10 files). Order matters: episode 1, 2, ...
 *     Server stitches into source.mp4 and writes episodes.json.
 *
 *   POST /api/projects/:id/explainer/run
 *     Body: { targetDurationSec, language? = 'en' }
 *     Runs: OP/ED detect → chunked Whisper → per-episode summaries →
 *           bundle summary → beat clustering → mode pick → explainer script.
 *     After this, the existing /voice/generate + /render endpoints finish
 *     the pipeline (render branches on projectType === 'video_explainer').
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { validateProject } from '../middleware/validateProject.js';
import {
  ensureDir, safeReadJson, safeWriteJson, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { stitchEpisodes } from '../services/videoStitcher.js';
import { detectOpEd, mergeSkipWindows } from '../services/opEdDetector.js';
import { transcribeChunked } from '../services/chunkedTranscribe.js';
import { clusterIntoBeats, pickBeatsForCutMode, pickMode } from '../services/beatClusterer.js';
import { summarizeEpisodes, summarizeBundle } from '../services/storySummarizer.js';
import { writeExplainerScript } from '../services/explainerScriptWriter.js';
import { logger } from '../utils/logger.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const dir = projectPath(req.params.id, '_uploads');
      await ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ok = ['.mp4', '.mkv', '.mov', '.webm', '.m4v'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only .mp4 / .mkv / .mov / .webm / .m4v accepted'), ok);
  },
  limits: { fileSize: 3 * 1024 * 1024 * 1024, files: 10 }, // 3 GB per file, 10 files max
});

// ─── POST /:id/explainer-sources ─────────────────────────────────────────────

router.post('/:id/explainer-sources', validateProject, upload.array('videos', 10), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'No video files uploaded' });

    const project = req.project;
    project.config = project.config || {};
    project.config.projectType = 'video_explainer';
    project.state.upload = 'processing';
    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

    if (isRunning(req.params.id)) return res.status(409).json({ error: 'Job already running' });

    const inputPaths = req.files
      .sort((a, b) => a.filename.localeCompare(b.filename)) // multer preserves upload order via Date.now() prefix
      .map(f => f.path);

    runJob(req.params.id, async () => {
      try {
        await stitchEpisodes(req.params.id, inputPaths, (message, percent) => {
          emit(req.params.id, 'upload', message, percent);
        });

        project.state.upload = 'complete';
        project.stats.chapterCount = inputPaths.length;
        const ep = await safeReadJson(projectPath(req.params.id, 'episodes.json'));
        if (ep?.totalSec) project.stats.videoDurationSec = Math.round(ep.totalSec);
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'upload', 'Stitch complete', 100);

        // Best-effort cleanup of the raw uploads — they're inside source.mp4 now.
        for (const p of inputPaths) { try { await fs.unlink(p); } catch {} }
        try { await fs.rmdir(projectPath(req.params.id, '_uploads')); } catch {}
      } catch (err) {
        project.state.upload = 'error';
        project.errors.push({ step: 'upload', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'upload', `Error: ${err.message}`, -1);
        logger.error(`[videoExplainer/upload] ${req.params.id} failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, fileCount: inputPaths.length });
  } catch (err) { next(err); }
});

// ─── POST /:id/explainer/run ─────────────────────────────────────────────────

router.post('/:id/explainer/run', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) return res.status(409).json({ error: 'A job is already running' });
    const project = req.project;
    const sourcePath = projectPath(req.params.id, 'source.mp4');
    if (!await fileExists(sourcePath)) {
      return res.status(400).json({ error: 'No stitched source — upload episodes first' });
    }
    const episodes = (await safeReadJson(projectPath(req.params.id, 'episodes.json')))?.files;
    if (!episodes?.length) return res.status(400).json({ error: 'episodes.json missing — upload failed?' });

    const targetDurationSec = Math.max(60, Number(req.body?.targetDurationSec) || 60 * 60);
    const language = (req.body?.language || 'en').trim();

    runJob(req.params.id, async () => {
      let currentStep = 'panels';
      const onStep = (step) => (message, percent) => {
        currentStep = step;
        logger.info(`[videoExplainer/${step}] ${percent}% — ${message}`);
        emit(req.params.id, step, message, percent);
      };

      try {
        project.config = project.config || {};
        project.config.projectType = 'video_explainer';
        project.config.duration = targetDurationSec;
        project.state.panels = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        // 1. OP/ED detect (auto, ~2 Gemini calls).
        onStep('panels')('Detecting OP/ED themes...', 2);
        const { opCuts, edCuts } = await detectOpEd(req.params.id, sourcePath, episodes, (msg, pct) =>
          onStep('panels')(msg, 2 + Math.round(pct * 0.10))
        );
        const skipWindows = mergeSkipWindows(opCuts, edCuts);

        // 2. Chunked Whisper transcription of the full stitched source.
        onStep('panels')('Transcribing full source (chunked)...', 15);
        const totalSec = episodes.reduce((s, e) => s + e.durationSec, 0);
        const transcript = await transcribeChunked(req.params.id, sourcePath, totalSec, { language }, (msg, pct) =>
          onStep('panels')(msg, 15 + Math.round(pct * 0.45))
        );
        if (!transcript.segments?.length) throw new Error('Whisper returned zero segments — bad source audio?');

        // 3. Per-episode summaries → bundle summary.
        onStep('panels')('Summarizing each episode...', 62);
        const epSummaries = await summarizeEpisodes(req.params.id, transcript.segments, episodes, skipWindows, (msg, pct) =>
          onStep('panels')(msg, 62 + Math.round(pct * 0.13))
        );

        onStep('panels')('Combining episodes into bundle summary...', 78);
        const bundleSummary = await summarizeBundle(req.params.id, epSummaries, (msg, pct) =>
          onStep('panels')(msg, 78 + Math.round(pct * 0.05))
        );

        // 4. Beat clustering + mode pick.
        const mode = pickMode(totalSec, targetDurationSec);
        logger.info(`[videoExplainer] mode=${mode} (source=${(totalSec/60).toFixed(1)}min → target=${(targetDurationSec/60).toFixed(1)}min)`);
        onStep('panels')(`Clustering into beats (mode=${mode})...`, 85);
        let beats = clusterIntoBeats(transcript.segments, episodes, skipWindows, mode);

        if (mode === 'cut') {
          beats = pickBeatsForCutMode(beats, targetDurationSec, episodes);
        }
        await safeWriteJson(projectPath(req.params.id, 'beats.json'), { mode, totalSec, targetDurationSec, beats });

        project.state.panels = 'complete';
        project.stats.panelCount = beats.length;
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', `Clustering complete: ${beats.length} beats`, 100);

        // 5. Per-beat narrator script.
        currentStep = 'script';
        project.state.script = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        const script = await writeExplainerScript(req.params.id, bundleSummary, beats, onStep('script'), { targetReelSec: targetDurationSec });

        project.state.script = 'complete';
        project.stats.scriptWordCount = (script.segments || []).reduce(
          (n, s) => n + (s.text ? s.text.split(/\s+/).filter(Boolean).length : 0), 0
        );
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'script', 'Explainer script complete', 100);
      } catch (err) {
        project.state[currentStep] = 'error';
        project.errors.push({ step: currentStep, message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, currentStep, `Error: ${err.message}`, -1);
        logger.error(`[videoExplainer] ${req.params.id} step=${currentStep} failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Video-explainer pipeline started' });
  } catch (err) { next(err); }
});

export default router;
