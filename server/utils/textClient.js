/**
 * Unified text client — routes to Ollama (local), Groq, DeepSeek, or Gemini (cloud).
 * Controlled by the persistent textBackend setting, switchable from the UI.
 *
 * Recommended local models:
 *   ollama pull gemma4:e4b    (4B efficient, default)
 *   ollama pull gemma4        (larger, higher quality)
 *   ollama pull llama3.1:8b   (8B, strong reasoning)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { getSettings } from './appSettings.js';
import { logger } from './logger.js';

const TEXT_TIMEOUT_MS = 300_000; // 5 min for local script generation

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export async function textQuery(prompt, { temperature = 0.7 } = {}) {
  const s = await getSettings();
  if (s.textBackend === 'ollama') {
    logger.info(`[Text] Local Ollama · ${s.ollamaTextModel}`);
    return ollamaText(prompt, s, { temperature });
  }
  if (s.textBackend === 'groq') {
    logger.info(`[Text] Groq Cloud · ${s.groqTextModel}`);
    return groqText(prompt, s, { temperature });
  }
  if (s.textBackend === 'deepseek') {
    logger.info(`[Text] DeepSeek Cloud · ${s.deepseekTextModel}`);
    return deepseekText(prompt, s, { temperature });
  }
  logger.info(`[Text] Gemini Cloud · ${s.geminiModel}`);
  return geminiText(prompt, s, { temperature });
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

async function ollamaText(prompt, s, { temperature }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TEXT_TIMEOUT_MS);
  try {
    const res = await fetch(`${s.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: s.ollamaTextModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature, num_gpu: 99, num_ctx: 32768 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama text error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message?.content ?? '';
  } finally {
    clearTimeout(t);
  }
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

async function groqText(prompt, s, { temperature }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set in .env');
  const res = await withTimeout(fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: s.groqTextModel,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    }),
  }), TEXT_TIMEOUT_MS, 'groqText');
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content ?? '';
}

// ─── DeepSeek ─────────────────────────────────────────────────────────────────
// OpenAI-compatible. Base URL: https://api.deepseek.com
// Models: deepseek-v4-flash (cheap, default), deepseek-v4-pro (smarter)

async function deepseekText(prompt, s, { temperature }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set in .env');
  const baseUrl = s.deepseekBaseUrl || 'https://api.deepseek.com';
  const res = await withTimeout(fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: s.deepseekTextModel,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    }),
  }), TEXT_TIMEOUT_MS, 'deepseekText');
  if (!res.ok) throw new Error(`DeepSeek error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content ?? '';
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

const GEMINI_SAFETY_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

async function geminiText(prompt, s, { temperature }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: s.geminiModel,
    generationConfig: { temperature },
    safetySettings: GEMINI_SAFETY_OFF,
  });
  const result = await withTimeout(
    model.generateContent([prompt]),
    TEXT_TIMEOUT_MS, 'geminiText'
  );
  return result.response.text();
}
