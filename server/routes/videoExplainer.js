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
import { downloadYouTubeVideo } from '../services/youtubeDownloader.js';
import { detectOpEd, mergeSkipWindows, loadCachedOpEd } from '../services/opEdDetector.js';
import { breakDownVideo, loadCachedPlan, applySkipWindows } from '../services/geminiVideoBreakdown.js';
import { selectScenes, pickMode } from '../services/sceneSelector.js';
import {
  summarizeEpisodes, summarizeBundle,
  loadCachedEpisodeSummaries, loadCachedBundleSummary,
} from '../services/storySummarizer.js';
import { writeExplainerScript } from '../services/explainerScriptWriter.js';
import { generateTitlePack, loadTitlePack } from '../services/titleGenerator.js';
import { generateThumbnail } from '../services/thumbnailGenerator.js';
import { translateScript, listSupportedLanguages } from '../services/scriptTranslator.js';
import { pickShortsFromScenes, sceneSegmentsToTranscript } from '../services/autoShortsFromScenes.js';
import { renderShortClips } from '../services/shortsRenderer.js';
import { logger } from '../utils/logger.js';

/**
 * Adapt Gemini scene-plan scenes into the {start, end, text} segment
 * shape that storySummarizer expects. For podcast/interview content the
 * dialogue and takeaway carry 90% of the signal; visuals are secondary.
 * For narrative content, visuals matter more.
 */
