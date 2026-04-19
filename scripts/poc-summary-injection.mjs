/**
 * POC: Summary Injection Delta Analysis
 *
 * Hypothesis: including session_summaries in semantic injection would surface
 * relevant context that observations miss, because summaries are more prescriptive
 * and written in complete English sentences.
 *
 * Method:
 *   1. Sample N recent semantic decisions that were skipped (below_threshold, obs)
 *   2. For each prompt, query Chroma with docType=session_summary at the same threshold
 *   3. Compare: obs_best_distance (stored) vs summary_best_distance (new query)
 *   4. Report deltas, injection rate changes, regression risk
 *
 * PII guard: report decision IDs + distances only — no prompt text, no summary content.
 *
 * Usage:
 *   node scripts/poc-summary-injection.mjs [--sample N] [--threshold T]
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const sampleSize = parseInt(args[args.indexOf('--sample') + 1] || '25', 10);
const BASE_THRESHOLD = parseFloat(args[args.indexOf('--threshold') + 1] || '0.35');
const WORKER_URL = 'http://localhost:37777';

// Thresholds to test for summary injection
const TEST_THRESHOLDS = [0.35, 0.45, 0.55];

async function querySemanticSummary(promptText, threshold) {
  try {
    const res = await fetch(`${WORKER_URL}/api/context/semantic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: promptText,
        docType: 'session_summary',
        threshold,
        limit: 5,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.decision;
  } catch {
    return null;
  }
}

async function main() {
  const db = new Database(join(homedir(), '.claude-mem/claude-mem.db'));

  // Get skipped decisions with their stored obs distance + matching prompt text
  const decisions = db.query(`
    SELECT
      mad.id,
      mad.best_distance AS obs_best_distance,
      mad.worst_distance AS obs_worst_distance,
      mad.candidate_count AS obs_candidates,
      mad.prompt_number,
      mad.content_session_id,
      up.prompt_text
    FROM memory_assist_decisions mad
    JOIN user_prompts up
      ON up.content_session_id = mad.content_session_id
      AND up.prompt_number = mad.prompt_number
    WHERE mad.source = 'semantic_prompt'
      AND mad.status = 'skipped'
      AND mad.reason = 'below_threshold'
      AND mad.best_distance IS NOT NULL
      AND up.prompt_text IS NOT NULL
      AND LENGTH(up.prompt_text) >= 20
    ORDER BY mad.id DESC
    LIMIT ?
  `).all(sampleSize);

  if (decisions.length === 0) {
    console.log('No eligible decisions found.');
    process.exit(0);
  }

  console.log(`\n# POC: Summary Injection Delta Analysis`);
  console.log(`Sampled: ${decisions.length} skipped semantic decisions (most recent)`);
  console.log(`Base threshold (obs): ${BASE_THRESHOLD}`);
  console.log(`Test thresholds for summaries: ${TEST_THRESHOLDS.join(', ')}\n`);

  // Query Chroma for summaries for each prompt
  const results = [];
  for (const dec of decisions) {
    // Use base threshold to get summary bestDistance in skipped response
    const summaryDecision = await querySemanticSummary(dec.prompt_text, BASE_THRESHOLD);
    const sumBest = summaryDecision?.bestDistance ?? null;
    const sumCandidates = summaryDecision?.candidateCount ?? null;

    results.push({
      id: dec.id,
      obsBest: dec.obs_best_distance,
      sumBest,
      sumCandidates,
      delta: sumBest != null ? dec.obs_best_distance - sumBest : null, // positive = summary closer
      wouldInjectByThreshold: TEST_THRESHOLDS.map(t => ({
        t,
        obsInjects: dec.obs_best_distance <= t,
        sumInjects: sumBest != null && sumBest <= t,
      })),
    });

    // Small delay to avoid hammering the worker
    await new Promise(r => setTimeout(r, 80));
  }

  // --- Report ---
  const withSummary = results.filter(r => r.sumBest != null);
  const noSummary = results.filter(r => r.sumBest == null);

  console.log(`## Raw Results (IDs + distances only)\n`);
  console.log(`| Decision ID | Obs Best | Sum Best | Delta | Closer? |`);
  console.log(`|-------------|----------|----------|-------|---------|`);
  for (const r of results) {
    const delta = r.delta != null ? r.delta.toFixed(3) : 'N/A';
    const closer = r.delta != null ? (r.delta > 0 ? '✅ sum' : r.delta < 0 ? '⚠️ obs' : '=') : '—';
    console.log(`| ${r.id} | ${r.obsBest?.toFixed(3)} | ${r.sumBest?.toFixed(3) ?? 'N/A'} | ${delta} | ${closer} |`);
  }

  console.log(`\n## Injection Rate by Threshold\n`);
  for (const t of TEST_THRESHOLDS) {
    const obsWouldInject = results.filter(r => r.obsBest <= t).length;
    const sumWouldInject = withSummary.filter(r => r.sumBest <= t).length;
    const newInjections = withSummary.filter(r => r.obsBest > t && r.sumBest != null && r.sumBest <= t).length;
    const regressions = withSummary.filter(r => r.obsBest <= t && r.sumBest != null && r.sumBest > t).length;
    console.log(`**Threshold ${t}:**`);
    console.log(`  Obs injects: ${obsWouldInject}/${results.length} (${pct(obsWouldInject, results.length)}%)`);
    console.log(`  Sum injects: ${sumWouldInject}/${withSummary.length} (${pct(sumWouldInject, withSummary.length)}%)`);
    console.log(`  New injections (sum only): ${newInjections}`);
    console.log(`  Regressions (obs injects, sum doesn't): ${regressions}`);
    console.log('');
  }

  console.log(`## Distance Distribution\n`);
  if (withSummary.length > 0) {
    const deltas = withSummary.map(r => r.delta).filter(d => d != null);
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const positiveDelta = deltas.filter(d => d > 0).length;
    const negativeDelta = deltas.filter(d => d < 0).length;
    const avgObsBest = withSummary.reduce((a, r) => a + r.obsBest, 0) / withSummary.length;
    const avgSumBest = withSummary.reduce((a, r) => a + r.sumBest, 0) / withSummary.length;

    console.log(`Decisions with summary candidates: ${withSummary.length}/${results.length}`);
    console.log(`Decisions with no summary match: ${noSummary.length}/${results.length}`);
    console.log(`Avg obs bestDistance: ${avgObsBest.toFixed(3)}`);
    console.log(`Avg sum bestDistance: ${avgSumBest.toFixed(3)}`);
    console.log(`Avg delta (obs - sum): ${avgDelta.toFixed(3)} (positive = summary closer)`);
    console.log(`Summary closer than obs: ${positiveDelta}/${withSummary.length} (${pct(positiveDelta, withSummary.length)}%)`);
    console.log(`Obs closer than summary (regression risk): ${negativeDelta}/${withSummary.length} (${pct(negativeDelta, withSummary.length)}%)`);
  } else {
    console.log('No summary candidates found for any prompt.');
  }
}

function pct(n, d) {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

main().catch(e => { console.error(e); process.exit(1); });
