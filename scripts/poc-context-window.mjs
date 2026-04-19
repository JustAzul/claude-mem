#!/usr/bin/env bun
/**
 * POC: Context Window Observer
 *
 * Tests whether giving the observer LLM a window of N raw conversation turns
 * + a timeline of prior observations about the same files improves observation
 * quality (fidelity, intent_fit) vs the current single-turn context.
 *
 * Does NOT modify any production code or write to observation_rubric_scores.
 * Outputs a side-by-side markdown report to scripts/poc-context-window-report.md.
 *
 * Usage:
 *   bun scripts/poc-context-window.mjs
 *   bun scripts/poc-context-window.mjs --sample 10
 *   bun scripts/poc-context-window.mjs --dry-run   (skip LLM calls, show context only)
 */

import { Database } from 'bun:sqlite';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const REPORT_PATH = join(import.meta.dir, 'poc-context-window-report.md');

const WINDOW_TURNS = 3;        // N conversation turns to include
const PRIOR_OBS_LIMIT = 3;     // K prior observations about same files
const MAX_TURN_CHARS = 400;    // max chars per turn in window
const MAX_OBS_CHARS = 120;     // max chars per prior observation title

// ─── Provider ────────────────────────────────────────────────────────────────

function loadProviderConfig() {
  const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  const baseUrl = s.CLAUDE_MEM_CUSTOM_BASE_URL;
  const apiKey = s.CLAUDE_MEM_CUSTOM_API_KEY;
  const model = s.CLAUDE_MEM_CUSTOM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('Missing CLAUDE_MEM_CUSTOM_{BASE_URL,API_KEY,MODEL} in settings.json');
  }
  return { baseUrl, apiKey, model };
}