function scenesToTranscriptLikeSegments(scenes) {
  return scenes.map(s => {
    const parts = [];
    if (s.keyTakeaway)       parts.push(`[TAKEAWAY] ${s.keyTakeaway}`);
    if (s.dialogueVerbatim)  parts.push(`[SAYS] ${s.dialogueVerbatim}`);
    else if (s.dialogueGist) parts.push(`[GIST] ${s.dialogueGist}`);
    if (s.visualDescription) parts.push(`[VISUAL] ${s.visualDescription}`);
    return { start: s.startSec, end: s.endSec, text: parts.join(' ') || '(no content)' };
  });
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

// ─── POST /:id/explainer-youtube ─────────────────────────────────────────────

router.post('/:id/explainer-youtube', validateProject, async (req, res, next) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'A valid YouTube URL is required' });
    }

    const project = req.project;
    project.config = project.config || {};
    project.config.projectType = 'video_explainer';
    project.state.upload = 'processing';
    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

    if (isRunning(req.params.id)) return res.status(409).json({ error: 'Job already running' });

    runJob(req.params.id, async () => {
      try {
        const dl = await downloadYouTubeVideo(req.params.id, url, (message, percent) => {
          emit(req.params.id, 'upload', message, percent);
        });

        // Write episodes.json in the same format stitchEpisodes produces
        // so the rest of the explainer pipeline works unchanged.
        const episodes = [{ idx: 0, path: dl.path, durationSec: dl.durationSec, startSec: 0 }];
        await safeWriteJson(projectPath(req.params.id, 'episodes.json'), {
          files: episodes,
          totalSec: dl.durationSec,
        });

        project.state.upload = 'complete';
        project.stats.chapterCount = 1;
        project.stats.videoDurationSec = Math.round(dl.durationSec);
        if (dl.title) project.name = dl.title;
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'upload', 'Download complete', 100);
      } catch (err) {
        project.state.upload = 'error';
        project.errors.push({ step: 'upload', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'upload', `Error: ${err.message}`, -1);
        logger.error(`[videoExplainer/youtube] ${req.params.id} failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, url });
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
    const validFormats = ['recap', 'takeaways', 'motivational', 'highlights'];
    const outputFormat = validFormats.includes(req.body?.outputFormat) ? req.body.outputFormat : 'recap';

    // Persist user choices so the UI can prefill on next visit.
    project.config = project.config || {};
    project.config.manualSkipWindows = manualSkipWindows;
    project.config.outputFormat = outputFormat;
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
        // Safety: drop scenes whose timestamps go beyond the actual source
        // (Gemini can hallucinate timestamps for short last chunks).
        const validScenes = plan.scenes.filter(s => s.startSec < totalSec - 1);
        // Reindex while preserving callbackTo references
        const oldToNew = new Map();
        validScenes.forEach((s, i) => {
          oldToNew.set(s.idx, i);
          s.endSec = Math.min(s.endSec, totalSec);
          s.idx = i;
        });
        for (const s of validScenes) {
          if (s.callbackTo != null) {
            s.callbackTo = oldToNew.has(s.callbackTo) ? oldToNew.get(s.callbackTo) : null;
          }
        }
        if (validScenes.length < plan.scenes.length) {
          logger.warn(
            `[videoExplainer] dropped ${plan.scenes.length - validScenes.length} scenes ` +
            `beyond source duration (${totalSec.toFixed(0)}s)`
          );
        }

        const mode = pickMode(totalSec, targetDurationSec);
        logger.info(`[videoExplainer] mode=${mode} (source=${(totalSec/60).toFixed(1)}min → target=${(targetDurationSec/60).toFixed(1)}min)`);
        onStep('panels')(`Selecting scenes (mode=${mode})...`, 92);
        const chosenScenes = selectScenes(validScenes, targetDurationSec, mode);
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
          { targetReelSec: targetDurationSec, bundleSummary, outputFormat }
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

// ─── GET /:id/explainer/preview ──────────────────────────────────────────────
// Returns the artifacts produced by the analysis step so the user can review
// the script + selected scenes + skip windows BEFORE running voice + render.

router.get('/:id/explainer/preview', validateProject, async (req, res, next) => {
  try {
    const id = req.params.id;
    const [script, beats, bundleEnv, opEd] = await Promise.all([
      safeReadJson(projectPath(id, 'script.json'),       null),
      safeReadJson(projectPath(id, 'beats.json'),        null),
      safeReadJson(projectPath(id, 'bundle-summary.json'), null),
      safeReadJson(projectPath(id, 'op-ed-cuts.json'),   null),
    ]);

    // bundle-summary.json now wraps the bundle under .bundle (post source-identity cache).
    // Old projects may have it at the top level.
    const bundle = bundleEnv?.bundle || bundleEnv || null;

    const segments = script?.segments || [];
    const stats = {
      sceneCount: segments.length,
      totalWords: segments.reduce((n, s) => n + (s.text ? s.text.split(/\s+/).filter(Boolean).length : 0), 0),
      sourceDurationSec: beats?.totalSec || null,
      mode: beats?.mode || null,
      targetDurationSec: beats?.targetDurationSec || null,
      coveredDurationSec: segments.length ? segments[segments.length - 1].sourceEnd - segments[0].sourceStart : 0,
    };

    // Join script segments with their corresponding scene metadata from beats.json
    // so the UI can show "visual + dialogue + narration" in one row.
    const scenesByIdx = new Map((beats?.scenes || []).map(s => [s.idx, s]));
    const rows = segments.map((seg, i) => {
      const scene = scenesByIdx.get(seg.sceneIndex ?? i) || {};
      return {
        sceneIndex: seg.sceneIndex ?? i,
        sourceStart: seg.sourceStart,
        sourceEnd: seg.sourceEnd,
        durationSec: seg.sourceEnd - seg.sourceStart,
        type: scene.type || null,
        mood: seg.mood || scene.mood || null,
        importance: scene.importance || null,
        characters: scene.characters || [],
        visualDescription: scene.visualDescription || null,
        dialogueGist: scene.dialogueGist || null,
        dialogueVerbatim: scene.dialogueVerbatim || null,
        narration: seg.text || '',
      };
    });

    res.json({
      title: script?.title || null,
      hook: script?.hook || null,
      stats,
      bundle,
      skipWindows: {
        op: opEd?.opCuts || [],
        ed: opEd?.edCuts || [],
        manual: req.project?.config?.manualSkipWindows || [],
      },
      scenes: rows,
    });
  } catch (err) { next(err); }
});

// ─── GET /:id/explainer/title ────────────────────────────────────────────────
// Return the cached title pack if present, else 204.

router.get('/:id/explainer/title', validateProject, async (req, res, next) => {
  try {
    const pack = await loadTitlePack(req.params.id);
    if (!pack) return res.status(204).end();
    res.json(pack);
  } catch (err) { next(err); }
});

// ─── POST /:id/explainer/title ───────────────────────────────────────────────
// Generate (or regenerate) the title pack. Cheap LLM call.

router.post('/:id/explainer/title', validateProject, async (req, res, next) => {
  try {
    const force = req.body?.force === true || req.body?.force === 'true';
    const pack = await generateTitlePack(req.params.id, { force });
    res.json(pack);
  } catch (err) { next(err); }
});

// ─── POST /:id/explainer/thumbnail ───────────────────────────────────────────

router.post('/:id/explainer/thumbnail', validateProject, async (req, res, next) => {
  try {
    const force = req.body?.force === true || req.body?.force === 'true';
    const aspect = ['16:9', '9:16', '1:1', 'auto'].includes(req.body?.aspect) ? req.body.aspect : 'auto';
    const result = await generateThumbnail(req.params.id, { aspect, force });
    res.json({ ...result, url: `/data/${req.params.id}/output/thumbnail.jpg?t=${Date.now()}` });
  } catch (err) { next(err); }
});

// ─── GET /api/projects/:id/explainer/languages ─────────────────────────────

router.get('/:id/explainer/languages', validateProject, async (_req, res, next) => {
  try { res.json({ languages: listSupportedLanguages() }); }
  catch (err) { next(err); }
});

// ─── POST /:id/explainer/translate ───────────────────────────────────────────

router.post('/:id/explainer/translate', validateProject, async (req, res, next) => {
  try {
    const language = String(req.body?.language || '').trim().toLowerCase();
    if (!language) return res.status(400).json({ error: 'language code required' });
    const force = req.body?.force === true || req.body?.force === 'true';

    // Long-running — run in the job queue with SSE progress.
    if (isRunning(req.params.id)) return res.status(409).json({ error: 'Job running' });
    runJob(req.params.id, async () => {
      try {
        await translateScript(req.params.id, language, {
          force,
          onProgress: (msg, pct) => emit(req.params.id, 'translate', msg, pct),
        });
        emit(req.params.id, 'translate', `Translation complete: ${language}`, 100);
      } catch (err) {
        emit(req.params.id, 'translate', `Error: ${err.message}`, -1);
        logger.error(`[explainer/translate] ${err.message}`);
      }
    }).catch(() => {});
    res.json({ started: true, language });
  } catch (err) { next(err); }
});

// ─── POST /:id/explainer/shorts ──────────────────────────────────────────────
// Auto-detect high-importance scene clusters from the cached scene plan and
// render each as a vertical Short. Reuses shortsRenderer.renderShortClips()
// so the per-clip ffmpeg path is identical to the manual Shorts flow.
//
// Body: { count?, minSec?, maxSec?, importance?, aspect?, subtitles? }
// Default: 8 Shorts, 30-60s each, importance>=4, 9:16, subtitles on.

router.post('/:id/explainer/shorts', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) return res.status(409).json({ error: 'A job is already running' });

    const sourcePath = projectPath(req.params.id, 'source.mp4');
    if (!await fileExists(sourcePath)) {
      return res.status(400).json({ error: 'No source video — upload episodes first' });
    }

    const planEnv = await safeReadJson(projectPath(req.params.id, 'scene-plan.json'));
    if (!planEnv?.scenes?.length) {
      return res.status(400).json({ error: 'No scene plan — run analysis first' });
    }

    const opEd = await safeReadJson(projectPath(req.params.id, 'op-ed-cuts.json'));
    const manualSkips = req.project?.config?.manualSkipWindows || [];
    const skipWindows = [
      ...(opEd?.opCuts || []),
      ...(opEd?.edCuts || []),
      ...manualSkips,
    ];

    const opts = {
      count:         Math.max(1, Math.min(20, Number(req.body?.count) || 8)),
      minSec:        Math.max(15, Math.min(90, Number(req.body?.minSec) || 30)),
      maxSec:        Math.max(20, Math.min(90, Number(req.body?.maxSec) || 60)),
      minImportance: Math.max(1, Math.min(5, Number(req.body?.importance) || 4)),
      skipWindows,
      totalSec:      planEnv.totalSec || Infinity,
    };
    const aspect = ['16:9', '9:16', '1:1'].includes(req.body?.aspect) ? req.body.aspect : '9:16';
    const subtitles = req.body?.subtitles !== false;

    const clips = pickShortsFromScenes(planEnv.scenes, opts);
    if (!clips.length) {
      return res.status(400).json({
        error: `No scenes met importance>=${opts.minImportance}. Try lowering the threshold or re-running analysis.`,
      });
    }

    const transcript = sceneSegmentsToTranscript(planEnv.scenes);
    await safeWriteJson(projectPath(req.params.id, 'shorts-plan.json'), {
      clips, aspect, subtitles, opts, generatedAt: new Date().toISOString(),
    });

    runJob(req.params.id, async () => {
      try {
        emit(req.params.id, 'shorts', `Rendering ${clips.length} Shorts (${aspect})...`, 2);
        const results = await renderShortClips(
          req.params.id, clips, transcript,
          { aspect, subtitles },
          (msg, pct) => emit(req.params.id, 'shorts', msg, Math.max(2, Math.min(98, pct))),
        );

        // Update manifest with rendered file URLs for the UI.
        const manifest = {
          aspect, subtitles,
          generatedAt: new Date().toISOString(),
          clips: results.map(r => ({
            index: r.index,
            filename: r.filename,
            url: `/data/${req.params.id}/output/${r.filename}`,
            title: r.title,
            reason: r.reason,
            startSec: r.startSec,
            endSec: r.endSec,
            durationSec: r.durationSec,
          })),
        };
        await safeWriteJson(projectPath(req.params.id, 'shorts-manifest.json'), manifest);
        emit(req.params.id, 'shorts', `${results.length} Shorts ready`, 100);
        logger.info(`[explainer/shorts] ${req.params.id}: ${results.length} clips`);
      } catch (err) {
        emit(req.params.id, 'shorts', `Error: ${err.message}`, -1);
        logger.error(`[explainer/shorts] ${err.message}`);
      }
    }).catch(() => {});

    res.json({
      started: true,
      planned: clips.length,
      clips: clips.map(c => ({ title: c.title, startSec: c.startSec, endSec: c.endSec, durationSec: c.durationSec })),
    });
  } catch (err) { next(err); }
});

// ─── GET /:id/explainer/shorts ───────────────────────────────────────────────
// Return the latest shorts manifest if rendering has run at least once.

router.get('/:id/explainer/shorts', validateProject, async (req, res, next) => {
  try {
    const manifest = await safeReadJson(projectPath(req.params.id, 'shorts-manifest.json'));
    if (!manifest) return res.status(204).end();
    res.json(manifest);
  } catch (err) { next(err); }
});

// ─── POST /:id/explainer/config ──────────────────────────────────────────────
// Light-weight project config setter used by render-step toggles
// (musicBed, copyrightHardening defaults, channelName, etc.).

router.patch('/:id/explainer/config', validateProject, async (req, res, next) => {
  try {
    const project = req.project;
    project.config = project.config || {};

    const { musicBed, channelName } = req.body || {};
    if (typeof musicBed === 'boolean') project.config.musicBed = musicBed;
    if (typeof channelName === 'string') project.config.channelName = channelName.slice(0, 60);

    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
    res.json({ ok: true, config: project.config });
  } catch (err) { next(err); }
});

export default router;
