import { Router } from 'express';
import { validateProject } from '../middleware/validateProject.js';
import { safeReadJson, safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { analyzeChapters } from '../services/geminiAnalyzer.js';
import { generateScript, generateStorySummary } from '../services/geminiScriptWriter.js';
import { getPreviousStorySummary, updateStorySummary } from '../services/seriesManager.js';
import { logger } from '../utils/logger.js';

const router = Router();

// POST /:id/script/generate - trigger AI script generation
router.post('/:id/script/generate', validateProject, async (req, res, next) => {
  try {
    if (isRunning(req.params.id)) {
      return res.status(409).json({ error: 'A job is already running for this project' });
    }

    // Extract target duration from request body
    const { targetDuration } = req.body || {};
    const project = req.project;

    // Persist duration to project config if provided
    if (targetDuration && typeof targetDuration === 'number' && targetDuration > 0) {
      project.config = project.config || {};
      project.config.duration = targetDuration;
    }

    // Compute target word count from duration (150 wpm average speech rate)
    const savedDuration = project.config?.duration;
    const targetWordCount = savedDuration
      ? Math.round(savedDuration / 60 * 150)
      : null;

    runJob(req.params.id, async () => {
      try {
        project.state.script = 'processing';
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

        logger.info(`Script generation started for project ${req.params.id}`);

        // Load series context if this project belongs to a series
        const seriesId = project.seriesId;
        const episodeNumber = project.episodeNumber;
        let previousStorySummary = '';
        if (seriesId) {
          previousStorySummary = await getPreviousStorySummary(seriesId, req.params.id);
          if (previousStorySummary) {
            logger.info(`[Series] Episode ${episodeNumber} — injecting story context (${previousStorySummary.length} chars)`);
          } else {
            logger.info(`[Series] Episode ${episodeNumber} — first episode, no prior context`);
          }
        }

        // Step 1: Analyze chapters
        emit(req.params.id, 'script', 'Analyzing chapter images...', 10);
        await analyzeChapters(req.params.id, (message, percent) => {
          emit(req.params.id, 'script', message, Math.round(10 + percent * 0.4));
        }, { previousStorySummary });

        // Step 2: Generate narration script
        emit(req.params.id, 'script', 'Generating narration script...', 55);
        const script = await generateScript(req.params.id, (message, percent) => {
          emit(req.params.id, 'script', message, Math.round(55 + percent * 0.35));
        }, { targetWordCount, previousStorySummary });

        // Step 3: Update series story summary
        if (seriesId) {
          emit(req.params.id, 'script', 'Updating series story summary...', 93);
          try {
            const allAnalyses = await safeReadJson(projectPath(req.params.id, 'analysis', '_all.json'), []);
            const analysisText = allAnalyses.map(a => a.analysis).join('\n\n');
            const newSummary = await generateStorySummary(previousStorySummary, analysisText, script.title);
            await updateStorySummary(seriesId, newSummary);
            logger.info(`[Series] Story summary updated for series ${seriesId}`);
          } catch (err) {
            logger.warn(`[Series] Summary update failed (non-fatal): ${err.message}`);
          }
        }

        project.state.script = 'complete';
        project.stats.scriptWordCount = script?.segments
          ? script.segments.reduce((sum, s) => sum + (s.text || '').split(/\s+/).length, 0)
          : 0;
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'script', 'Script generation complete', 100);
      } catch (err) {
        project.state.script = 'error';
        project.errors.push({ step: 'script', message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(req.params.id, 'project.json'), project);
        emit(req.params.id, 'script', `Error: ${err.message}`, -1);
        logger.error(`Script generation failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Script generation started' });
  } catch (err) {
    next(err);
  }
});

// PUT /:id/script - save edited script
router.put('/:id/script', validateProject, async (req, res, next) => {
  try {
    const { segments, title, hook } = req.body;
    const script = { title: title || '', hook: hook || '', segments: segments || [] };
    await safeWriteJson(projectPath(req.params.id, 'script.json'), script);

    const project = req.project;
    project.state.script = 'complete';
    project.stats.scriptWordCount = segments
      ? segments.reduce((sum, s) => sum + (s.text || '').split(/\s+/).length, 0)
      : 0;
    project.updatedAt = new Date().toISOString();
    await safeWriteJson(projectPath(req.params.id, 'project.json'), project);

    res.json(script);
  } catch (err) {
    next(err);
  }
});

// GET /:id/script - get script
router.get('/:id/script', validateProject, async (req, res, next) => {
  try {
    const script = await safeReadJson(projectPath(req.params.id, 'script.json'), { segments: [], title: '', hook: '' });
    res.json(script);
  } catch (err) {
    next(err);
  }
});

export default router;
