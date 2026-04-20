#!/usr/bin/env bun
/**
 * POC: Observation Context Ablation
 *
 * H1 from the 04-17 code review: CustomOpenAIAgent calls `buildObservationPrompt(obs)`
 * without `{ userRequest, priorAssistantMessage }`, while SDKAgent and OpenRouterAgent
 * pass both fields. Adding them costs prompt tokens — this POC validates whether the
 * quality gain justifies the cost.
 *
 * Design: paired ablation. For each sampled observation_capture_snapshot, regenerate
 * the observation twice via the custom provider:
 *   - baseline: buildObservationPrompt-equivalent with userRequest="(not available)"
 *               and priorAssistantMessage="(not available)"  (current CustomOpenAIAgent)
 *   - treatment: same prompt but with real snapshot.user_prompt and
 *                snapshot.prior_assistant_message rendered in their XML slots
 *
 * Both variants are judged via the same rubric-runner prompt (fidelity, intent_fit,
 * concept_accuracy, type_correctness, ceiling_flagged). Token usage from data.usage
 * is captured for cost delta. Results persist in `observation_context_ablation`.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');
const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const DEFAULT_SINCE = Date.now() - 48 * 3600 * 1000;
const CALL_DELAY_MS = 1500;

const DEFAULT_INTENT_THRESHOLD = 0.15;
const DEFAULT_COST_MULTIPLIER = 1.5;

function parseArgs(argv) {
  const args = {
    sample: 20,
    project: null,
    since: DEFAULT_SINCE,
    intentThreshold: DEFAULT_INTENT_THRESHOLD,
    costMultiplier: DEFAULT_COST_MULTIPLIER,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--since') args.since = parseInt(argv[++i], 10);
    else if (a === '--intent-threshold') args.intentThreshold = parseFloat(argv[++i]);
    else if (a === '--cost-multiplier') args.costMultiplier = parseFloat(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: bun scripts/poc-observation-context-ablation.mjs [--sample N] [--project X] [--since epoch_ms] [--intent-threshold F] [--cost-multiplier F]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.sample) || args.sample <= 0) throw new Error(`--sample must be > 0 (got ${args.sample})`);
  if (!Number.isFinite(args.since)) throw new Error(`--since must be epoch ms`);
  return args;
}

function loadProviderConfig() {
  const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  const { CLAUDE_MEM_CUSTOM_BASE_URL: baseUrl, CLAUDE_MEM_CUSTOM_API_KEY: apiKey, CLAUDE_MEM_CUSTOM_MODEL: model } = s;
  if (!baseUrl || !apiKey || !model) throw new Error('Missing CLAUDE_MEM_CUSTOM_{BASE_URL,API_KEY,MODEL} in settings.json');
  return { baseUrl, apiKey, model };
}

function ensureAblationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_context_ablation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      snapshot_id INTEGER NOT NULL,
      observation_id INTEGER NOT NULL,
      judge_model TEXT NOT NULL,
      baseline_parse_ok INTEGER,
      baseline_prompt_tokens INTEGER,
      baseline_completion_tokens INTEGER,
      baseline_total_tokens INTEGER,
      baseline_fidelity REAL,
      baseline_intent_fit REAL,
      baseline_concept_accuracy REAL,
      baseline_type_correctness REAL,
      baseline_ceiling_flagged INTEGER,
      baseline_judge_notes TEXT,
      treatment_parse_ok INTEGER,
      treatment_prompt_tokens INTEGER,
      treatment_completion_tokens INTEGER,
      treatment_total_tokens INTEGER,
      treatment_fidelity REAL,
      treatment_intent_fit REAL,
      treatment_concept_accuracy REAL,
      treatment_type_correctness REAL,
      treatment_ceiling_flagged INTEGER,
      treatment_judge_notes TEXT,
      scored_at_epoch INTEGER NOT NULL
    )
  `);
}

function sampleSnapshots(db, { sample, project, since }) {
  const params = [since];
  let where = 's.created_at_epoch > ?';
  if (project) { where += ' AND o.project = ?'; params.push(project); }
  params.push(sample);
  const sql = `
    SELECT
      s.id AS snapshot_id, s.observation_id,
      s.user_prompt, s.prior_assistant_message,
      s.tool_name, s.tool_input, s.tool_output, s.cwd,
      o.project
    FROM observation_capture_snapshots s
    JOIN observations o ON o.id = s.observation_id
    WHERE ${where}
      AND s.user_prompt IS NOT NULL
      AND LENGTH(s.user_prompt) > 10
    ORDER BY RANDOM()
    LIMIT ?
  `;
  return db.prepare(sql).all(...params);
}

// Mirrors src/sdk/prompts.ts buildObservationPrompt (lines 156-199). The only
// fields that differ between baseline and treatment are <user_request> and
// <prior_assistant_message>; everything else is byte-identical.
function escapeXml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function truncate(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + '…(truncated)';
}
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
];
function redactSecrets(t) {
  let out = String(t);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}
function renderTurnContextField(raw, max) {
  if (raw == null || raw === '') return '(not available)';
  return escapeXml(truncate(redactSecrets(raw), max));
}

function buildObservationPromptLike(snap, withContext) {
  const userReq = withContext ? renderTurnContextField(snap.user_prompt, 500) : '(not available)';
  const priorAsst = withContext ? renderTurnContextField(snap.prior_assistant_message, 300) : '(not available)';

  let toolInput, toolOutput;
  try { toolInput = JSON.parse(snap.tool_input); } catch { toolInput = snap.tool_input; }
  try { toolOutput = JSON.parse(snap.tool_output); } catch { toolOutput = snap.tool_output; }

  const cwdBlock = snap.cwd ? `\n  <working_directory>${snap.cwd}</working_directory>` : '';
  return `<observed_from_primary_session>
  <user_request>${userReq}</user_request>
  <prior_assistant_message>${priorAsst}</prior_assistant_message>
  <what_happened>${snap.tool_name}</what_happened>
  <occurred_at>${new Date().toISOString()}</occurred_at>${cwdBlock}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>
</observed_from_primary_session>

Return either one or more <observation>...</observation> blocks, or an empty response if this tool use should be skipped.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.
Never reply with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Non-XML text is discarded.`;
}

// Both arms get this identical system prompt. The ablation is purely on the user
// message — so any fairness concern about init context affects both arms equally.
const SYSTEM_PROMPT = `You are a memory observer recording durable observations from a developer's tool usage. For each <observed_from_primary_session> block you receive, output zero or more <observation>...</observation> blocks in this exact schema:

<observation>
  <type>[ bugfix | decision | feature | refactor | change | discovery ]</type>
  <title>short title</title>
  <subtitle>one-sentence context</subtitle>
  <facts>
    <fact>concrete, grounded fact from the tool call</fact>
  </facts>
  <narrative>one or two sentences explaining what happened and why it matters</narrative>
  <why>why this choice was made (or null if unclear)</why>
  <alternatives_rejected>what was considered and dropped (or null)</alternatives_rejected>
  <concepts>
    <concept>how-it-works</concept>
  </concepts>
</observation>

Rules:
- Stay grounded in the tool_input/tool_output. No speculation.
- If the tool call is trivial (read-only exploration with no durable finding), return an empty response.
- NEVER wrap output in code fences. NEVER explain in prose. Output ONLY <observation> blocks or empty.
- Concepts are short lowercase hyphenated tokens.`;

async function callProvider(provider, userContent, retries = 3) {
  let delay = 3000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (res.status === 429 && attempt < retries) {
      process.stdout.write(` [429:${Math.round(delay / 1000)}s]`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '(unreadable)');
      throw new Error(`Provider call failed: ${res.status} ${res.statusText} — ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? '';
    const usage = json?.usage ?? {};
    return {
      content: String(content),
      prompt_tokens: Number(usage.prompt_tokens ?? 0),
      completion_tokens: Number(usage.completion_tokens ?? 0),
      total_tokens: Number(usage.total_tokens ?? 0),
    };
  }
  throw new Error('Provider call exhausted retries');
}

// Minimal observation parser — mirrors src/sdk/parser.ts (non-greedy regex per field).
function extractField(body, tag) {
  const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}
function extractArray(body, outer, inner) {
  const outerM = body.match(new RegExp(`<${outer}>([\\s\\S]*?)</${outer}>`, 'i'));
  if (!outerM) return [];
  const innerRe = new RegExp(`<${inner}>([\\s\\S]*?)</${inner}>`, 'gi');
  const items = [];
  let m;
  while ((m = innerRe.exec(outerM[1])) !== null) items.push(m[1].trim());
  return items;
}
function parseFirstObservation(text) {
  const m = text.match(/<observation>([\s\S]*?)<\/observation>/);
  if (!m) return null;
  const body = m[1];
  return {
    type: extractField(body, 'type'),
    title: extractField(body, 'title'),
    subtitle: extractField(body, 'subtitle'),
    narrative: extractField(body, 'narrative'),
    facts: extractArray(body, 'facts', 'fact'),
    concepts: extractArray(body, 'concepts', 'concept'),
    why: extractField(body, 'why'),
    alternatives_rejected: extractField(body, 'alternatives_rejected'),
  };
}

// Judge instructions copied verbatim from scripts/rubric-runner.mjs so scores are
// directly comparable with prior rubric runs.
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

Also set ceiling_flagged to true if richer turn context (more tool calls, user intent signal) would have changed your scoring.

Respond with ONLY a JSON object, no prose:
{"fidelity": number, "intent_fit": number, "concept_accuracy": number, "type_correctness": number, "ceiling_flagged": boolean, "judge_notes": "one-sentence rationale"}`;

function buildJudgePrompt(snap, captured) {
  const clip = (v, n) => (v == null ? '(null)' : String(v).length > n ? String(v).slice(0, n) + '…[truncated]' : String(v));
  return `USER_REQUEST:
${clip(snap.user_prompt, 2000)}

PRIOR_ASSISTANT_MESSAGE:
${clip(snap.prior_assistant_message, 1500)}

TOOL_NAME: ${snap.tool_name ?? '(null)'}
TOOL_INPUT:
${clip(snap.tool_input, 3500)}

TOOL_OUTPUT:
${clip(snap.tool_output, 3500)}

CWD: ${snap.cwd ?? '(null)'}

--- CAPTURED OBSERVATION ---
type: ${captured?.type ?? '(null)'}
title: ${captured?.title ?? '(null)'}
subtitle: ${captured?.subtitle ?? '(null)'}
narrative: ${clip(captured?.narrative, 1500)}
facts: ${clip(JSON.stringify(captured?.facts ?? []), 1000)}
concepts: ${clip(JSON.stringify(captured?.concepts ?? []), 500)}
why: ${captured?.why ?? '(null)'}
alternatives_rejected: ${captured?.alternatives_rejected ?? '(null)'}

Score now. JSON only.`;
}

async function callJudge(provider, userContent, retries = 3) {
  let delay = 3000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: JUDGE_INSTRUCTIONS },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (res.status === 429 && attempt < retries) {
      process.stdout.write(` [J429:${Math.round(delay / 1000)}s]`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '(unreadable)');
      throw new Error(`Judge failed: ${res.status} — ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    return String(json?.choices?.[0]?.message?.content ?? '');
  }
  throw new Error('Judge call exhausted retries');
}

function parseVerdict(text) {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let candidate = unfenced;
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first !== -1 && last > first) candidate = unfenced.slice(first, last + 1);
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

function mean(arr) {
  const xs = arr.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function median(arr) {
  const xs = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}
const fmt = (n, d = 3) => (n == null ? '—' : Number(n).toFixed(d));
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(1) + '%');
const sgn = (n, d = 3) => (n == null ? '—' : (n >= 0 ? '+' : '') + fmt(n, d));

function persistRow(db, runId, model, snap, baselineUsage, treatmentUsage, baselineParsed, treatmentParsed, baselineVerdict, treatmentVerdict) {
  db.prepare(`
    INSERT INTO observation_context_ablation (
      run_id, snapshot_id, observation_id, judge_model,
      baseline_parse_ok, baseline_prompt_tokens, baseline_completion_tokens, baseline_total_tokens,
      baseline_fidelity, baseline_intent_fit, baseline_concept_accuracy, baseline_type_correctness,
      baseline_ceiling_flagged, baseline_judge_notes,
      treatment_parse_ok, treatment_prompt_tokens, treatment_completion_tokens, treatment_total_tokens,
      treatment_fidelity, treatment_intent_fit, treatment_concept_accuracy, treatment_type_correctness,
      treatment_ceiling_flagged, treatment_judge_notes,
      scored_at_epoch
    ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,?, ?)
  `).run(
    runId, snap.snapshot_id, snap.observation_id, model,
    baselineParsed ? 1 : 0,
    baselineUsage?.prompt_tokens ?? null,
    baselineUsage?.completion_tokens ?? null,
    baselineUsage?.total_tokens ?? null,
    baselineVerdict?.fidelity ?? null,
    baselineVerdict?.intent_fit ?? null,
    baselineVerdict?.concept_accuracy ?? null,
    baselineVerdict?.type_correctness ?? null,
    baselineVerdict?.ceiling_flagged ?? null,
    baselineVerdict?.judge_notes ?? null,
    treatmentParsed ? 1 : 0,
    treatmentUsage?.prompt_tokens ?? null,
    treatmentUsage?.completion_tokens ?? null,
    treatmentUsage?.total_tokens ?? null,
    treatmentVerdict?.fidelity ?? null,
    treatmentVerdict?.intent_fit ?? null,
    treatmentVerdict?.concept_accuracy ?? null,
    treatmentVerdict?.type_correctness ?? null,
    treatmentVerdict?.ceiling_flagged ?? null,
    treatmentVerdict?.judge_notes ?? null,
    Date.now(),
  );
}

function printReport(rows, args) {
  console.log('\n## Results\n');

  const parsedBoth = rows.filter((r) => r.baselineVerdict && r.treatmentVerdict);
  const baselineParseRate = rows.filter((r) => r.baselineParsed).length / Math.max(1, rows.length);
  const treatmentParseRate = rows.filter((r) => r.treatmentParsed).length / Math.max(1, rows.length);

  console.log(`- Parse success: baseline ${pct(baselineParseRate)} · treatment ${pct(treatmentParseRate)}`);
  console.log(`- Both-judged rows: ${parsedBoth.length}/${rows.length}\n`);

  const axes = ['fidelity', 'intent_fit', 'concept_accuracy', 'type_correctness'];
  console.log('### Score comparison (paired rows only)\n');
  console.log('| Axis | Baseline mean | Treatment mean | Δ mean | Baseline median | Treatment median | Δ median |');
  console.log('|---|---|---|---|---|---|---|');
  for (const axis of axes) {
    const bVals = parsedBoth.map((r) => r.baselineVerdict[axis]);
    const tVals = parsedBoth.map((r) => r.treatmentVerdict[axis]);
    const bM = mean(bVals), tM = mean(tVals);
    const bMd = median(bVals), tMd = median(tVals);
    console.log(`| ${axis} | ${fmt(bM)} | ${fmt(tM)} | ${sgn(bM != null && tM != null ? tM - bM : null)} | ${fmt(bMd)} | ${fmt(tMd)} | ${sgn(bMd != null && tMd != null ? tMd - bMd : null)} |`);
  }

  const bCeil = mean(parsedBoth.map((r) => r.baselineVerdict.ceiling_flagged));
  const tCeil = mean(parsedBoth.map((r) => r.treatmentVerdict.ceiling_flagged));
  console.log(`\n- Ceiling-flagged rate: baseline ${pct(bCeil)} · treatment ${pct(tCeil)}\n`);

  console.log('### Win / tie / loss (paired, per axis)\n');
  console.log('| Axis | Treatment wins | Ties | Baseline wins |');
  console.log('|---|---|---|---|');
  for (const axis of axes) {
    let wins = 0, ties = 0, losses = 0;
    for (const r of parsedBoth) {
      const d = r.treatmentVerdict[axis] - r.baselineVerdict[axis];
      if (d > 0.01) wins++;
      else if (d < -0.01) losses++;
      else ties++;
    }
    console.log(`| ${axis} | ${wins} | ${ties} | ${losses} |`);
  }

  const bTok = mean(rows.map((r) => r.baselineUsage?.prompt_tokens));
  const tTok = mean(rows.map((r) => r.treatmentUsage?.prompt_tokens));
  const tokDelta = bTok != null && tTok != null ? tTok - bTok : null;
  const tokRatio = bTok ? tTok / bTok : null;

  console.log(`\n### Token cost\n`);
  console.log(`- Mean prompt tokens: baseline ${fmt(bTok, 1)} · treatment ${fmt(tTok, 1)}`);
  console.log(`- Δ per observation: ${tokDelta != null ? '+' + fmt(tokDelta, 1) + ' tokens' : '—'}`);
  console.log(`- Cost ratio: ${fmt(tokRatio)}× baseline`);

  const intentDelta = (() => {
    const bM = mean(parsedBoth.map((r) => r.baselineVerdict.intent_fit));
    const tM = mean(parsedBoth.map((r) => r.treatmentVerdict.intent_fit));
    return bM != null && tM != null ? tM - bM : null;
  })();
  const fidelityDelta = (() => {
    const bM = mean(parsedBoth.map((r) => r.baselineVerdict.fidelity));
    const tM = mean(parsedBoth.map((r) => r.treatmentVerdict.fidelity));
    return bM != null && tM != null ? tM - bM : null;
  })();

  const intentOK = intentDelta != null && intentDelta >= args.intentThreshold;
  const fidelityOK = fidelityDelta != null && fidelityDelta >= 0;
  const costOK = tokRatio != null && tokRatio <= args.costMultiplier;

  console.log(`\n### Verdict\n`);
  console.log(`- intent_fit Δ = ${sgn(intentDelta)} (need ≥ +${args.intentThreshold}) → ${intentOK ? '✅' : '❌'}`);
  console.log(`- fidelity Δ = ${sgn(fidelityDelta)} (need ≥ 0) → ${fidelityOK ? '✅' : '❌'}`);
  console.log(`- cost ratio = ${fmt(tokRatio)}× (need ≤ ${args.costMultiplier}×) → ${costOK ? '✅' : '❌'}`);
  console.log('');
  if (intentOK && fidelityOK && costOK) {
    console.log(`**GO**: apply H1 fix (pass \`{ userRequest, priorAssistantMessage }\` in CustomOpenAIAgent.ts:140).`);
  } else {
    console.log(`**NO-GO**: keep current minimal prompt. Log this result in memory; close H1.`);
  }
}

async function processSnapshot(snap, provider) {
  const basePrompt = buildObservationPromptLike(snap, false);
  const treatPrompt = buildObservationPromptLike(snap, true);

  const baselineUsage = await callProvider(provider, basePrompt);
  const baselineParsed = parseFirstObservation(baselineUsage.content);
  await new Promise((r) => setTimeout(r, CALL_DELAY_MS));

  const treatmentUsage = await callProvider(provider, treatPrompt);
  const treatmentParsed = parseFirstObservation(treatmentUsage.content);
  await new Promise((r) => setTimeout(r, CALL_DELAY_MS));

  let baselineVerdict = null;
  if (baselineParsed) {
    const txt = await callJudge(provider, buildJudgePrompt(snap, baselineParsed));
    baselineVerdict = parseVerdict(txt);
    await new Promise((r) => setTimeout(r, CALL_DELAY_MS));
  }
  let treatmentVerdict = null;
  if (treatmentParsed) {
    const txt = await callJudge(provider, buildJudgePrompt(snap, treatmentParsed));
    treatmentVerdict = parseVerdict(txt);
    await new Promise((r) => setTimeout(r, CALL_DELAY_MS));
  }

  return { baselineUsage, treatmentUsage, baselineParsed, treatmentParsed, baselineVerdict, treatmentVerdict };
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = loadProviderConfig();
  const db = new Database(DB_PATH);
  ensureAblationTable(db);

  const snapshots = sampleSnapshots(db, args);
  if (snapshots.length === 0) {
    console.log('No snapshots matched. Lower --since or widen --project.');
    process.exit(1);
  }

  const runId = `ctx-abl-${Date.now()}`;
  console.log(`# Observation Context Ablation POC\n`);
  console.log(`- run_id: \`${runId}\``);
  console.log(`- judge model: \`${provider.model}\``);
  console.log(`- sample: ${snapshots.length} snapshots (requested ${args.sample}, since ${new Date(args.since).toISOString()})`);
  console.log(`- project filter: ${args.project ?? '(none)'}`);
  console.log(`- verdict thresholds: intent Δ ≥ +${args.intentThreshold}, cost ≤ ${args.costMultiplier}× baseline\n`);

  const rows = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    process.stdout.write(`[${i + 1}/${snapshots.length}] obs=${snap.observation_id}`);

    let result;
    try {
      result = await processSnapshot(snap, provider);
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
      continue;
    }

    const { baselineUsage, treatmentUsage, baselineParsed, treatmentParsed, baselineVerdict, treatmentVerdict } = result;
    process.stdout.write(
      ` base=${baselineParsed ? 'ok' : 'parse-fail'}/${baselineVerdict ? `f=${fmt(baselineVerdict.fidelity, 2)}` : 'nojudge'}` +
      ` treat=${treatmentParsed ? 'ok' : 'parse-fail'}/${treatmentVerdict ? `f=${fmt(treatmentVerdict.fidelity, 2)}` : 'nojudge'}` +
      ` [+${treatmentUsage.prompt_tokens - baselineUsage.prompt_tokens}t]\n`,
    );

    persistRow(db, runId, provider.model, snap, baselineUsage, treatmentUsage, baselineParsed, treatmentParsed, baselineVerdict, treatmentVerdict);
    rows.push({ snap, ...result });
  }

  printReport(rows, args);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
