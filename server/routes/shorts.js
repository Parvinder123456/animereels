/**
 * Shorts feature routes.
 *
 *   POST /api/shorts
 *     Body: { url, name?, clipCount?, clipDuration?, aspect?, language?, subtitles? }
 *     Download → Transcribe → AI detect interesting segments → Render clips
 *     Returns { id }
 *
 *   GET  /api/shorts/:id/clips
 *     Returns list of generated clips with metadata.
 *
 *   GET  /api/shorts/:id/clips/:index/download
 *     Download a specific clip.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ensureDir, safeReadJson, safeWriteJson, projectDir, projectPath, fileExists,
} from '../utils/fileHelpers.js';
import { runJob, emit, isRunning } from '../jobs/processor.js';
import { downloadYouTubeVideo } from '../services/youtubeDownloader.js';
import { transcribeForTranslation } from '../services/whisperTranscribe.js';
import { detectInterestingSegments } from '../services/shortsDetector.js';
import { renderShortClips, renderTranslatedShortClip } from '../services/shortsRenderer.js';
import { translateAndScript } from '../services/translationService.js';
import { generateNarration as generateNarrationEdge } from '../services/edgeTTS.js';
import { generateNarration as generateNarrationElevenLabs } from '../services/elevenLabsTTS.js';
import { parseEnglishScript } from '../utils/scriptParser.js';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

const router = Router();

function newProject(name) {
  const id = `proj_${uuidv4().slice(0, 8)}`;
  return {
    id,
    name: name || 'YouTube Shorts',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: { upload: 'pending', panels: 'pending', script: 'pending', voice: 'pending', render: 'pending' },
    config: {
      projectType: 'shorts',
      clipCount: 5,
      clipDuration: 60,
      aspect: '9:16',
      subtitles: true,
    },
    stats: { chapterCount: 0, pageCount: 0, panelCount: 0, scriptWordCount: 0, audioDurationSec: 0, videoDurationSec: 0 },
    errors: [],
  };
}

// ─── POST / — create shorts project ─────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { name, url, clipCount, clipDuration, aspect, language, subtitles } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required (YouTube link)' });
    }

    const project = newProject(name);
    if (clipCount && clipCount > 0) project.config.clipCount = Math.min(clipCount, 20);
    if (clipDuration && clipDuration > 0) project.config.clipDuration = Math.min(clipDuration, 180);
    if (aspect && ['9:16', '16:9', '1:1'].includes(aspect)) project.config.aspect = aspect;
    if (typeof subtitles === 'boolean') project.config.subtitles = subtitles;
    if (language) project.config.language = language;

    await ensureDir(projectDir(project.id));
    await safeWriteJson(projectPath(project.id, 'project.json'), project);
    logger.info(`[shorts] created ${project.id} url=${url} clips=${project.config.clipCount}`);

    if (isRunning(project.id)) return res.status(409).json({ error: 'Job already running' });

    runJob(project.id, async () => {
      const onStep = (step) => (message, percent) => {
        logger.info(`[shorts/${step}] ${percent}% — ${message}`);
        emit(project.id, step, message, percent);
      };

      let currentStep = 'upload';
      try {
        // ── Step 1: Download ──
        project.state.upload = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        const dl = await downloadYouTubeVideo(project.id, url, onStep('upload'));
        project.state.upload = 'complete';
        project.stats.videoDurationSec = dl.durationSec;
        if (!project.name || project.name === 'YouTube Shorts') project.name = dl.title || project.name;
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'upload', 'Download complete', 100);

        // ── Step 2: Transcribe ──
        currentStep = 'panels';
        project.state.panels = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        const transcript = await transcribeForTranslation(
          project.id, dl.path,
          { language: project.config.language || undefined },
          onStep('panels'),
        );
        project.state.panels = 'complete';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'panels', `Transcribed: ${transcript.segments.length} segments`, 100);

        // ── Step 3: Detect interesting segments ──
        currentStep = 'script';
        project.state.script = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'script', 'AI is finding the most interesting moments...', 20);

        const dur = project.config.clipDuration;
        const clips = await detectInterestingSegments(transcript.segments, {
          clipCount: project.config.clipCount,
          clipDurationMin: Math.max(15, dur - 30),
          clipDurationMax: dur + 30,
        });

        if (!clips.length) throw new Error('AI could not find interesting segments in this video');

        await safeWriteJson(projectPath(project.id, 'shorts-clips.json'), clips);
        project.state.script = 'complete';
        project.stats.panelCount = clips.length;
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'script', `Found ${clips.length} interesting moments`, 100);

        // ── Step 4: Render clips ──
        currentStep = 'render';
        project.state.render = 'processing';
        await safeWriteJson(projectPath(project.id, 'project.json'), project);

        const results = await renderShortClips(
          project.id,
          clips,
          transcript.segments,
          { aspect: project.config.aspect, subtitles: project.config.subtitles },
          onStep('render'),
        );

        await safeWriteJson(projectPath(project.id, 'shorts-results.json'), results);
        project.state.render = 'complete';
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, 'render', `${results.length} clips ready`, 100);

      } catch (err) {
        project.state[currentStep] = 'error';
        project.errors.push({ step: currentStep, message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(project.id, 'project.json'), project);
        emit(project.id, currentStep, `Error: ${err.message}`, -1);
        logger.error(`[shorts] ${project.id} step=${currentStep} failed: ${err.message}`);
      }
    }).catch((err) => {
      logger.error(`[shorts] ${project.id} unhandled: ${err?.message || err}`);
    });

    res.status(202).json({ id: project.id, message: 'Shorts job started' });
  } catch (err) { next(err); }
});

// ─── GET /:id/clips — list generated clips ──────────────────────────────────

router.get('/:id/clips', async (req, res, next) => {
  try {
    const results = await safeReadJson(projectPath(req.params.id, 'shorts-results.json'));
    if (!results) return res.status(404).json({ error: 'No clips generated yet' });
    res.json(results);
  } catch (err) { next(err); }
});

// ─── GET /:id/clips/:index/download — download one clip ─────────────────────

router.get('/:id/clips/:index/download', async (req, res, next) => {
  try {
    const idx = String(Number(req.params.index) + 1).padStart(3, '0');
    const clipPath = projectPath(req.params.id, 'output', `clip_${idx}.mp4`);
    if (!await fileExists(clipPath)) {
      return res.status(404).json({ error: 'Clip not found' });
    }
    const results = await safeReadJson(projectPath(req.params.id, 'shorts-results.json'), []);
    const clip = results[Number(req.params.index)];
    const filename = clip?.title
      ? `${clip.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 50)}.mp4`
      : `clip_${idx}.mp4`;
    res.download(clipPath, filename);
  } catch (err) { next(err); }
});

// ─── POST /:id/retry — re-run from transcription (when transcript failed) ────

router.post('/:id/retry', async (req, res, next) => {
  try {
    const { id } = req.params;
    const project = await safeReadJson(projectPath(id, 'project.json'));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (isRunning(id)) return res.status(409).json({ error: 'Job already running' });

    const sourcePath = projectPath(id, 'source.mp4');
    if (!await fileExists(sourcePath)) return res.status(400).json({ error: 'Source video missing — re-create project' });

    runJob(id, async () => {
      const onStep = (step) => (message, percent) => {
        logger.info(`[shorts/${step}] ${percent}% — ${message}`);
        emit(id, step, message, percent);
      };

      let currentStep = 'panels';
      try {
        // ── Step 2: Transcribe ──
        project.state.panels = 'processing';
        project.state.script = 'pending';
        project.state.render = 'pending';
        await safeWriteJson(projectPath(id, 'project.json'), project);

        const transcript = await transcribeForTranslation(
          id, sourcePath,
          { language: project.config.language || undefined },
          onStep('panels'),
        );
        project.state.panels = 'complete';
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'panels', `Transcribed: ${transcript.segments.length} segments`, 100);

        // ── Step 3: Detect interesting segments ──
        currentStep = 'script';
        project.state.script = 'processing';
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'script', 'AI is finding the most interesting moments...', 20);

        const dur = project.config.clipDuration;
        const clips = await detectInterestingSegments(transcript.segments, {
          clipCount: project.config.clipCount,
          clipDurationMin: Math.max(15, dur - 30),
          clipDurationMax: dur + 30,
        });

        if (!clips.length) throw new Error('AI could not find interesting segments in this video');

        await safeWriteJson(projectPath(id, 'shorts-clips.json'), clips);
        project.state.script = 'complete';
        project.stats.panelCount = clips.length;
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'script', `Found ${clips.length} interesting moments`, 100);

        // ── Step 4: Render clips ──
        currentStep = 'render';
        project.state.render = 'processing';
        await safeWriteJson(projectPath(id, 'project.json'), project);

        const results = await renderShortClips(
          id, clips, transcript.segments,
          { aspect: project.config.aspect, subtitles: project.config.subtitles },
          onStep('render'),
        );

        await safeWriteJson(projectPath(id, 'shorts-results.json'), results);
        project.state.render = 'complete';
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'render', `${results.length} clips ready`, 100);

      } catch (err) {
        project.state[currentStep] = 'error';
        project.errors.push({ step: currentStep, message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, currentStep, `Error: ${err.message}`, -1);
        logger.error(`[shorts/retry] ${id} step=${currentStep} failed: ${err.message}`);
      }
    }).catch(() => {});

    res.json({ success: true, message: 'Retrying from transcription' });
  } catch (err) { next(err); }
});

// ─── POST /:id/redetect — re-run detection with new settings ────────────────

router.post('/:id/redetect', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { clipCount, clipDuration, aspect, subtitles } = req.body || {};
    const project = await safeReadJson(projectPath(id, 'project.json'));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (isRunning(id)) return res.status(409).json({ error: 'Job already running' });

    if (clipCount) project.config.clipCount = Math.min(clipCount, 20);
    if (clipDuration) project.config.clipDuration = Math.min(clipDuration, 180);
    if (aspect) project.config.aspect = aspect;
    if (typeof subtitles === 'boolean') project.config.subtitles = subtitles;

    runJob(id, async () => {
      const onStep = (step) => (message, percent) => {
        emit(id, step, message, percent);
      };
      let currentStep = 'script';
      try {
        const transcript = await safeReadJson(projectPath(id, 'audio', 'source-transcript.json'));
        if (!transcript?.segments?.length) throw new Error('No transcript found — re-run from scratch');

        project.state.script = 'processing';
        project.state.render = 'pending';
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'script', 'Re-detecting interesting moments...', 20);

        const dur = project.config.clipDuration;
        const clips = await detectInterestingSegments(transcript.segments, {
          clipCount: project.config.clipCount,
          clipDurationMin: Math.max(15, dur - 30),
          clipDurationMax: dur + 30,
        });
        if (!clips.length) throw new Error('AI could not find interesting segments');

        await safeWriteJson(projectPath(id, 'shorts-clips.json'), clips);
        project.state.script = 'complete';
        project.stats.panelCount = clips.length;
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'script', `Found ${clips.length} moments`, 100);

        currentStep = 'render';
        project.state.render = 'processing';
        await safeWriteJson(projectPath(id, 'project.json'), project);

        const results = await renderShortClips(
          id, clips, transcript.segments,
          { aspect: project.config.aspect, subtitles: project.config.subtitles },
          onStep('render'),
        );
        await safeWriteJson(projectPath(id, 'shorts-results.json'), results);
        project.state.render = 'complete';
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'render', `${results.length} clips ready`, 100);
      } catch (err) {
        project.state[currentStep] = 'error';
        project.errors.push({ step: currentStep, message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, currentStep, `Error: ${err.message}`, -1);
      }
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── GET /:id/clip-transcripts — original transcript text per clip ───────────

router.get('/:id/clip-transcripts', async (req, res, next) => {
  try {
    const { id } = req.params;
    const clips = await safeReadJson(projectPath(id, 'shorts-clips.json'));
    if (!clips?.length) return res.status(404).json({ error: 'No clips detected yet' });

    const transcript = await safeReadJson(projectPath(id, 'audio', 'source-transcript.json'));
    if (!transcript?.segments?.length) return res.status(404).json({ error: 'No transcript found' });

    const result = clips.map((clip, i) => {
      const segs = transcript.segments.filter(
        s => s.start < clip.endSec && s.end > clip.startSec,
      );
      return {
        clipIndex: i,
        title: clip.title,
        startSec: clip.startSec,
        endSec: clip.endSec,
        originalText: segs.map(s => s.text).join(' ').trim(),
      };
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ─── POST /:id/translate-clips — translate + voiceover for generated clips ───

router.post('/:id/translate-clips', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      engine = 'edge',
      scripts,
      sourceVolume = 0.05,
      clipIndex,      // single index (number)
      clipIndices,    // array of indices
    } = req.body || {};
    // For ElevenLabs, voiceId comes from .env; for Edge, default to GuyNeural
    const rawVoiceId = req.body?.voiceId;
    const voiceId = engine === 'elevenlabs'
      ? (rawVoiceId && !rawVoiceId.includes('Neural') ? rawVoiceId : null)
      : (rawVoiceId || 'en-US-GuyNeural');

    const project = await safeReadJson(projectPath(id, 'project.json'));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (isRunning(id)) return res.status(409).json({ error: 'Job already running' });

    const clips = await safeReadJson(projectPath(id, 'shorts-clips.json'));
    if (!clips?.length) return res.status(400).json({ error: 'No clips detected yet — generate clips first' });

    const transcript = await safeReadJson(projectPath(id, 'audio', 'source-transcript.json'));
    if (!transcript?.segments?.length) return res.status(400).json({ error: 'No transcript found' });

    // Build a lookup from clipIndex → manual script text
    const manualScripts = {};
    if (Array.isArray(scripts)) {
      for (const s of scripts) {
        if (s.clipIndex != null && s.script) manualScripts[s.clipIndex] = s.script;
      }
    }

    const narrationFn = engine === 'elevenlabs' ? generateNarrationElevenLabs : generateNarrationEdge;

    // Build set of clip indices to process
    let selectedIndices = null;
    if (Array.isArray(clipIndices) && clipIndices.length) {
      selectedIndices = new Set(clipIndices.map(Number).filter(n => n >= 0 && n < clips.length));
    } else if (clipIndex != null && !isNaN(clipIndex)) {
      const idx = Number(clipIndex);
      if (idx >= 0 && idx < clips.length) selectedIndices = new Set([idx]);
    }

    runJob(id, async () => {
      let currentStep = 'voice';
      try {
        project.state.voice = 'processing';
        await safeWriteJson(projectPath(id, 'project.json'), project);

        const translatedResults = [];

        for (let i = 0; i < clips.length; i++) {
          if (selectedIndices && !selectedIndices.has(i)) continue;
          const clip = clips[i];
          const idx = String(i + 1).padStart(3, '0');
          const window = { startSec: clip.startSec, endSec: clip.endSec };

          emit(id, 'voice', `Translating clip ${i + 1}/${clips.length}: ${clip.title}`, Math.round((i / clips.length) * 50));

          // 1. Get English script — manual or AI-translated
          let script;
          if (manualScripts[i]) {
            script = parseEnglishScript(manualScripts[i], window);
            script.sourceWindow = window;
            script.sourceLanguage = 'manual';
            await safeWriteJson(projectPath(id, 'script.json'), script);
          } else {
            script = await translateAndScript(
              id, transcript.segments,
              { window, sourceLanguage: transcript.language || 'hi' },
              () => {},
            );
          }

          // 2. Generate TTS narration (writes to audio/narration.mp3)
          emit(id, 'voice', `Generating voiceover for clip ${i + 1}/${clips.length}`, 50 + Math.round((i / clips.length) * 30));
          await narrationFn(id, voiceId, () => {});

          // 3. Move narration to per-clip file
          const narrationSrc = projectPath(id, 'audio', 'narration.mp3');
          const narrationDst = projectPath(id, 'output', `clip_${idx}_narration.mp3`);
          await ensureDir(projectPath(id, 'output'));
          await fs.copyFile(narrationSrc, narrationDst);

          // 4. Render translated clip (source video + EN narration + EN subs)
          emit(id, 'voice', `Rendering translated clip ${i + 1}/${clips.length}`, 80 + Math.round((i / clips.length) * 18));
          const enClipPath = projectPath(id, 'output', `clip_${idx}_en.mp4`);
          await renderTranslatedShortClip(
            id, clip, script.segments, narrationDst, enClipPath,
            { aspect: project.config.aspect || '9:16', sourceVolume: Math.max(0, Math.min(1, Number(sourceVolume) || 0.05)) },
          );

          translatedResults.push({
            ...clip,
            index: i,
            filename: `clip_${idx}_en.mp4`,
            durationSec: +(clip.endSec - clip.startSec).toFixed(1),
            translated: true,
          });

          // Cleanup per-clip narration
          try { await fs.unlink(narrationDst); } catch {}
        }

        await safeWriteJson(projectPath(id, 'shorts-translated.json'), translatedResults);
        project.state.voice = 'complete';
        project.updatedAt = new Date().toISOString();
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, 'voice', `${translatedResults.length} translated clips ready`, 100);

      } catch (err) {
        project.state[currentStep] = 'error';
        project.errors.push({ step: currentStep, message: err.message, at: new Date().toISOString() });
        await safeWriteJson(projectPath(id, 'project.json'), project);
        emit(id, currentStep, `Error: ${err.message}`, -1);
        logger.error(`[shorts/translate] ${id} step=${currentStep} failed: ${err.message}`);
      }
    }).catch((err) => {
      logger.error(`[shorts/translate] ${id} unhandled: ${err?.message || err}`);
    });

    res.json({ success: true, message: 'Translation + voiceover started' });
  } catch (err) { next(err); }
});

// ─── GET /:id/translated-clips — list translated clips ──────────────────────

router.get('/:id/translated-clips', async (req, res, next) => {
  try {
    const results = await safeReadJson(projectPath(req.params.id, 'shorts-translated.json'));
    if (!results) return res.status(404).json({ error: 'No translated clips yet' });
    res.json(results);
  } catch (err) { next(err); }
});

// ─── GET /:id/translated-clips/:index/download ──────────────────────────────

router.get('/:id/translated-clips/:index/download', async (req, res, next) => {
  try {
    const idx = String(Number(req.params.index) + 1).padStart(3, '0');
    const clipPath = projectPath(req.params.id, 'output', `clip_${idx}_en.mp4`);
    if (!await fileExists(clipPath)) return res.status(404).json({ error: 'Translated clip not found' });
    const results = await safeReadJson(projectPath(req.params.id, 'shorts-translated.json'), []);
    const clip = results[Number(req.params.index)];
    const filename = clip?.title
      ? `${clip.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 50)} (EN).mp4`
      : `clip_${idx}_en.mp4`;
    res.download(clipPath, filename);
  } catch (err) { next(err); }
});

export default router;