async function callLLM({ baseUrl, apiKey, model }, systemPrompt, userContent) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
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
    throw new Error(`LLM call failed: ${res.status} — ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  const usage = json?.usage ?? {};
  if (typeof content !== 'string') throw new Error('LLM returned non-string content');
  return { content, inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
}

async function callLLMWithRetry(provider, systemPrompt, userContent, maxRetries = 4) {
  let delay = 5000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLM(provider, systemPrompt, userContent);
    } catch (err) {
      if (attempt === maxRetries || !err.message.includes('429')) throw err;
      process.stdout.write(`  [429 retry in ${delay/1000}s]`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
    }
  }
}

// ─── JSONL conversation window ─────────────────────────────────────────────

function findJsonlPath(contentSessionId) {
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, proj, contentSessionId + '.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Extract the last N user+assistant turns before the tool call matching
 * toolName + toolInput prefix. Falls back to last N turns if tool call
 * not found (e.g. session file doesn't have matching entry).
 */
// Patterns that indicate system/command content, not genuine user intent
const SKIP_USER_PATTERNS = [
  /^<command-message>/,
  /^<command-name>/,
  /^<task-notification>/,
  /^Base directory for this skill:/,
  /^<system-reminder>/,
  /^<local-command-caveat>/,
  /^\s*<[a-z-]+>/,   // starts with XML tag (system injections)
];

function isSubstantiveUserTurn(text) {
  if (!text || text.trim().length < 15) return false;
  return !SKIP_USER_PATTERNS.some(re => re.test(text.trim()));
}

function isSubstantiveAssistantTurn(text) {
  // Skip very short acknowledgments and pure tool-call setups
  return text && text.trim().length >= 80;
}

function extractConversationWindow(jsonlPath, toolName, toolInput, n = WINDOW_TURNS) {
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  // Normalize: re-stringify the DB value so key/whitespace format matches block.input
  let toolInputPrefix = '';
  if (typeof toolInput === 'string') {
    try {
      toolInputPrefix = JSON.stringify(JSON.parse(toolInput)).slice(0, 80);
    } catch {
      toolInputPrefix = toolInput.slice(0, 80);
    }
  }

  // Parse all turns in order
  const turns = [];
  let toolCallIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }

    if (obj.type === 'user') {
      const content = extractMessageText(obj.message?.content);
      if (isSubstantiveUserTurn(content)) {
        turns.push({ role: 'user', text: content, lineIndex: i });
      }
    } else if (obj.type === 'assistant') {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        // Check if this assistant turn contains the target tool call
        const hasTargetTool = content.some(block =>
          block.type === 'tool_use' &&
          block.name === toolName &&
          JSON.stringify(block.input ?? {}).slice(0, 80) === toolInputPrefix
        );
        if (hasTargetTool && toolCallIndex === -1) {
          toolCallIndex = turns.length;
        }
        const text = content
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('\n')
          .trim();
        if (isSubstantiveAssistantTurn(text)) {
          turns.push({ role: 'assistant', text, lineIndex: i });
        }
      }
    }
  }

  // Return empty window if anchor not found — wrong-epoch fallback causes hallucinations
  if (toolCallIndex === -1) return [];
  const cutoff = toolCallIndex;
  const window = turns.slice(Math.max(0, cutoff - n), cutoff);

  return window.map(t => {
    const label = t.role === 'user' ? '[user]' : '[assistant]';
    const text = t.text.length > MAX_TURN_CHARS
      ? t.text.slice(0, MAX_TURN_CHARS) + '…'
      : t.text;
    return `${label} ${text}`;
  });
}

function extractMessageText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}

// ─── Prior observations timeline ──────────────────────────────────────────

function buildPriorObservationsTimeline(db, filesRead, filesModified, beforeEpoch, limit = PRIOR_OBS_LIMIT) {
  const files = [
    ...JSON.parse(filesRead || '[]'),
    ...JSON.parse(filesModified || '[]'),
  ].filter(Boolean);

  if (files.length === 0 || limit === 0) return [];

  const fileConditions = files.map(() =>
    `(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR
      EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))`
  ).join(' OR ');

  const fileParams = files.flatMap(f => [`%${f}%`, `%${f}%`]);

  const rows = db.prepare(`
    SELECT o.id, o.type, o.title, o.created_at_epoch
    FROM observations o
    WHERE (${fileConditions})
      AND o.created_at_epoch < ?
    ORDER BY o.created_at_epoch ASC
    LIMIT ?
  `).all(...fileParams, beforeEpoch, limit);

  return rows.map(r => {
    const time = new Date(r.created_at_epoch).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const title = (r.title ?? '').slice(0, MAX_OBS_CHARS);
    return `${time} [${r.type}] ${title}`;
  });
}

// ─── Prompt builders ──────────────────────────────────────────────────────

const OBSERVER_SYSTEM_PROMPT = `You are a memory observer for a developer's AI assistant session. Your job is to generate a structured observation about what just happened based on the tool usage and conversation context provided.

You may receive a PRIOR_OBSERVATIONS_ON_SAME_FILES section listing earlier observations about the same files. Use this chronological timeline to:
- Infer the MOTIVATION (why field): what problem or goal prompted this action given what was done before?
- Infer ALTERNATIVES_REJECTED: what prior approach did this supersede or deviate from?
- Ensure your narrative makes sense in the context of the session's progression.

IMPORTANT GUARDS:
- Prior observations describe what was found/done BEFORE this action. A prior "found nothing" result does NOT mean the current action also found nothing — trust tool_output over prior_obs.
- If the user_request describes a high-level task (e.g., "load skill", "make a plan") but the tool_input/output shows a low-level operation (timestamp write, count query), describe ONLY the low-level operation. Do not bridge the gap with speculation.
- Never let prior_obs override what tool_output actually shows.

Generate ONE <observation> block with these fields:
- type: one of bugfix | decision | feature | refactor | change | discovery
  * bugfix: repaired something broken; decision: chose between alternatives; feature: new capability; refactor: restructured without behavior change; change: config/docs/misc; discovery: learned about existing code without modifying
