/**
 * Persistent app settings stored in data/settings.json.
 * Survives server restarts. Env vars are used as initial defaults only.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'data'
);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  visionBackend:   process.env.OLLAMA_MODEL      ? 'ollama' : 'gemini',
  ollamaModel:     process.env.OLLAMA_MODEL      || 'gemma4:e4b',
  ollamaBaseUrl:   process.env.OLLAMA_BASE_URL   || 'http://localhost:11434',
  geminiModel:     process.env.GEMINI_MODEL      || 'gemini-2.5-flash',
  textBackend:     process.env.OLLAMA_TEXT_MODEL ? 'ollama' : 'gemini',
  ollamaTextModel: process.env.OLLAMA_TEXT_MODEL || 'gemma4:e4b',
  groqVisionModel: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
  groqTextModel:   process.env.GROQ_TEXT_MODEL   || 'llama-3.3-70b-versatile',
};

let _cache = null;

export async function getSettings() {
  if (_cache) return _cache;
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf-8');
    _cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    _cache = { ...DEFAULTS };
  }
  return _cache;
}

export async function saveSettings(updates) {
  const current = await getSettings();
  _cache = { ...current, ...updates };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(_cache, null, 2), 'utf-8');
  return _cache;
}
