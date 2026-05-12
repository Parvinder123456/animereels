/**
 * Video-explainer routes.
 *
 *   POST /api/projects/:id/explainer-sources
 *     Multipart upload — `videos` (1-10 files). Order matters: episode 1, 2, ...
 *     Server stitches into source.mp4 and writes episodes.json.
 *
 *   POST /api/projects/:id/explainer/run
 *     Body: { targetDurationSec }
 *     Pipeline:
 *       1. OP/ED detect (Gemini audio fingerprint match)
 *       2. Gemini multimodal visual+audio breakdown of source → scene plan
 *          (each scene has visualDescription + dialogueGist + mood + importance,
 *           anchored to real visual cuts — NOT dialogue boundaries)
 *       3. Scene selector — pick scenes to fit the target duration
 *       4. Narrator script writer — produces narration that MATCHES the
 *          visual on screen, not just what's being said
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
import { detectOpEd, mergeSkipWindows, loadCachedOpEd } from '../services/opEdDetector.js';
import { breakDownVideo, loadCachedPlan } from '../services/geminiVideoBreakdown.js';
import { selectScenes, pickMode } from '../services/sceneSelector.js';
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
    const force = req.body?.force === true || req.body?.force === 'true';

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

        const totalSec = episodes.reduce((s, e) => s + e.durationSec, 0);

        // 1. OP/ED detect. CACHED: if op-ed-cuts.json was produced from
        // an unchanged source.mp4, skip the Gemini audio calls entirely.
        let opCuts, edCuts;
        if (!force) {
          const cached = await loadCachedOpEd(req.params.id, sourcePath);
          if (cached) {
            opCuts = cached.opCuts || [];
            edCuts = cached.edCuts || [];
            onStep('panels')(`OP/ED cache hit (${opCuts.length} + ${edCuts.length} cuts) — skipping detection`, 8);
            logger.info(`[videoExplainer] op-ed cache hit: ${opCuts.length} OP + ${edCuts.length} ED cuts`);
          }
        }
        if (!opCuts) {
          onStep('panels')('Detecting OP/ED themes...', 2);
          ({ opCuts, edCuts } = await detectOpEd(req.params.id, sourcePath, episodes, (msg, pct) =>
            onStep('panels')(msg, 2 + Math.round(pct * 0.08))
          ));
        }
        const skipWindows = mergeSkipWindows(opCuts, edCuts);

        // 2. Gemini multimodal visual+audio breakdown. CACHED: scene-plan.json
        // is keyed on the source file's identity (size + mtime). Re-runs with
        // a different target duration reuse the breakdown, saving the bulk of
        // the Gemini billable cost (~$0.90 per source).
        let plan;
        if (!force) {
          const cached = await loadCachedPlan(req.params.id, sourcePath);
          if (cached) {
            plan = cached;
            onStep('panels')(`Scene plan cache hit (${plan.scenes.length} scenes from prior breakdown) — skipping breakdown`, 80);
            logger.info(`[videoExplainer] scene-plan cache hit: ${plan.scenes.length} scenes (cachedAt=${plan.cachedAt})`);
          }
        }
        if (!plan) {
          onStep('panels')('Gemini multimodal scene breakdown (visual + audio)...', 12);
          plan = await breakDownVideo(req.params.id, sourcePath, totalSec, skipWindows, (msg, pct) =>
            onStep('panels')(msg, 12 + Math.round(pct * 0.70))
          );
        }
        if (!plan.scenes?.length) throw new Error('Scene breakdown returned zero scenes — source unreadable?');

        // 3. Mode pick + scene selection to fit target duration.
        const mode = pickMode(totalSec, targetDurationSec);
        logger.info(`[videoExplainer] mode=${mode} (source=${(totalSec/60).toFixed(1)}min → target=${(targetDurationSec/60).toFixed(1)}min)`);
        onStep('panels')(`Selecting scenes (mode=${mode})...`, 84);
        const chosenScenes = selectScenes(plan.scenes, targetDurationSec, mode);
        if (!chosenScenes.length) throw new Error('Scene selector returned zero scenes');
        await safeWriteJson(projectPath(req.params.id, 'beats.json'), { mode, totalSec, targetDurationSec, scenes: chosenScenes });

        project.state.panels = 'complete';
        project.stats.panelCount = chosenScenes.length;
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', `Scene selection complete: ${chosenScenes.length} scenes`, 100);

        // 4. Narrator script writer with visual + dialogue context per scene.
        currentStep = 'script';
        project.state.script = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        // Lightweight cross-scene hints derived from the plan itself.
        const charCounts = {};
        for (const s of plan.scenes) for (const c of (s.characters || [])) {
          charCounts[c] = (charCounts[c] || 0) + 1;
        }
        const bundleHints = {
          bundleTitle: project.name || 'Anime Explainer',
          arcOverview: plan.scenes.slice(0, 3).map(s => s.visualDescription).filter(Boolean).join(' / '),
          throughLines: Object.entries(charCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c),
          endsOn: plan.scenes.slice(-1)[0]?.visualDescription || '',
        };

        const script = await writeExplainerScript(
          req.params.id, chosenScenes, onStep('script'),
          { targetReelSec: targetDurationSec, bundleHints }
        );

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
