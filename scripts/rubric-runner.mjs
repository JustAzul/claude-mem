#!/usr/bin/env bun
/**
 * Rubric runner — scores observation capture quality by replaying each
 * stored observation_capture_snapshot through an LLM judge that rates
 * four axes (fidelity, intent_fit, concept_accuracy, type_correctness)
 * plus a ceiling flag (would better turn context have improved the score?).
 *
 * Output lands in `observation_rubric_scores`. A markdown summary prints
 * to stdout for quick triage.
 *
 * Usage:
 *   bun scripts/rubric-runner.mjs --sample 20
 *   bun scripts/rubric-runner.mjs --sample 50 --project claude-mem
 *   bun scripts/rubric-runner.mjs --sample 10 --since 1713300000000
 *
 * Provider resolution mirrors the worker's CustomOpenAIAgent — reads
 * ~/.claude-mem/settings.json for CLAUDE_MEM_CUSTOM_{BASE_URL,API_KEY,MODEL}.
 * Any OpenAI-compatible endpoint works (custom gateway, OpenRouter, OpenAI).
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');
const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const DEFAULT_SINCE = Date.now() - 48 * 3600 * 1000;

function parseArgs(argv) {
  const args = { sample: 20, project: null, since: DEFAULT_SINCE };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--since') args.since = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: bun scripts/rubric-runner.mjs [--sample N] [--project X] [--since epoch_ms]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.sample) || args.sample <= 0) {
    throw new Error(`--sample must be a positive integer (got ${args.sample})`);
  }
  if (!Number.isFinite(args.since)) {
    throw new Error(`--since must be an epoch in ms (got ${args.since})`);
  }
  return args;
}

function loadProviderConfig() {
  const raw = readFileSync(SETTINGS_PATH, 'utf8');
  const s = JSON.parse(raw);
  const baseUrl = s.CLAUDE_MEM_CUSTOM_BASE_URL;
  const apiKey = s.CLAUDE_MEM_CUSTOM_API_KEY;
  const model = s.CLAUDE_MEM_CUSTOM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      'Missing custom provider config. Set CLAUDE_MEM_CUSTOM_{BASE_URL,API_KEY,MODEL} in ~/.claude-mem/settings.json.'
    );
  }
  return { baseUrl, apiKey, model };
}

function sampleSnapshots(db, { sample, project, since }) {
  const params = [since];
  let where = 's.created_at_epoch > ?';
  if (project) {
    where += ' AND o.project = ?';
    params.push(project);
  }
  params.push(sample);
  const sql = `
    SELECT
      s.id              AS snapshot_id,
      s.observation_id  AS observation_id,
      s.user_prompt, s.prior_assistant_message, s.tool_name, s.tool_input, s.tool_output, s.cwd,
      s.captured_type, s.captured_title, s.captured_subtitle, s.captured_narrative,
      s.captured_facts, s.captured_concepts, s.captured_why, s.captured_alternatives_rejected,
      o.project
    FROM observation_capture_snapshots s
    JOIN observations o ON o.id = s.observation_id
    WHERE ${where}
    ORDER BY RANDOM()
    LIMIT ?
  `;
  return db.prepare(sql).all(...params);
}

const JUDGE_INSTRUCTIONS = `You are an auditor scoring the quality of an AI-generated "observation" that was captured from a developer's tool usage. You receive the raw tool input, the tool output, the user's request, and the captured observation fields. Score four axes on a continuous 0.0–1.0 scale:

1. fidelity: Do the narrative and facts accurately reflect what the tool_input and tool_output show? Penalize hallucinations and speculative claims. 0 = fully hallucinated, 1 = perfectly grounded.
2. intent_fit: Does the captured type + title match what the user's request is actually about? 0 = unrelated, 1 = clearly aligned.
3. concept_accuracy: Are the concepts real entities present in the source (file names, function names, terms that appear)? 0 = invented, 1 = all grounded.
4. type_correctness: Is the type classification correct per this 6-type taxonomy?
   - bugfix: repaired something that was broken
   - decision: chose between architectural alternatives
   - feature: added a new capability
   - refactor: restructured without changing behavior
   - change: modified config/docs/misc
   - discovery: learned about existing code without modifying

Also set ceiling_flagged to true if richer turn context (more tool calls, user intent signal) would have changed your scoring — this marks observations whose score is bounded by missing context rather than LLM quality.

Respond with ONLY a JSON object, no prose:
{"fidelity": number, "intent_fit": number, "concept_accuracy": number, "type_correctness": number, "ceiling_flagged": boolean, "judge_notes": "one-sentence rationale"}`;

function buildPrompt(row) {
  const clip = (v, n) => (v == null ? '(null)' : String(v).length > n ? String(v).slice(0, n) + '…[truncated]' : String(v));
  return `USER_REQUEST:
${clip(row.user_prompt, 2000)}

PRIOR_ASSISTANT_MESSAGE:
${clip(row.prior_assistant_message, 1500)}

TOOL_NAME: ${row.tool_name ?? '(null)'}
TOOL_INPUT:
${clip(row.tool_input, 3500)}

TOOL_OUTPUT:
${clip(row.tool_output, 3500)}

CWD: ${row.cwd ?? '(null)'}

--- CAPTURED OBSERVATION ---
type: ${row.captured_type}
title: ${row.captured_title ?? '(null)'}
subtitle: ${row.captured_subtitle ?? '(null)'}
narrative: ${clip(row.captured_narrative, 1500)}
facts: ${clip(row.captured_facts, 1000)}
concepts: ${clip(row.captured_concepts, 500)}
why: ${row.captured_why ?? '(null)'}
alternatives_rejected: ${row.captured_alternatives_rejected ?? '(null)'}

Score now. JSON only.`;
}

async function callJudge({ baseUrl, apiKey, model }, userContent) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  // Minimal OpenAI-compatible body — avoid temperature/response_format because the
  // custom gpt-5.4 backend rejects them as unsupported. Deterministic output is not
  // required; we parse JSON from the raw content and tolerate mild variance.
  const body = {
    model,
    messages: [
      { role: 'system', content: JUDGE_INSTRUCTIONS },
      { role: 'user', content: userContent },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '(unreadable)');
    throw new Error(`Judge call failed: ${res.status} ${res.statusText} — ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Judge returned non-string content');
  return content;
}

function parseVerdict(text) {
  // Strip code fences and extract the first balanced JSON object from anywhere in
  // the response. Models without json_object mode often wrap the object in prose.
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let candidate = unfenced;
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidate = unfenced.slice(first, last + 1);
  }
  const obj = JSON.parse(candidate);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  return {
    fidelity: num(obj.fidelity),
    intent_fit: num(obj.intent_fit),
    concept_accuracy: num(obj.concept_accuracy),
    type_correctness: num(obj.type_correctness),
    ceiling_flagged: obj.ceiling_flagged === true ? 1 : 0,
    judge_notes: typeof obj.judge_notes === 'string' ? obj.judge_notes.slice(0, 500) : null,
  };
}

function insertScore(db, row, verdict, model) {
  db.prepare(`
    INSERT INTO observation_rubric_scores
      (observation_id, snapshot_id, judge_model, fidelity, intent_fit, concept_accuracy, type_correctness, ceiling_flagged, judge_notes, scored_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.observation_id,
    row.snapshot_id,
    model,
    verdict.fidelity,
    verdict.intent_fit,
    verdict.concept_accuracy,
    verdict.type_correctness,
    verdict.ceiling_flagged,
    verdict.judge_notes,
    Date.now(),
  );
}

function summarize(scores) {
  const axes = ['fidelity', 'intent_fit', 'concept_accuracy', 'type_correctness'];
  const lines = ['| axis | mean | stddev | count |', '|------|------|--------|-------|'];
  for (const axis of axes) {
    const values = scores.map(s => s[axis]).filter(v => typeof v === 'number');
    if (values.length === 0) {
      lines.push(`| ${axis} | — | — | 0 |`);
      continue;
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    lines.push(`| ${axis} | ${mean.toFixed(3)} | ${stddev.toFixed(3)} | ${values.length} |`);
  }
  const ceilingCount = scores.filter(s => s.ceiling_flagged).length;
  lines.push('');
  lines.push(`ceiling_flagged: ${ceilingCount}/${scores.length} (${scores.length ? (100 * ceilingCount / scores.length).toFixed(1) : '0'}%)`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = loadProviderConfig();

  const db = new Database(DB_PATH);
  const rows = sampleSnapshots(db, args);
  if (rows.length === 0) {
    console.log('No snapshots matched filters. Nothing to score.');
    console.log(`  since=${new Date(args.since).toISOString()}  project=${args.project ?? '(any)'}`);
    db.close();
    return;
  }

  console.log(`Scoring ${rows.length} snapshots via ${provider.model} @ ${provider.baseUrl}…`);

  const scores = [];
  let inserted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const verdict = parseVerdict(await callJudge(provider, buildPrompt(row)));
      insertScore(db, row, verdict, provider.model);
      scores.push(verdict);
      inserted++;
      process.stdout.write('.');
    } catch (error) {
      failed++;
      process.stdout.write('x');
      // Print first failure fully for diagnostics, swallow the rest.
      if (failed === 1) {
        console.error(`\n[rubric-runner] First failure on snapshot ${row.snapshot_id}:`, error.message);
      }
    }
  }
  process.stdout.write('\n');

  db.close();

  console.log(`\nInserted ${inserted} rubric scores. Failed: ${failed}.`);
  console.log('\n' + summarize(scores));
}

main().catch(err => {
  console.error('rubric-runner fatal:', err);
  process.exit(1);
});
