/**
 * POC: Injection Quality — Baseline vs Prior-Assistant Query
 *
 * Establishes empirical baseline for the current semantic injection system
 * and compares it to the hypothesis of using prior_assistant_message as query.
 *
 * For each eligible decision (N ≥ 50, diverse sessions):
 *   A. BASELINE: best obs found by user_prompt query (current system, no threshold)
 *   B. POC:      best obs found by prior_asst query   (hypothesis)
 *
 * Both are judged by an LLM for relevance given the assistant context.
 * Injection eligibility is reported separately at real thresholds.
 *
 * Judge verdict: RELEVANT / MARGINAL / NOT_RELEVANT
 *
 * PII guard: output report has IDs + verdicts only. LLM sees content at runtime.
 *
 * Usage: bun scripts/poc-injection-judge.mjs [--sample N] [--dry-run]
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');
const WORKER_URL = 'http://localhost:37777';

const args = process.argv.slice(2);
const SAMPLE = (() => { const i = args.indexOf('--sample'); return i !== -1 ? parseInt(args[i+1]) : 60; })();
const DRY_RUN = args.includes('--dry-run');
const CALL_DELAY_MS = 2500;

// Thresholds to report injection eligibility
const BASELINE_THRESHOLD = 0.35;
const POC_THRESHOLD = 0.45;

function loadProvider() {
  const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  const { CLAUDE_MEM_CUSTOM_BASE_URL: baseUrl, CLAUDE_MEM_CUSTOM_API_KEY: apiKey, CLAUDE_MEM_CUSTOM_MODEL: model } = s;
  if (!baseUrl || !apiKey || !model) throw new Error('Missing CLAUDE_MEM_CUSTOM_* in settings.json');
  return { baseUrl, apiKey, model };
}

async function callLLM({ baseUrl, apiKey, model }, systemPrompt, userContent, retries = 4) {
  let delay = 5000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
        max_completion_tokens: 40,
      }),
    });
    if (res.status === 429 && attempt < retries) {
      process.stdout.write(` [429:${Math.round(delay/1000)}s]`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
      continue;
    }
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim() ?? '';
  }
  throw new Error('Max retries exceeded');
}

async function querySemantic(queryText, threshold = 2.0, docType = 'observation') {
  try {
    const res = await fetch(`${WORKER_URL}/api/context/semantic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: queryText, docType, threshold, limit: 1 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data.decision;
    return {
      status: d?.status,
      bestDistance: d?.bestDistance ?? (d?.status === 'injected' ? 0 : null),
      topObsId: d?.traceItems?.[0]?.observationId ?? null,
    };
  } catch { return null; }
}

const SYSTEM_PROMPT = `You are a relevance judge for an AI memory injection system.

Given:
- CONTEXT: what the AI assistant just completed/said
- MEMORY: a stored observation that might be injected as context

Classify the memory's relevance to the context. Respond with ONE word only:
RELEVANT     - directly addresses same files, patterns, errors, or decisions in context
MARGINAL     - loosely related, unlikely to change behavior
NOT_RELEVANT - different domain, files, or concern entirely`;

function judgePayload(asstContext, obs) {
  const facts = (() => {
    try { return JSON.parse(obs.facts || '[]').slice(0, 2).join(' | '); }
    catch { return obs.facts?.slice(0, 120) ?? ''; }
  })();
  return `CONTEXT (assistant output, first 450 chars):
${asstContext.slice(0, 450)}

MEMORY:
type: ${obs.type}
title: ${obs.title ?? '(none)'}
narrative: ${(obs.narrative ?? '').slice(0, 180)}
facts: ${facts.slice(0, 150)}`;
}

function parseVerdict(raw) {
  const v = raw.replace(/[^A-Z_]/g, '');
  if (v.startsWith('RELEVANT')) return 'RELEVANT';
  if (v.startsWith('MARGINAL')) return 'MARGINAL';
  if (v.startsWith('NOT_RELEVANT') || v.startsWith('NOT')) return 'NOT_RELEVANT';
  return 'UNCLEAR';
}

async function main() {
  const db = new Database(DB_PATH);
  const provider = DRY_RUN ? null : loadProvider();

  // Sample diverse decisions with prior_asst available
  const decisions = db.query(`
    SELECT
      mad.id,
      mad.best_distance AS obs_dist_stored,
      mad.content_session_id AS session,
      up.prompt_text,
      (
        SELECT ocs.prior_assistant_message
        FROM observation_capture_snapshots ocs
        WHERE ocs.content_session_id = mad.content_session_id
          AND ocs.prompt_number <= mad.prompt_number
          AND LENGTH(ocs.prior_assistant_message) > 80
          AND ocs.prior_assistant_message NOT LIKE '%QUALITY REPORT%'
          AND ocs.prior_assistant_message NOT LIKE '%SNAPSHOT%'
          AND ocs.prior_assistant_message NOT LIKE '%Iteração%'
        ORDER BY ocs.prompt_number DESC, ocs.id DESC
        LIMIT 1
      ) AS prior_asst
    FROM memory_assist_decisions mad
    JOIN user_prompts up
      ON up.content_session_id = mad.content_session_id
      AND up.prompt_number = mad.prompt_number
    WHERE mad.source = 'semantic_prompt'
      AND mad.status = 'skipped'
      AND mad.reason = 'below_threshold'
      AND mad.best_distance IS NOT NULL
      AND LENGTH(up.prompt_text) >= 20
    ORDER BY RANDOM()
    LIMIT ?
  `).all(SAMPLE * 3).filter(d => d.prior_asst?.length > 80);

  // Deduplicate by prior_asst prefix to maximize content diversity
  const seen = new Set();
  const eligible = [];
  for (const d of decisions) {
    const key = d.prior_asst.slice(0, 120);
    if (!seen.has(key)) { seen.add(key); eligible.push(d); }
    if (eligible.length >= SAMPLE) break;
  }

  const sessions = new Set(eligible.map(d => d.session));
  console.log(`\n# POC: Injection Quality — Baseline vs Prior-Assistant Query`);
  console.log(`Decisions: ${eligible.length} | Sessions: ${sessions.size} | Dry-run: ${DRY_RUN}`);
  console.log(`Baseline threshold: ${BASELINE_THRESHOLD} | POC threshold: ${POC_THRESHOLD}\n`);

  const results = [];

  for (let i = 0; i < eligible.length; i++) {
    const dec = eligible[i];
    process.stdout.write(`[${i+1}/${eligible.length}] dec=${dec.id} `);

    // A: Baseline — best obs found by user_prompt
    const aRes = await querySemantic(dec.prompt_text, 2.0);
    await new Promise(r => setTimeout(r, 200));

    // B: POC — best obs found by prior_asst
    const bRes = await querySemantic(dec.prior_asst, 2.0);
    await new Promise(r => setTimeout(r, 200));

    const aObsId = aRes?.topObsId ?? null;
    const bObsId = bRes?.topObsId ?? null;
    const aDist = aRes?.bestDistance ?? dec.obs_dist_stored; // fallback to stored
    const bDist = bRes?.bestDistance ?? null;

    let aVerdict = null;
    let bVerdict = null;

    // Fetch obs and judge A
    if (aObsId && !DRY_RUN) {
      const obs = db.query('SELECT type, title, narrative, facts FROM observations WHERE id=?').get(aObsId);
      if (obs) {
        try {
          const raw = await callLLM(provider, SYSTEM_PROMPT, judgePayload(dec.prior_asst, obs));
          aVerdict = parseVerdict(raw);
          process.stdout.write(`A=${aObsId}:${aVerdict} `);
          await new Promise(r => setTimeout(r, CALL_DELAY_MS));
        } catch { aVerdict = 'ERROR'; }
      }
    } else if (DRY_RUN && aObsId) { aVerdict = 'DRY_RUN'; }

    // Fetch obs and judge B (skip if same obs as A to save tokens)
    if (bObsId && !DRY_RUN) {
      if (bObsId === aObsId) {
        bVerdict = aVerdict; // same obs = same verdict
        process.stdout.write(`B=same `);
      } else {
        const obs = db.query('SELECT type, title, narrative, facts FROM observations WHERE id=?').get(bObsId);
        if (obs) {
          try {
            const raw = await callLLM(provider, SYSTEM_PROMPT, judgePayload(dec.prior_asst, obs));
            bVerdict = parseVerdict(raw);
            process.stdout.write(`B=${bObsId}:${bVerdict} `);
            await new Promise(r => setTimeout(r, CALL_DELAY_MS));
          } catch { bVerdict = 'ERROR'; }
        }
      }
    } else if (DRY_RUN && bObsId) { bVerdict = 'DRY_RUN'; }

    process.stdout.write('\n');

    results.push({
      id: dec.id,
      session: dec.session.slice(0, 8),
      // distances
      aDist: parseFloat(aDist?.toFixed(3) ?? 'null'),
      bDist: parseFloat(bDist?.toFixed(3) ?? 'null'),
      delta: bDist != null && aDist != null ? parseFloat((aDist - bDist).toFixed(3)) : null,
      // injection eligibility
      aInjects: aDist != null && aDist <= BASELINE_THRESHOLD,
      bInjects: bDist != null && bDist <= POC_THRESHOLD,
      // obs ids
      aObsId, bObsId,
      sameObs: aObsId != null && aObsId === bObsId,
      // verdicts
      aVerdict, bVerdict,
    });
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log(`\n## Raw Results (IDs + distances + verdicts)\n`);
  console.log(`| ID | Session | A dist | B dist | Δ | A injects? | B injects? | A verdict | B verdict |`);
  console.log(`|----|---------|--------|--------|---|------------|------------|-----------|-----------|`);
  for (const r of results) {
    const delta = r.delta != null ? (r.delta >= 0 ? `+${r.delta}` : `${r.delta}`) : 'N/A';
    console.log(`| ${r.id} | ${r.session} | ${r.aDist ?? 'N/A'} | ${r.bDist ?? 'N/A'} | ${delta} | ${r.aInjects ? '✅' : '—'} | ${r.bInjects ? '✅' : '—'} | ${r.aVerdict ?? '—'} | ${r.bVerdict ?? '—'} |`);
  }

  // ─── Aggregates ────────────────────────────────────────────────────────────
  const withDists = results.filter(r => r.aDist != null && r.bDist != null);
  const withVerdicts = results.filter(r => r.aVerdict && r.bVerdict && !['ERROR','DRY_RUN','UNCLEAR'].includes(r.aVerdict) && !['ERROR','DRY_RUN','UNCLEAR'].includes(r.bVerdict));

  console.log(`\n## Distance Summary\n`);
  if (withDists.length > 0) {
    const avgA = avg(withDists.map(r => r.aDist));
    const avgB = avg(withDists.map(r => r.bDist));
    const avgDelta = avg(withDists.map(r => r.delta).filter(d => d != null));
    const bCloser = withDists.filter(r => r.delta > 0).length;
    console.log(`Avg A (user_prompt):  ${avgA.toFixed(3)}`);
    console.log(`Avg B (prior_asst):   ${avgB.toFixed(3)}`);
    console.log(`Avg delta (A-B):      ${avgDelta.toFixed(3)} (positive = B closer)`);
    console.log(`B closer than A:      ${bCloser}/${withDists.length} (${pct(bCloser, withDists.length)}%)`);
  }

  console.log(`\n## Injection Rate\n`);
  const aInj = results.filter(r => r.aInjects).length;
  const bInj = results.filter(r => r.bInjects).length;
  const onlyB = results.filter(r => !r.aInjects && r.bInjects).length;
  const onlyA = results.filter(r => r.aInjects && !r.bInjects).length;
  console.log(`A injects (threshold ${BASELINE_THRESHOLD}): ${aInj}/${results.length} (${pct(aInj, results.length)}%)`);
  console.log(`B injects (threshold ${POC_THRESHOLD}):  ${bInj}/${results.length} (${pct(bInj, results.length)}%)`);
  console.log(`New from B only:       ${onlyB} | Regressions (A only): ${onlyA}`);

  console.log(`\n## Quality (Judge Verdicts)\n`);
  if (withVerdicts.length > 0) {
    for (const [label, key] of [['A (baseline, user_prompt)', 'aVerdict'], ['B (POC, prior_asst)', 'bVerdict']]) {
      const verdicts = withVerdicts.map(r => r[key]);
      const rel = verdicts.filter(v => v === 'RELEVANT').length;
      const mar = verdicts.filter(v => v === 'MARGINAL').length;
      const not = verdicts.filter(v => v === 'NOT_RELEVANT').length;
      console.log(`${label}:`);
      console.log(`  RELEVANT:     ${rel}/${verdicts.length} (${pct(rel, verdicts.length)}%)`);
      console.log(`  MARGINAL:     ${mar}/${verdicts.length} (${pct(mar, verdicts.length)}%)`);
      console.log(`  NOT_RELEVANT: ${not}/${verdicts.length} (${pct(not, verdicts.length)}%)`);
      console.log(`  Useful (R+M): ${pct(rel + mar, verdicts.length)}%`);
    }

    // Head-to-head on same decisions
    const bBetter = withVerdicts.filter(r => score(r.bVerdict) > score(r.aVerdict)).length;
    const aBetter = withVerdicts.filter(r => score(r.aVerdict) > score(r.bVerdict)).length;
    const tie = withVerdicts.filter(r => score(r.aVerdict) === score(r.bVerdict)).length;
    console.log(`\nHead-to-head (same decisions):`);
    console.log(`  B wins: ${bBetter} | A wins: ${aBetter} | Tie: ${tie}`);
  } else {
    console.log('No judged pairs available.');
  }
}

const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const pct = (n, d) => d === 0 ? 0 : Math.round((n / d) * 100);
const score = v => v === 'RELEVANT' ? 2 : v === 'MARGINAL' ? 1 : 0;

main().catch(e => { console.error(e); process.exit(1); });