- title: concise title (max 80 chars)
- subtitle: one-line elaboration (max 120 chars)
- narrative: 2-3 sentences explaining what happened and why it matters
- facts: JSON array of 2-5 concrete factual strings (file paths, method names, specific values present in tool_input/output)
- concepts: JSON array of 3-6 concept tags grounded in the actual content (e.g. "pattern", "how-it-works", "problem-solution", "gotcha", "what-changed", "trade-off")
- why: one sentence explaining the motivation behind this specific tool call — must be grounded in the tool_input/output or prior_obs. Do NOT speculate from the user_request if the tool output doesn't support it. Omit if unclear.
- alternatives_rejected: one sentence about what was NOT done and why — only if directly evidenced in tool_output or prior_obs. Omit if speculative.

Output ONLY the XML block, nothing else:
<observation>
<type>...</type>
<title>...</title>
<subtitle>...</subtitle>
<narrative>...</narrative>
<facts>["...", "..."]</facts>
<concepts>["...", "..."]</concepts>
<why>...</why>
<alternatives_rejected>...</alternatives_rejected>
</observation>`;

function clip(v, n) {
  if (v == null) return '(null)';
  const s = String(v);
  return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
}

/** Baseline prompt — mirrors rubric-runner.mjs buildPrompt */
function buildBaselinePrompt(row) {
  return `USER_REQUEST:
${clip(row.user_prompt, 500)}

PRIOR_ASSISTANT_MESSAGE:
${clip(row.prior_assistant_message, 300)}

TOOL_NAME: ${row.tool_name ?? '(null)'}
TOOL_INPUT:
${clip(row.tool_input, 3500)}

TOOL_OUTPUT:
${clip(row.tool_output, 3500)}`;
}

/** Extended prompt — adds conversation window + prior observations */
function buildExtendedPrompt(row, turnWindow, priorObsTimeline) {
  const base = buildBaselinePrompt(row);
  const windowSection = turnWindow.length > 0
    ? `\nCONVERSATION_WINDOW (last ${turnWindow.length} turns before this tool call):\n${turnWindow.join('\n')}`
    : '\nCONVERSATION_WINDOW: (not available)';
  const timelineSection = priorObsTimeline.length > 0
    ? `\nPRIOR_OBSERVATIONS_ON_SAME_FILES (chronological):\n${priorObsTimeline.join('\n')}`
    : '\nPRIOR_OBSERVATIONS_ON_SAME_FILES: (none found)';
  return base + windowSection + timelineSection;
}

// ─── Observation parser ────────────────────────────────────────────────────

function parseObservation(text) {
  const match = text.match(/<observation>([\s\S]*?)<\/observation>/i);
  if (!match) return null;
  const inner = match[1];
  const get = (tag) => {
    const m = inner.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  return {
    type: get('type'),
    title: get('title'),
    subtitle: get('subtitle'),
    narrative: get('narrative'),
    facts: get('facts'),
    concepts: get('concepts'),
    why: get('why'),
    alternatives_rejected: get('alternatives_rejected'),
  };
}

// ─── Rubric judge (from rubric-runner.mjs) ───────────────────────────────

const JUDGE_INSTRUCTIONS = `You are an auditor scoring the quality of an AI-generated "observation" that was captured from a developer's tool usage. Score four axes on a continuous 0.0–1.0 scale:

1. fidelity: Do the narrative and facts accurately reflect what the tool_input and tool_output show? 0 = hallucinated, 1 = perfectly grounded.
2. intent_fit: Does the type + title match what the user's request is about? 0 = unrelated, 1 = clearly aligned.
3. concept_accuracy: Are the concepts real entities present in the source? 0 = invented, 1 = all grounded.
4. type_correctness: Is the type classification correct? (bugfix|decision|feature|refactor|change|discovery)

Also set ceiling_flagged to true if richer turn context would have changed your scoring.

Respond with ONLY JSON:
{"fidelity": number, "intent_fit": number, "concept_accuracy": number, "type_correctness": number, "ceiling_flagged": boolean, "judge_notes": "one-sentence rationale"}`;

function buildJudgePrompt(row, obs) {
  return `USER_REQUEST:
${clip(row.user_prompt, 2000)}

PRIOR_ASSISTANT_MESSAGE:
${clip(row.prior_assistant_message, 1500)}

TOOL_NAME: ${row.tool_name ?? '(null)'}
TOOL_INPUT:
${clip(row.tool_input, 3500)}

