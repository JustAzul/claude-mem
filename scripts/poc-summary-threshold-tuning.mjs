/**
 * POC: Summary Injection Threshold Tuning — Quality + Coverage
 *
 * Validates whether session_summaries are relevant enough to inject alongside
 * observations, and finds the optimal threshold.
 *
 * Method:
 *   1. Sample N decisions that have prior_asst (>=80 chars) available
 *   2. For each decision:
 *      a. Query Chroma (via worker) with prior_asst, docType=session_summary → bestDistance
 *      b. Find the most recent session_summary for the same project, created before
 *         the decision — used as judge candidate (nearest-in-time proxy for nearest-in-space)
 *   3. Judge summary content against prior_asst context
 *   4. Sweep thresholds 0.35–0.75 and report injection rate + quality at each level
 *
 * Why nearest-in-time? Chroma returns a summary ID but the semantic endpoint can't
 * hydrate it (session_summaries is not the observations table). Nearest project summary
 * by timestamp is a reasonable proxy — semantically similar work tends to cluster
 * in time within the same project.
 *
 * PII guard: IDs + distances + verdicts only in output.
 *
 * Usage: bun scripts/poc-summary-threshold-tuning.mjs [--sample N] [--dry-run]
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');
const WORKER_URL = 'http://localhost:37777';

const args = process.argv.slice(2);
const SAMPLE = (() => { const i = args.indexOf('--sample'); return i !== -1 ? parseInt(args[i+1]) : 50; })();
const DRY_RUN = args.includes('--dry-run');
const CALL_DELAY_MS = 2500;

const TEST_THRESHOLDS = [0.35, 0.45, 0.55, 0.65, 0.75];

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

async function querySummaryDistance(asstText) {
  try {
    const res = await fetch(`${WORKER_URL}/api/context/semantic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: asstText, docType: 'session_summary', threshold: 2.0, limit: 1 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data.decision;
    // bestDistance is valid even when status=hydration_miss
    return d?.bestDistance ?? null;
  } catch { return null; }
}

const SYSTEM_PROMPT = `You are a relevance judge for an AI memory injection system.

Given:
- CONTEXT: what the AI assistant just completed/said
- SUMMARY: a stored session summary that might be injected as context

Classify the summary's relevance to the context. Respond with ONE word only:
RELEVANT     - directly addresses same project area, patterns, errors, or decisions in context
MARGINAL     - loosely related, unlikely to change behavior
NOT_RELEVANT - different project area, domain, or concern entirely`;

function judgePayload(asstContext, summary) {
  const parts = [
    summary.request ? `request: ${summary.request.slice(0, 120)}` : null,
    summary.investigated ? `investigated: ${summary.investigated.slice(0, 120)}` : null,
    summary.completed ? `completed: ${summary.completed.slice(0, 120)}` : null,
    summary.learned ? `learned: ${summary.learned.slice(0, 100)}` : null,
  ].filter(Boolean).join('\n');

  return `CONTEXT (assistant output, first 450 chars):
${asstContext.slice(0, 450)}

SUMMARY (session: ${summary.id}, project: ${summary.project}):
${parts}`;
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

  // Sample decisions with prior_asst and their project + timestamp
  const decisions = db.query(`
    SELECT
      mad.id,
      mad.content_session_id AS session,
      mad.prompt_number,
      mad.created_at_epoch,
      (
        SELECT up.prompt_text FROM user_prompts up
        WHERE up.content_session_id = mad.content_session_id
          AND up.prompt_number = mad.prompt_number
        LIMIT 1
      ) AS prompt_text,
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
      ) AS prior_asst,
      (
        SELECT ss.project FROM sdk_sessions sk
        JOIN session_summaries ss ON ss.memory_session_id = sk.memory_session_id
        WHERE sk.content_session_id = mad.content_session_id
        LIMIT 1
      ) AS project
    FROM memory_assist_decisions mad
    WHERE mad.source = 'semantic_prompt'
      AND mad.status IN ('skipped', 'injected')
    ORDER BY RANDOM()
    LIMIT ?
  `).all(SAMPLE * 3).filter(d => d.prior_asst?.length > 80 && d.project);

  // Deduplicate by prior_asst prefix
  const seen = new Set();
  const eligible = [];
  for (const d of decisions) {
    const key = d.prior_asst.slice(0, 120);
    if (!seen.has(key)) { seen.add(key); eligible.push(d); }
    if (eligible.length >= SAMPLE) break;
  }

  const sessions = new Set(eligible.map(d => d.session));
  console.log(`\n# POC: Summary Injection Threshold Tuning`);
  console.log(`Decisions: ${eligible.length} | Sessions: ${sessions.size} | Dry-run: ${DRY_RUN}`);
  console.log(`Thresholds: ${TEST_THRESHOLDS.join(', ')}\n`);
  console.log(`Note: judge candidate = most recent project summary before decision timestamp`);
  console.log(`      distance = actual Chroma distance (prior_asst vs session_summary embeddings)\n`);

  const results = [];

  for (let i = 0; i < eligible.length; i++) {
    const dec = eligible[i];
    process.stdout.write(`[${i+1}/${eligible.length}] dec=${dec.id} `);

    // Get Chroma distance for this prior_asst vs session_summary docs
    const bestDist = await querySummaryDistance(dec.prior_asst);
    await new Promise(r => setTimeout(r, 200));

    // Find the most recent summary for the same project before this decision's time
    const summary = bestDist != null
      ? db.query(`
          SELECT ss.id, ss.project, ss.request, ss.investigated, ss.completed, ss.learned, ss.created_at
          FROM session_summaries ss
          WHERE ss.project = ?
            AND ss.created_at_epoch < ?
          ORDER BY ss.created_at_epoch DESC
          LIMIT 1
        `).get(dec.project, dec.created_at_epoch)
      : null;

    let verdict = null;

    if (summary && !DRY_RUN) {
      try {
        const raw = await callLLM(provider, SYSTEM_PROMPT, judgePayload(dec.prior_asst, summary));
        verdict = parseVerdict(raw);
        process.stdout.write(`dist=${bestDist?.toFixed(3)} sum=${summary.id} verdict=${verdict}`);
        await new Promise(r => setTimeout(r, CALL_DELAY_MS));
      } catch { verdict = 'ERROR'; }
    } else if (summary && DRY_RUN) {
      verdict = 'DRY_RUN';
      process.stdout.write(`dist=${bestDist?.toFixed(3)} sum=${summary.id} [dry-run]`);
    } else if (!summary) {
      process.stdout.write(`no_summary_for_project=${dec.project}`);
    } else {
      process.stdout.write(`no_distance`);
    }

    process.stdout.write('\n');
    results.push({ id: dec.id, session: dec.session.slice(0, 8), bestDist, summaryId: summary?.id ?? null, verdict });
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log(`\n## Raw Results\n`);
  console.log(`| ID | Session | Sum Dist | Summary ID | Verdict |`);
  console.log(`|----|---------|----------|------------|---------|`);
  for (const r of results) {
    console.log(`| ${r.id} | ${r.session} | ${r.bestDist?.toFixed(3) ?? 'N/A'} | ${r.summaryId ?? '—'} | ${r.verdict ?? '—'} |`);
  }

  console.log(`\n## Threshold Tradeoff Table\n`);
  console.log(`| Threshold | Injects | Rate | RELEVANT | MARGINAL | NOT_RELEVANT | Marginal: new | new RELEVANT% |`);
  console.log(`|-----------|---------|------|----------|----------|--------------|---------------|---------------|`);

  let prevInjectIds = new Set();

  for (const T of TEST_THRESHOLDS) {
    const injecting = results.filter(r => r.bestDist != null && r.bestDist <= T);
    const judged = injecting.filter(r => r.verdict && !['ERROR','DRY_RUN','UNCLEAR'].includes(r.verdict));
    const rel = judged.filter(r => r.verdict === 'RELEVANT').length;
    const mar = judged.filter(r => r.verdict === 'MARGINAL').length;
    const not = judged.filter(r => r.verdict === 'NOT_RELEVANT').length;

    const newlyInjecting = injecting.filter(r => !prevInjectIds.has(r.id));
    const newlyJudged = newlyInjecting.filter(r => r.verdict && !['ERROR','DRY_RUN','UNCLEAR'].includes(r.verdict));
    const newRel = newlyJudged.filter(r => r.verdict === 'RELEVANT').length;
    const newRelStr = newlyJudged.length > 0 ? `${pct(newRel, newlyJudged.length)}% (${newRel}/${newlyJudged.length})` : '—';

    console.log(`| ${T} | ${injecting.length}/${results.length} | ${pct(injecting.length, results.length)}% | ${rel} (${pct(rel,Math.max(judged.length,1))}%) | ${mar} (${pct(mar,Math.max(judged.length,1))}%) | ${not} (${pct(not,Math.max(judged.length,1))}%) | +${newlyInjecting.length} | ${newRelStr} |`);

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

  console.log(`\n## Quality Summary (all judged decisions)\n`);
  const allJudged = results.filter(r => r.verdict && !['ERROR','DRY_RUN','UNCLEAR'].includes(r.verdict));
  if (allJudged.length > 0) {
    const rel = allJudged.filter(r => r.verdict === 'RELEVANT').length;
    const mar = allJudged.filter(r => r.verdict === 'MARGINAL').length;
    const not = allJudged.filter(r => r.verdict === 'NOT_RELEVANT').length;
    console.log(`RELEVANT:     ${rel}/${allJudged.length} (${pct(rel, allJudged.length)}%)`);
    console.log(`MARGINAL:     ${mar}/${allJudged.length} (${pct(mar, allJudged.length)}%)`);
    console.log(`NOT_RELEVANT: ${not}/${allJudged.length} (${pct(not, allJudged.length)}%)`);
    console.log(`Useful (R+M): ${pct(rel+mar, allJudged.length)}%`);
  }
}

const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const pct = (n, d) => d === 0 ? 0 : Math.round((n / d) * 100);

main().catch(e => { console.error(e); process.exit(1); });
