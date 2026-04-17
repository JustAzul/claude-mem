#!/usr/bin/env node
/**
 * Smoke test for CustomOpenAIAgent against any OpenAI-compatible backend.
 *
 * Reproduces the exact fetch shape used by src/services/worker/CustomOpenAIAgent.ts::query()
 * so we can validate provider wiring without spinning up the whole worker + DB.
 *
 * Usage:
 *   CUSTOM_OPENAI_BASE_URL=https://example.com/v1 \
 *   CUSTOM_OPENAI_API_KEY=... \
 *   CUSTOM_OPENAI_MODEL=your-model-id \
 *     node scripts/test-custom-provider.mjs
 */

const baseUrl = process.env.CUSTOM_OPENAI_BASE_URL;
const apiKey  = process.env.CUSTOM_OPENAI_API_KEY;
const model   = process.env.CUSTOM_OPENAI_MODEL;

const missing = [];
if (!baseUrl) missing.push('CUSTOM_OPENAI_BASE_URL');
if (!apiKey)  missing.push('CUSTOM_OPENAI_API_KEY');
if (!model)   missing.push('CUSTOM_OPENAI_MODEL');
if (missing.length) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(2);
}

const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
const body = {
  model,
  messages: [
    { role: 'user', content: 'Reply with the single word OK and nothing else.' },
  ],
};
if (process.env.CUSTOM_OPENAI_TEMPERATURE) body.temperature = Number(process.env.CUSTOM_OPENAI_TEMPERATURE);
if (process.env.CUSTOM_OPENAI_MAX_OUTPUT_TOKENS) body.max_tokens = parseInt(process.env.CUSTOM_OPENAI_MAX_OUTPUT_TOKENS, 10);

const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const elapsedMs = Date.now() - t0;

if (!res.ok) {
  const text = await res.text();
  console.error(`FAIL  ${res.status}  ${text}`);
  process.exit(1);
}

const data = await res.json();
const content = data?.choices?.[0]?.message?.content ?? '';
const usage = data?.usage ?? {};

console.log(JSON.stringify({
  ok: true,
  url,
  model,
  elapsedMs,
  content,
  usage,
}, null, 2));