TOOL_OUTPUT:
${clip(row.tool_output, 3500)}

--- CAPTURED OBSERVATION ---
type: ${obs.type ?? '(null)'}
title: ${obs.title ?? '(null)'}
subtitle: ${obs.subtitle ?? '(null)'}
narrative: ${clip(obs.narrative, 1500)}
facts: ${clip(obs.facts, 1000)}
concepts: ${clip(obs.concepts, 500)}
why: ${obs.why ?? '(null)'}
alternatives_rejected: ${obs.alternatives_rejected ?? '(null)'}

Score now. JSON only.`;
}

function parseVerdict(text) {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  const candidate = first !== -1 && last > first ? unfenced.slice(first, last + 1) : unfenced;
  const obj = JSON.parse(candidate);
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  return {
    fidelity: num(obj.fidelity),
    intent_fit: num(obj.intent_fit),
    concept_accuracy: num(obj.concept_accuracy),
    type_correctness: num(obj.type_correctness),
    ceiling_flagged: obj.ceiling_flagged === true ? 1 : 0,
    judge_notes: typeof obj.judge_notes === 'string' ? obj.judge_notes.slice(0, 500) : null,
  };
}

// ─── Sample selection ─────────────────────────────────────────────────────

function loadSamples(db, limit) {
  const rows = db.prepare(`
    SELECT
      r.observation_id, r.snapshot_id,
      r.fidelity AS old_fidelity, r.intent_fit AS old_intent_fit,
      r.concept_accuracy AS old_concept_accuracy, r.type_correctness AS old_type_correctness,
      r.ceiling_flagged AS old_ceiling_flagged, r.judge_notes AS old_judge_notes,
      s.content_session_id, s.tool_name, s.tool_input, s.tool_output,
      s.user_prompt, s.prior_assistant_message, s.cwd,
      s.captured_type, s.captured_title, s.captured_narrative,
      s.captured_why, s.captured_alternatives_rejected,
      o.type AS obs_type, o.title AS obs_title, o.files_read, o.files_modified,
      o.created_at_epoch
    FROM observation_rubric_scores r
    JOIN observation_capture_snapshots s ON r.snapshot_id = s.id
    JOIN observations o ON r.observation_id = o.id
    WHERE s.content_session_id IS NOT NULL AND s.tool_input IS NOT NULL
    ORDER BY r.fidelity ASC
    LIMIT ?
  `).all(limit);

  // Filter to those with JSONL on disk
  return rows.filter(row => !!findJsonlPath(row.content_session_id));
}

// ─── Report builder ───────────────────────────────────────────────────────

function mean(arr) {
  const valid = arr.filter(v => typeof v === 'number');
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function buildReport(results) {
  const lines = ['# POC: Context Window Observer — Results\n'];
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Samples: ${results.length} | Window turns: ${WINDOW_TURNS} | Prior obs: ${PRIOR_OBS_LIMIT}\n`);

  // Summary table
  const oldFid = mean(results.map(r => r.old_fidelity));
  const newFid = mean(results.map(r => r.new_fidelity));
  const oldInt = mean(results.map(r => r.old_intent_fit));
  const newInt = mean(results.map(r => r.new_intent_fit));
  const oldTokens = mean(results.map(r => r.baseline_tokens));
  const newTokens = mean(results.map(r => r.extended_tokens));
  const oldCeiling = results.filter(r => r.old_ceiling_flagged).length;
  const newCeiling = results.filter(r => r.new_ceiling_flagged).length;

  const withWindow = results.filter(r => r.window_found);
  const noWindow = results.filter(r => !r.window_found);

  function delta(a, b) { return a != null && b != null ? (b - a >= 0 ? '+' : '') + (b - a).toFixed(3) : '—'; }

  lines.push('## Summary\n');
  lines.push('| metric | baseline | extended | delta |');
  lines.push('|--------|----------|----------|-------|');
  lines.push(`| fidelity (all ${results.length}) | ${oldFid?.toFixed(3) ?? '—'} | ${newFid?.toFixed(3) ?? '—'} | ${delta(oldFid, newFid)} |`);
  lines.push(`| fidelity (window found n=${withWindow.length}) | ${mean(withWindow.map(r => r.old_fidelity))?.toFixed(3) ?? '—'} | ${mean(withWindow.map(r => r.new_fidelity))?.toFixed(3) ?? '—'} | ${delta(mean(withWindow.map(r => r.old_fidelity)), mean(withWindow.map(r => r.new_fidelity)))} |`);
  lines.push(`| fidelity (no window n=${noWindow.length}) | ${mean(noWindow.map(r => r.old_fidelity))?.toFixed(3) ?? '—'} | ${mean(noWindow.map(r => r.new_fidelity))?.toFixed(3) ?? '—'} | ${delta(mean(noWindow.map(r => r.old_fidelity)), mean(noWindow.map(r => r.new_fidelity)))} |`);
  lines.push(`| intent_fit | ${oldInt?.toFixed(3) ?? '—'} | ${newInt?.toFixed(3) ?? '—'} | ${delta(oldInt, newInt)} |`);
  lines.push(`| ceiling_flagged | ${oldCeiling}/${results.length} | ${newCeiling}/${results.length} | ${newCeiling - oldCeiling} |`);
  lines.push(`| input_tokens (avg) | ${oldTokens?.toFixed(0) ?? '—'} | ${newTokens?.toFixed(0) ?? '—'} | ${newTokens != null && oldTokens != null ? ((newTokens / oldTokens - 1) * 100).toFixed(1) + '%' : '—'} |`);

  lines.push('\n---\n');
  lines.push('## Side-by-side\n');

  // Side-by-side: IDs + scores only — no content, titles, narratives, or tool data (PII guard)
  for (const r of results) {
    lines.push(`### obs#${r.observation_id} [${r.obs_type}]`);
    lines.push(`**Fidelity:** ${r.old_fidelity?.toFixed(2)} → ${r.new_fidelity?.toFixed(2)} | **Intent:** ${r.old_intent_fit?.toFixed(2)} → ${r.new_intent_fit?.toFixed(2)} | **Tokens:** ${r.baseline_tokens} → ${r.extended_tokens}`);
    lines.push(`**ceiling_flagged:** ${r.old_ceiling_flagged ? 'yes' : 'no'} → ${r.new_ceiling_flagged ? 'yes' : 'no'}`);
    if (r.turn_window_used?.length) {
      lines.push(`**Conversation window turns used:** ${r.turn_window_used.length}`);
    }
    if (r.prior_obs_used?.length) {
      lines.push(`**Prior obs IDs used:** ${r.prior_obs_used.length}`);
    }
    lines.push('\n---\n');
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const sampleArg = args.indexOf('--sample');
  const sampleLimit = sampleArg !== -1 ? parseInt(args[sampleArg + 1], 10) : 42;
  const dryRun = args.includes('--dry-run');
  const noWindow = args.includes('--no-window');
  const priorObsLimit = (() => {
    const idx = args.indexOf('--prior-obs');
    return idx !== -1 ? parseInt(args[idx + 1], 10) : PRIOR_OBS_LIMIT;
  })();

  const provider = loadProviderConfig();
  const db = new Database(DB_PATH);
  const samples = loadSamples(db, sampleLimit);

  console.log(`Loaded ${samples.length} samples (with JSONL + tool_input)`);
  console.log(`Provider: ${provider.model} @ ${provider.baseUrl}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no LLM calls)' : 'LIVE'} | window: ${noWindow ? 'OFF' : 'ON'} | prior_obs_limit: ${priorObsLimit}\n`);

  const results = [];

  for (let i = 0; i < samples.length; i++) {
    const row = samples[i];
    process.stdout.write(`[${i + 1}/${samples.length}] obs#${row.observation_id} (${row.obs_type})… `);

    try {
      // 1. Build conversation window from JSONL (skip if --no-window)
      const jsonlPath = noWindow ? null : findJsonlPath(row.content_session_id);
      const turnWindow = jsonlPath
        ? extractConversationWindow(jsonlPath, row.tool_name, row.tool_input)
        : [];

      // 2. Build prior observations timeline
      const priorObs = buildPriorObservationsTimeline(
        db, row.files_read, row.files_modified, row.created_at_epoch, priorObsLimit
      );

      // 3. Build prompts
      const baselinePrompt = buildBaselinePrompt(row);
      const extendedPrompt = buildExtendedPrompt(row, turnWindow, priorObs);

      if (dryRun) {
        console.log(`\n  window: ${turnWindow.length} turns, prior obs: ${priorObs.length}`);
        console.log(`  baseline prompt chars: ${baselinePrompt.length} → extended: ${extendedPrompt.length}`);
        results.push({
          observation_id: row.observation_id, obs_type: row.obs_type, obs_title: row.obs_title,
          old_fidelity: row.old_fidelity, old_intent_fit: row.old_intent_fit,
          old_ceiling_flagged: row.old_ceiling_flagged, old_judge_notes: row.old_judge_notes,
          new_fidelity: null, new_intent_fit: null, new_ceiling_flagged: null, new_judge_notes: null,
          baseline_tokens: baselinePrompt.length, extended_tokens: extendedPrompt.length,
          turn_window_used: turnWindow, prior_obs_used: priorObs,
          baseline_obs: { narrative: row.captured_narrative, why: row.captured_why, alternatives_rejected: row.captured_alternatives_rejected },
          new_obs: null,
        });
        continue;
      }

      // Rate-limit guard
      await new Promise(r => setTimeout(r, 3000));

      // 4. Generate new observation with extended context
      const { content: newObsRaw, inputTokens: extTokens } = await callLLMWithRetry(
        provider, OBSERVER_SYSTEM_PROMPT, extendedPrompt
      );
      const newObs = parseObservation(newObsRaw);

      // 5. Score new observation with rubric judge
      const judgePrompt = buildJudgePrompt(row, newObs ?? {});
      const { content: verdictRaw, inputTokens: baseTokens } = await callLLMWithRetry(
        provider, JUDGE_INSTRUCTIONS, judgePrompt
      );
      const verdict = parseVerdict(verdictRaw);
      const windowFound = turnWindow.length > 0;

      results.push({
        observation_id: row.observation_id, obs_type: row.obs_type, obs_title: row.obs_title,
        old_fidelity: row.old_fidelity, old_intent_fit: row.old_intent_fit,
        old_concept_accuracy: row.old_concept_accuracy, old_type_correctness: row.old_type_correctness,
        old_ceiling_flagged: row.old_ceiling_flagged, old_judge_notes: row.old_judge_notes,
        new_fidelity: verdict.fidelity, new_intent_fit: verdict.intent_fit,
        new_concept_accuracy: verdict.concept_accuracy, new_type_correctness: verdict.type_correctness,
        new_ceiling_flagged: verdict.ceiling_flagged, new_judge_notes: verdict.judge_notes,
        baseline_tokens: baseTokens, extended_tokens: extTokens,
        turn_window_used: turnWindow, prior_obs_used: priorObs, window_found: windowFound,
        baseline_obs: { narrative: row.captured_narrative, why: row.captured_why, alternatives_rejected: row.captured_alternatives_rejected },
        new_obs: newObs,
      });

      const marker = windowFound ? '✓' : '∅';
      process.stdout.write(`fid ${row.old_fidelity?.toFixed(2)} → ${verdict.fidelity?.toFixed(2)} [${marker}]\n`);
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message.slice(0, 80)}\n`);
    }
  }

  db.close();

  const report = buildReport(results);
  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(`\nReport written to: ${REPORT_PATH}`);

  // Quick summary to stdout
  const valid = results.filter(r => r.new_fidelity != null);
  if (valid.length > 0) {
    const oldF = mean(valid.map(r => r.old_fidelity));
    const newF = mean(valid.map(r => r.new_fidelity));
    console.log(`\nFidelity: ${oldF?.toFixed(3)} → ${newF?.toFixed(3)} (${valid.length} samples)`);
    console.log(`Budget check: target ≤+50% tokens — result: ${mean(valid.map(r => ((r.extended_tokens / r.baseline_tokens) - 1) * 100))?.toFixed(1)}% avg increase`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
