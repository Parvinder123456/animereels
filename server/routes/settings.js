import { Router } from 'express';
import { getSettings, saveSettings } from '../utils/appSettings.js';

const router = Router();

function buildResponse(s) {
  return {
    visionBackend:   s.visionBackend,
    textBackend:     s.textBackend,
    ollama: {
      model:        s.ollamaModel,
      textModel:    s.ollamaTextModel,
      baseUrl:      s.ollamaBaseUrl,
      visionActive: s.visionBackend === 'ollama',
      textActive:   s.textBackend   === 'ollama',
    },
    groq: {
      visionModel:  s.groqVisionModel,
      textModel:    s.groqTextModel,
      hasApiKey:    !!process.env.GROQ_API_KEY,
      visionActive: s.visionBackend === 'groq',
      textActive:   s.textBackend   === 'groq',
    },
    gemini: {
      model:        s.geminiModel,
      hasApiKey:    !!process.env.GEMINI_API_KEY,
      visionActive: s.visionBackend === 'gemini',
      textActive:   s.textBackend   === 'gemini',
    },
    deepseek: {
      textModel:    s.deepseekTextModel,
      baseUrl:      s.deepseekBaseUrl,
      hasApiKey:    !!process.env.DEEPSEEK_API_KEY,
      textActive:   s.textBackend === 'deepseek',
    },
    transcription: {
      backend:          s.transcriptionBackend,
      groqWhisperModel: s.groqWhisperModel,
      hasOpenaiKey:     !!process.env.OPENAI_API_KEY,
      hasGroqKey:       !!process.env.GROQ_API_KEY,
      hasGeminiKey:     !!process.env.GEMINI_API_KEY,
    },
  };
}

// GET /api/settings
router.get('/', async (_req, res, next) => {
  try {
    res.json(buildResponse(await getSettings()));
  } catch (err) { next(err); }
});

// POST /api/settings
router.post('/', async (req, res, next) => {
  try {
    const { visionBackend, textBackend, ollamaModel, ollamaTextModel, geminiModel, groqVisionModel, groqTextModel, deepseekTextModel, deepseekBaseUrl, transcriptionBackend, groqWhisperModel } = req.body;
    const updates = {};
    const validVisionBackends = ['ollama', 'groq', 'gemini'];
    const validTextBackends   = ['ollama', 'groq', 'gemini', 'deepseek'];
    const validTranscription  = ['gemini', 'groq', 'openai'];
    if (validVisionBackends.includes(visionBackend))       updates.visionBackend        = visionBackend;
    if (validTextBackends.includes(textBackend))           updates.textBackend          = textBackend;
    if (validTranscription.includes(transcriptionBackend)) updates.transcriptionBackend = transcriptionBackend;
    if (ollamaModel)       updates.ollamaModel       = ollamaModel;
    if (ollamaTextModel)   updates.ollamaTextModel   = ollamaTextModel;
    if (geminiModel)       updates.geminiModel       = geminiModel;
    if (groqVisionModel)   updates.groqVisionModel   = groqVisionModel;
    if (groqTextModel)     updates.groqTextModel     = groqTextModel;
    if (deepseekTextModel) updates.deepseekTextModel = deepseekTextModel;
    if (deepseekBaseUrl)   updates.deepseekBaseUrl   = deepseekBaseUrl;
    if (groqWhisperModel)  updates.groqWhisperModel  = groqWhisperModel;
    res.json(buildResponse(await saveSettings(updates)));
  } catch (err) { next(err); }
});

export default router;
