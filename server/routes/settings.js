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
    const { visionBackend, textBackend, ollamaModel, ollamaTextModel, geminiModel, groqVisionModel, groqTextModel } = req.body;
    const updates = {};
    const validBackends = ['ollama', 'groq', 'gemini'];
    if (validBackends.includes(visionBackend)) updates.visionBackend   = visionBackend;
    if (validBackends.includes(textBackend))   updates.textBackend     = textBackend;
    if (ollamaModel)     updates.ollamaModel     = ollamaModel;
    if (ollamaTextModel) updates.ollamaTextModel = ollamaTextModel;
    if (geminiModel)     updates.geminiModel     = geminiModel;
    if (groqVisionModel) updates.groqVisionModel = groqVisionModel;
    if (groqTextModel)   updates.groqTextModel   = groqTextModel;
    res.json(buildResponse(await saveSettings(updates)));
  } catch (err) { next(err); }
});

export default router;
