#!/usr/bin/env node
/**
 * DeepSeek smoke test.
 *
 *   node scripts/test-deepseek.js
 *
 * Requires DEEPSEEK_API_KEY in .env (or in your shell).
 * Prints the model's reply and exits 0 on success, 1 on failure.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-v4-flash';

if (!API_KEY) {
  console.error('FAIL: DEEPSEEK_API_KEY not set. Add it to .env or export it in your shell.');
  process.exit(1);
}

const prompt = 'Reply with exactly one word: pong';

console.log(`→ POST ${BASE_URL}/chat/completions  (model=${MODEL})`);
const start = Date.now();

try {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 16,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`FAIL: HTTP ${res.status} — ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content ?? '<empty>';
  const usage = data.usage ?? {};
  const ms = Date.now() - start;

  console.log(`✓ OK in ${ms}ms`);
  console.log(`  reply:        ${JSON.stringify(reply)}`);
  console.log(`  prompt tok:   ${usage.prompt_tokens ?? '?'}`);
  console.log(`  cached tok:   ${usage.prompt_cache_hit_tokens ?? 0}`);
  console.log(`  output tok:   ${usage.completion_tokens ?? '?'}`);
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}
