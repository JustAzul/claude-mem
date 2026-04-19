/**
 * POC: Threshold Tuning for Prior-Assistant Semantic Query
 *
 * Prior-asst query already validated: 65% RELEVANT vs 21% for user_prompt.
 * This script finds the optimal threshold by sweeping 0.35–0.55 and measuring
 * both injection rate and quality (LLM judge) at each level.
 *
 * Method:
 *   1. Sample N decisions with prior_asst available (both skipped and injected)
 *   2. For each, query Chroma with prior_asst at threshold=2.0 to get bestDistance + topObsId
 *   3. Judge top-1 candidate once per decision
 *   4. For each threshold T in TEST_THRESHOLDS:
 *      - Injection rate = decisions with bestDist <= T
 *      - Cumulative quality  = verdicts of all injecting decisions at T
 *      - Marginal quality    = verdicts of decisions NEW at this threshold vs previous
 *   5. Report tradeoff table
 *
 * PII guard: IDs + distances + verdicts only in output.
 *
 * Usage: bun scripts/poc-threshold-tuning.mjs [--sample N] [--dry-run]
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

const TEST_THRESHOLDS = [0.35, 0.40, 0.45, 0.50, 0.55];

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

async function queryAsst(asstText) {
  try {
    const res = await fetch(`${WORKER_URL}/api/context/semantic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: asstText, docType: 'observation', threshold: 2.0, limit: 1 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data.decision;
    return {
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

  // Sample from both skipped and injected decisions to get diverse distances
  const decisions = db.query(`
    SELECT
      mad.id,
      mad.best_distance AS stored_dist,
      mad.content_session_id AS session,
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
    WHERE mad.source = 'semantic_prompt'
      AND mad.status IN ('skipped', 'injected')
      AND mad.reason IN ('below_threshold', 'semantic_match')
    ORDER BY RANDOM()
    LIMIT ?
  `).all(SAMPLE * 3).filter(d => d.prior_asst?.length > 80);

  // Deduplicate by prior_asst prefix
  const seen = new Set();
  const eligible = [];
  for (const d of decisions) {
    const key = d.prior_asst.slice(0, 120);
    if (!seen.has(key)) { seen.add(key); eligible.push(d); }
    if (eligible.length >= SAMPLE) break;
  }

  const sessions = new Set(eligible.map(d => d.session));
  console.log(`\n# POC: Threshold Tuning — Prior-Assistant Query`);
  console.log(`Decisions: ${eligible.length} | Sessions: ${sessions.size} | Dry-run: ${DRY_RUN}`);
  console.log(`Thresholds: ${TEST_THRESHOLDS.join(', ')}\n`);

  const results = [];

  for (let i = 0; i < eligible.length; i++) {
    const dec = eligible[i];
    process.stdout.write(`[${i+1}/${eligible.length}] dec=${dec.id} `);

    // Query Chroma with prior_asst at threshold=2.0 (always get distance)
    const res = await queryAsst(dec.prior_asst);
    await new Promise(r => setTimeout(r, 200));

    const bestDist = res?.bestDistance ?? null;
    const topObsId = res?.topObsId ?? null;
    let verdict = null;

    if (topObsId && !DRY_RUN) {
      const obs = db.query('SELECT type, title, narrative, facts FROM observations WHERE id=?').get(topObsId);
      if (obs) {
        try {
          const raw = await callLLM(provider, SYSTEM_PROMPT, judgePayload(dec.prior_asst, obs));
          verdict = parseVerdict(raw);
          process.stdout.write(`obs=${topObsId} dist=${bestDist?.toFixed(3)} verdict=${verdict}`);
          await new Promise(r => setTimeout(r, CALL_DELAY_MS));
        } catch { verdict = 'ERROR'; }
      }
    } else if (DRY_RUN && topObsId) {
      verdict = 'DRY_RUN';
      process.stdout.write(`obs=${topObsId} dist=${bestDist?.toFixed(3)} [dry-run]`);
    } else {
      process.stdout.write(`no_candidate`);
    }

    process.stdout.write('\n');

    results.push({ id: dec.id, session: dec.session.slice(0, 8), bestDist, topObsId, verdict });
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log(`\n## Raw Results\n`);
  console.log(`| ID | Session | Best Dist | Top Obs | Verdict |`);
  console.log(`|----|---------|-----------|---------|---------|`);
  for (const r of results) {
    console.log(`| ${r.id} | ${r.session} | ${r.bestDist?.toFixed(3) ?? 'N/A'} | ${r.topObsId ?? '—'} | ${r.verdict ?? '—'} |`);
  }

  console.log(`\n## Threshold Tradeoff Table\n`);
  console.log(`| Threshold | Injects | Rate | RELEVANT | MARGINAL | NOT_RELEVANT | Marginal: new inj | new RELEVANT% |`);
  console.log(`|-----------|---------|------|----------|----------|--------------|-------------------|---------------|`);

  let prevInjectIds = new Set();

  for (const T of TEST_THRESHOLDS) {
    const injecting = results.filter(r => r.bestDist != null && r.bestDist <= T);
    const judged = injecting.filter(r => r.verdict && !['ERROR','DRY_RUN','UNCLEAR'].includes(r.verdict));
    const rel = judged.filter(r => r.verdict === 'RELEVANT').length;
    const mar = judged.filter(r => r.verdict === 'MARGINAL').length;
    const not = judged.filter(r => r.verdict === 'NOT_RELEVANT').length;

    // Marginal: decisions newly injecting at this threshold vs previous
    const newlyInjecting = injecting.filter(r => !prevInjectIds.has(r.id));
    const newlyJudged = newlyInjecting.filter(r => r.verdict && !['ERROR','DRY_RUN','UNCLEAR'].includes(r.verdict));
    const newRel = newlyJudged.filter(r => r.verdict === 'RELEVANT').length;
    const marginalStr = newlyJudged.length > 0 ? `+${newlyInjecting.length} inj` : `+${newlyInjecting.length}`;
    const newRelStr = newlyJudged.length > 0 ? `${pct(newRel, newlyJudged.length)}% (${newRel}/${newlyJudged.length})` : '—';

    console.log(`| ${T} | ${injecting.length}/${results.length} | ${pct(injecting.length, results.length)}% | ${rel} (${pct(rel,judged.length)}%) | ${mar} (${pct(mar,judged.length)}%) | ${not} (${pct(not,judged.length)}%) | ${marginalStr} | ${newRelStr} |`);

    prevInjectIds = new Set(injecting.map(r => r.id));
  }

  console.log(`\n## Distance Distribution\n`);
  const withDist = results.filter(r => r.bestDist != null);
  if (withDist.length > 0) {
    const sorted = withDist.map(r => r.bestDist).sort((a, b) => a - b);
    console.log(`Min: ${sorted[0].toFixed(3)} | Median: ${sorted[Math.floor(sorted.length/2)].toFixed(3)} | Max: ${sorted[sorted.length-1].toFixed(3)}`);
    console.log(`Avg: ${avg(sorted).toFixed(3)}`);
    for (const T of TEST_THRESHOLDS) {
      const below = sorted.filter(d => d <= T).length;
      console.log(`  <= ${T}: ${below}/${sorted.length} (${pct(below, sorted.length)}%)`);
    }
  }
}

const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const pct = (n, d) => d === 0 ? 0 : Math.round((n / d) * 100);

main().catch(e => { console.error(e); process.exit(1); });
