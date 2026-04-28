/**
 * Unified vision client — routes to Ollama (local), Groq (fast cloud), or Gemini (cloud).
 * Backend is controlled by the persistent app settings (data/settings.json),
 * switchable at runtime via the UI dropdown — no .env edit or restart needed.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import { getSettings } from './appSettings.js';
import { logger } from './logger.js';

// Resize images before sending to local models — full-res manga pages are the #1 bottleneck
const LOCAL_MAX_PX = 768; // max width or height for local vision

async function resizeForLocal(imageBuffer) {
  return sharp(imageBuffer)
    .resize(LOCAL_MAX_PX, LOCAL_MAX_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

const GEMINI_SAFETY_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

export async function visionQuery(prompt, imageBuffer, mimeType) {
  const s = await getSettings();
  if (s.visionBackend === 'ollama') {
    logger.info(`[Vision] Local Ollama · ${s.ollamaModel}`);
    return ollamaVision(prompt, imageBuffer, s);
  }
  if (s.visionBackend === 'groq') {
    logger.info(`[Vision] Groq Cloud · ${s.groqVisionModel}`);
    return groqVision(prompt, imageBuffer, s);
  }
  logger.info(`[Vision] Gemini Cloud · ${s.geminiModel}`);
  return geminiVision(prompt, imageBuffer, mimeType, s);
}

export async function visionQueryBatch(prompt, images) {
  const s = await getSettings();
  if (s.visionBackend === 'ollama') {
    logger.info(`[Vision] Local Ollama · ${s.ollamaModel} · ${images.length} image(s)`);
    return ollamaVisionBatch(prompt, images, s);
  }
  if (s.visionBackend === 'groq') {
    logger.info(`[Vision] Groq Cloud · ${s.groqVisionModel} · ${images.length} image(s)`);
    return groqVisionBatch(prompt, images, s);
  }
  logger.info(`[Vision] Gemini Cloud · ${s.geminiModel} · ${images.length} image(s)`);
  return geminiVisionBatch(prompt, images, s);
}

/** Batch size recommendation per backend — local models need smaller batches */
export async function visionBatchSize() {
  const s = await getSettings();
  return s.visionBackend === 'ollama' ? 2 : 5;
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

const VISION_TIMEOUT_MS_CLOUD = 90_000;  // 90s for Gemini
const VISION_TIMEOUT_MS_LOCAL = 300_000; // 5 min for local models

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function ollamaVision(prompt, imageBuffer, s) {
  const resized = await resizeForLocal(imageBuffer);
  const base64 = resized.toString('base64');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS_LOCAL);
  try {
    const res = await fetch(`${s.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: s.ollamaModel,
        messages: [{ role: 'user', content: prompt, images: [base64] }],
        stream: false,
        options: { num_gpu: 99, num_ctx: 16384 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message?.content ?? '';
  } finally {
    clearTimeout(t);
  }
}

async function ollamaVisionBatch(prompt, images, s) {
  const resizedImages = await Promise.all(images.map(img => resizeForLocal(img.buffer)));
  const base64Images = resizedImages.map(buf => buf.toString('base64'));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS_LOCAL);
  try {
    const res = await fetch(`${s.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: s.ollamaModel,
        messages: [{ role: 'user', content: prompt, images: base64Images }],
        stream: false,
        options: { num_gpu: 99, num_ctx: 16384 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.message?.content ?? '';
  } finally {
    clearTimeout(t);
  }
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function groqVision(prompt, imageBuffer, s) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set in .env');
  const base64 = imageBuffer.toString('base64');
  const res = await withTimeout(fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: s.groqVisionModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      }],
    }),
  }), VISION_TIMEOUT_MS_CLOUD, 'groqVision');
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content ?? '';
}

async function groqVisionBatch(prompt, images, s) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set in .env');
  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    const base64 = img.buffer.toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } });
  }
  const res = await withTimeout(fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: s.groqVisionModel,
      messages: [{ role: 'user', content }],
    }),
  }), VISION_TIMEOUT_MS_CLOUD, 'groqVisionBatch');
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content ?? '';
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

function getGeminiModel(s) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({
    model: s.geminiModel,
    safetySettings: GEMINI_SAFETY_OFF,
  });
}

async function geminiVision(prompt, imageBuffer, mimeType, s) {
  const model = getGeminiModel(s);
  const result = await withTimeout(
    model.generateContent([
      prompt,
      { inlineData: { data: imageBuffer.toString('base64'), mimeType } },
    ]),
    VISION_TIMEOUT_MS_CLOUD, 'geminiVision'
  );
  return result.response.text();
}

async function geminiVisionBatch(prompt, images, s) {
  const model = getGeminiModel(s);
  const parts = [prompt];
  for (const img of images) {
    parts.push({ inlineData: { data: img.buffer.toString('base64'), mimeType: img.mimeType } });
  }
  const result = await withTimeout(
    model.generateContent(parts),
    VISION_TIMEOUT_MS_CLOUD, 'geminiVisionBatch'
  );
  return result.response.text();
}
