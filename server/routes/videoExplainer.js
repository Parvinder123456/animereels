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
import { breakDownVideo, loadCachedPlan, applySkipWindows } from '../services/geminiVideoBreakdown.js';
import { selectScenes, pickMode } from '../services/sceneSelector.js';
import {
  summarizeEpisodes, summarizeBundle,
  loadCachedEpisodeSummaries, loadCachedBundleSummary,
} from '../services/storySummarizer.js';
import { writeExplainerScript } from '../services/explainerScriptWriter.js';
import { logger } from '../utils/logger.js';

/**
 * Adapt Gemini scene-plan scenes into the {start, end, text} segment
 * shape that storySummarizer expects. We pack VISUAL + DIALOGUE per
 * segment so the summarizer sees what's happening on screen alongside
 * what's being said — gives it real story understanding, not just
 * dialogue paraphrasing.
 */
function scenesToTranscriptLikeSegments(scenes) {
  return scenes.map(s => ({
    start: s.startSec,
    end: s.endSec,
    text: [
      `[VISUAL] ${s.visualDescription || '(unspecified)'}`,
      s.dialogueGist ? `[GIST] ${s.dialogueGist}` : '',
      s.dialogueVerbatim ? `[SAYS] ${s.dialogueVerbatim}` : '',
    ].filter(Boolean).join(' '),
  }));
}

/**
 * Parse a user-supplied skip-windows string.
 *
 * Accepts an array of {startSec, endSec} numbers (already structured),
 * OR a string with one window per line. Each line may be:
 *   "30-90"              (seconds)
 *   "0:30-1:30"          (M:SS)
 *   "00:30-01:30"        (MM:SS)
 *   "1:30:00-1:31:30"    (H:MM:SS)
 * Lines starting with '#' or blank are ignored.
 */
function parseManualSkipWindows(input) {
  if (Array.isArray(input)) {
    return input
      .map(w => ({ startSec: Number(w.startSec), endSec: Number(w.endSec) }))
      .filter(w => Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec > w.startSec);
  }
  if (typeof input !== 'string') return [];

  const toSec = (token) => {
    const parts = token.trim().split(':').map(Number);
    if (parts.some(p => !Number.isFinite(p))) return NaN;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  };

  return input
    .split(/\r?\n|,/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const m = l.match(/^([\d:.]+)\s*[-–—]\s*([\d:.]+)$/);
      if (!m) return null;
      const startSec = toSec(m[1]);
      const endSec   = toSec(m[2]);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
      return { startSec, endSec };
    })
    .filter(Boolean);
}

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
    const manualSkipWindows = parseManualSkipWindows(req.body?.manualSkipWindows);

    // Persist the user's manual skips so the UI can prefill on next visit.
    project.config = project.config || {};
    project.config.manualSkipWindows = manualSkipWindows;
    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

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
        // Merge auto-detected OP/ED + user-supplied manual windows.
        const skipWindows = mergeSkipWindows([...opCuts, ...manualSkipWindows], edCuts);
        if (manualSkipWindows.length) {
          logger.info(
            `[videoExplainer] manual skip windows: ${manualSkipWindows.length} ` +
            `(${manualSkipWindows.map(w => `${w.startSec.toFixed(1)}-${w.endSec.toFixed(1)}`).join(', ')})`
          );
        }

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

        // Apply skip-window filter dynamically. This lets manual skip windows
        // take effect even when the scene-plan is a cache hit (the breakdown
        // itself doesn't filter by skip windows anymore — see geminiVideoBreakdown.js).
        const filteredScenes = applySkipWindows(plan.scenes, skipWindows);
        if (!filteredScenes.length) throw new Error('All scenes were inside skip windows — check manual skip windows');
        logger.info(`[videoExplainer] after skip-window filter: ${filteredScenes.length}/${plan.scenes.length} scenes kept`);
        plan = { ...plan, scenes: filteredScenes };

        // 3. Story summarization (RESTORED — this is what makes the narrator
        // sound good). Per-episode summaries → bundle summary. We feed each
        // scene's visual+dialogue context to the summarizer so it understands
        // both what's seen and what's said. Cached by source identity.
        let epSummaries = null;
        if (!force) {
          epSummaries = await loadCachedEpisodeSummaries(req.params.id, sourcePath);
          if (epSummaries) {
            onStep('panels')(`Episode summaries cache hit (${epSummaries.length}) — skipping`, 82);
            logger.info(`[videoExplainer] episode-summaries cache hit: ${epSummaries.length}`);
          }
        }
        if (!epSummaries) {
          onStep('panels')('Summarizing each episode for narrator context...', 82);
          const sceneSegments = scenesToTranscriptLikeSegments(plan.scenes);
          epSummaries = await summarizeEpisodes(
            req.params.id, sceneSegments, episodes, skipWindows,
            (msg, pct) => onStep('panels')(msg, 82 + Math.round(pct * 0.05)),
            { sourcePath }
          );
        }

        let bundleSummary = null;
        if (!force) {
          bundleSummary = await loadCachedBundleSummary(req.params.id, sourcePath);
          if (bundleSummary) {
            onStep('panels')(`Bundle summary cache hit ("${bundleSummary.bundleTitle}") — skipping`, 88);
            logger.info(`[videoExplainer] bundle-summary cache hit: "${bundleSummary.bundleTitle}"`);
          }
        }
        if (!bundleSummary) {
          onStep('panels')('Combining into bundle arc summary...', 88);
          bundleSummary = await summarizeBundle(
            req.params.id, epSummaries,
            (msg, pct) => onStep('panels')(msg, 88 + Math.round(pct * 0.02)),
            { sourcePath }
          );
        }

        // 4. Mode pick + scene selection to fit target duration.
        const mode = pickMode(totalSec, targetDurationSec);
        logger.info(`[videoExplainer] mode=${mode} (source=${(totalSec/60).toFixed(1)}min → target=${(targetDurationSec/60).toFixed(1)}min)`);
        onStep('panels')(`Selecting scenes (mode=${mode})...`, 92);
        const chosenScenes = selectScenes(plan.scenes, targetDurationSec, mode);
        if (!chosenScenes.length) throw new Error('Scene selector returned zero scenes');
        await safeWriteJson(projectPath(req.params.id, 'beats.json'), { mode, totalSec, targetDurationSec, scenes: chosenScenes });

        project.state.panels = 'complete';
        project.stats.panelCount = chosenScenes.length;
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'panels', `Scene selection complete: ${chosenScenes.length} scenes`, 100);

        // 5. Narrator script writer with FULL story context + visual scene context.
        currentStep = 'script';
        project.state.script = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        const script = await writeExplainerScript(
          req.params.id, chosenScenes, onStep('script'),
          { targetReelSec: targetDurationSec, bundleSummary }
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
