/**
 * POC: Prior Assistant Message as Semantic Query
 *
 * Hypothesis: using the prior assistant message as the Chroma query (instead of
 * the raw user prompt) produces much lower distances, because assistant messages
 * are in English, technical, and describe the actual work being done — matching
 * the vocabulary of observations.
 *
 * Three queries compared for the same decision:
 *   A. user_prompt           (current behavior, stored best_distance)
 *   B. prior_assistant_msg   (hypothesis)
 *   C. combined              (user_prompt + "\n" + prior_assistant_msg[:400])
 *
 * Method:
 *   - Sample N skipped semantic decisions that have a non-monitor assistant message
 *   - Query Chroma with B and C, compare distances vs stored A distance
 *   - Report injection rates at multiple thresholds, regression risk, delta distribution
 *
 * PII guard: IDs + distances only. No prompt text, assistant text, or observation content.
 *
 * Usage: bun scripts/poc-assistant-query.mjs [--sample N] [--threshold T]
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const sampleSize = parseInt(args[args.indexOf('--sample') + 1] || '40', 10);
const BASE_THRESHOLD = 0.35;
const TEST_THRESHOLDS = [0.35, 0.45, 0.55, 0.65];
const WORKER_URL = 'http://localhost:37777';
const DELAY_MS = 80;

async function queryChroma(queryText, threshold = BASE_THRESHOLD, docType = 'observation') {
  try {
    const res = await fetch(`${WORKER_URL}/api/context/semantic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: queryText, docType, threshold, limit: 5 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data.decision;
    // Return bestDistance from decision (present whether injected or skipped)
    const bestDist = d?.bestDistance ?? (d?.status === 'injected' ? 0.0 : null);
    return { bestDistance: bestDist, candidateCount: d?.candidateCount ?? null, status: d?.status };
  } catch {
    return null;
  }
}

async function main() {
  const db = new Database(join(homedir(), '.claude-mem/claude-mem.db'));

  const decisions = db.query(`
    SELECT
      mad.id,
      mad.best_distance AS obs_best,
      up.prompt_text,
      (
        SELECT ocs.prior_assistant_message
        FROM observation_capture_snapshots ocs
        WHERE ocs.content_session_id = mad.content_session_id
          AND ocs.prompt_number <= mad.prompt_number
          AND ocs.prior_assistant_message IS NOT NULL
          AND LENGTH(ocs.prior_assistant_message) > 80
          AND ocs.prior_assistant_message NOT LIKE '%QUALITY REPORT%'
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
      AND up.prompt_text IS NOT NULL
      AND LENGTH(up.prompt_text) >= 20
    ORDER BY mad.id DESC LIMIT ?
  `).all(sampleSize * 2); // oversample to filter out missing

  const eligible = decisions.filter(d => d.prior_asst && d.prior_asst.length > 80).slice(0, sampleSize);

  if (eligible.length === 0) {
    console.log('No eligible decisions found.');
    process.exit(0);
  }

  console.log(`\n# POC: Prior Assistant Message as Semantic Query`);
  console.log(`Sampled: ${eligible.length} decisions`);
  console.log(`Thresholds tested: ${TEST_THRESHOLDS.join(', ')}\n`);

  const results = [];

  for (const dec of eligible) {
    // B: prior_assistant_message as query (use high threshold to always get distance)
    const asstRes = await queryChroma(dec.prior_asst, 2.0);
    await new Promise(r => setTimeout(r, DELAY_MS));

    // C: combined query (user_prompt + first 400 chars of assistant)
    const combined = `${dec.prompt_text}\n${dec.prior_asst.slice(0, 400)}`;
    const combRes = await queryChroma(combined, 2.0);
    await new Promise(r => setTimeout(r, DELAY_MS));

    const obsBest = dec.obs_best;
    const asstBest = asstRes?.bestDistance ?? null;
    const combBest = combRes?.bestDistance ?? null;

    results.push({
      id: dec.id,
      obsBest,
      asstBest,
      combBest,
      deltaAsst: asstBest != null ? obsBest - asstBest : null,    // positive = asst closer
      deltaComb: combBest != null ? obsBest - combBest : null,
    });
  }

  // --- Report ---
  console.log(`## Raw Results (IDs + distances)\n`);
  console.log(`| ID | Obs(A) | Asst(B) | Δ(A-B) | Comb(C) | Δ(A-C) |`);
  console.log(`|----|--------|---------|--------|---------|--------|`);
  for (const r of results) {
    const dA = r.deltaAsst != null ? r.deltaAsst.toFixed(3) : 'N/A';
    const dC = r.deltaComb != null ? r.deltaComb.toFixed(3) : 'N/A';
    console.log(`| ${r.id} | ${r.obsBest.toFixed(3)} | ${r.asstBest?.toFixed(3) ?? 'N/A'} | ${dA} | ${r.combBest?.toFixed(3) ?? 'N/A'} | ${dC} |`);
  }

  console.log(`\n## Injection Rate by Threshold\n`);
  for (const t of TEST_THRESHOLDS) {
    const obsInj = results.filter(r => r.obsBest <= t).length;
    const asstInj = results.filter(r => r.asstBest != null && r.asstBest <= t).length;
    const combInj = results.filter(r => r.combBest != null && r.combBest <= t).length;

    const newFromAsst = results.filter(r => r.obsBest > t && r.asstBest != null && r.asstBest <= t).length;
    const newFromComb = results.filter(r => r.obsBest > t && r.combBest != null && r.combBest <= t).length;
    const regrAsst = results.filter(r => r.obsBest <= t && r.asstBest != null && r.asstBest > t).length;
    const regrComb = results.filter(r => r.obsBest <= t && r.combBest != null && r.combBest > t).length;

    console.log(`**Threshold ${t}:**`);
    console.log(`  A(obs):   ${obsInj}/${results.length} (${pct(obsInj, results.length)}%)`);
    console.log(`  B(asst):  ${asstInj}/${results.length} (${pct(asstInj, results.length)}%)  new: +${newFromAsst}  regression: -${regrAsst}`);
    console.log(`  C(comb):  ${combInj}/${results.length} (${pct(combInj, results.length)}%)  new: +${newFromComb}  regression: -${regrComb}`);
    console.log('');
  }

  console.log(`## Distance Summary\n`);
  const withAsst = results.filter(r => r.asstBest != null);
  const withComb = results.filter(r => r.combBest != null);

  if (withAsst.length > 0) {
    const avgObs = avg(results.map(r => r.obsBest));
    const avgAsst = avg(withAsst.map(r => r.asstBest));
    const avgComb = avg(withComb.map(r => r.combBest));
    const avgDeltaAsst = avg(withAsst.map(r => r.deltaAsst));
    const avgDeltaComb = avg(withComb.map(r => r.deltaComb));
    const asstCloser = withAsst.filter(r => r.deltaAsst > 0).length;
    const combCloser = withComb.filter(r => r.deltaComb > 0).length;

    console.log(`Avg obs best:    ${avgObs.toFixed(3)}`);
    console.log(`Avg asst best:   ${avgAsst.toFixed(3)}  (Δ avg: ${avgDeltaAsst.toFixed(3)})  asst closer: ${asstCloser}/${withAsst.length} (${pct(asstCloser, withAsst.length)}%)`);
    console.log(`Avg comb best:   ${avgComb.toFixed(3)}  (Δ avg: ${avgDeltaComb.toFixed(3)})  comb closer: ${combCloser}/${withComb.length} (${pct(combCloser, withComb.length)}%)`);
  }
}

const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const pct = (n, d) => d === 0 ? 0 : Math.round((n / d) * 100);

main().catch(e => { console.error(e); process.exit(1); });
