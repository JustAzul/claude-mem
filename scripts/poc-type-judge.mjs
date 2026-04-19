#!/usr/bin/env bun
/**
 * POC: Type Classification Judge
 *
 * Samples the N most recent observations, asks a judge LLM to reclassify
 * each one using the full decision tree, and measures disagreement rate
 * by type. Does NOT write to the DB unless --apply flag is passed and the
 * user confirms via AskUserQuestion logic (handled externally).
 *
 * Usage:
 *   bun scripts/poc-type-judge.mjs
 *   bun scripts/poc-type-judge.mjs --sample 50
 *   bun scripts/poc-type-judge.mjs --dry-run    (skip LLM, show prompts)
 *   bun scripts/poc-type-judge.mjs --apply      (write corrections to DB — use after review)
 */

import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');
const REPORT_PATH = join(import.meta.dir, 'poc-type-judge-report.md');

const args = process.argv.slice(2);
const SAMPLE = (() => { const i = args.indexOf('--sample'); return i !== -1 ? parseInt(args[i+1]) : 100; })();
const DRY_RUN = args.includes('--dry-run');
const APPLY = args.includes('--apply');
const DELAY_MS = 3000;

const VALID_TYPES = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision'];

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
    max_completion_tokens: 200,
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

// ─── Judge Prompt ─────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are a classification judge for software development observations.

Your only job: given a stored observation, output the CORRECT type using the decision tree below.

DECISION TREE — traverse in order, commit on the FIRST YES:
1. Did something previously broken now work? (failing test passes, error gone, crash fixed, wrong output corrected)
   → type=bugfix
2. Did this record a choice between two or more viable architectural/design alternatives where the trade-off mattered?
   → type=decision
3. Was a NEW capability added that did not exist before? (new function, endpoint, CLI flag, UI surface, feature)
   → type=feature
4. Was existing code restructured WITHOUT changing user-visible behavior? (rename, extract, split file, dedupe, move helper)
   → type=refactor
5. Was config, docs, tests, dependencies, or misc modified that does NOT fit 3 or 4?
   → type=change
6. Was something learned about how the existing system works WITHOUT changing it?
   → type=discovery

VERB TRIGGERS (override step 6 discovery default):
- Implemented/Added/Created/Introduced/Built → feature or change (not discovery)
- Fixed/Resolved/Patched/Corrected → bugfix (only if code had a real defect)
- Renamed/Extracted/Split/Moved → refactor
- Located/Found/Confirmed/Verified/Traced → discovery
- Chose/Decided/Selected/Rejected → decision

VALID TYPES (use EXACTLY one): bugfix | feature | refactor | change | discovery | decision

Output format — respond with ONLY this XML:
<verdict>
  <type>TYPE_HERE</type>
  <confidence>high|medium|low</confidence>
  <reason>One sentence explaining which decision-tree step fired and why.</reason>
  <agrees_with_stored>true|false</agrees_with_stored>
</verdict>`;

function buildJudgePrompt(obs) {
  return `Stored type: ${obs.type}

Title: ${obs.title ?? '(none)'}
Subtitle: ${obs.subtitle ?? '(none)'}
Narrative: ${(obs.narrative ?? '(none)').slice(0, 800)}
Facts:
${(obs.facts ?? []).slice(0, 5).map(f => `- ${f}`).join('\n') || '(none)'}

Classify this observation. Use the decision tree. Output only the <verdict> XML.`;
}

// ─── XML parse ───────────────────────────────────────────────────────────────

function parseVerdict(raw) {
  const type = raw.match(/<type>(.*?)<\/type>/s)?.[1]?.trim().toLowerCase();
  const confidence = raw.match(/<confidence>(.*?)<\/confidence>/s)?.[1]?.trim().toLowerCase();
  const reason = raw.match(/<reason>(.*?)<\/reason>/s)?.[1]?.trim();
  const agrees = raw.match(/<agrees_with_stored>(.*?)<\/agrees_with_stored>/s)?.[1]?.trim();
  return {
    type: VALID_TYPES.includes(type) ? type : null,
    confidence: confidence ?? 'unknown',
    reason: reason ?? '(none)',
    agrees: agrees === 'true',
  };
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function loadObservations(db, limit) {
  const rows = db.prepare(`
    SELECT id, type, title, subtitle, narrative, facts
    FROM observations
    WHERE type IS NOT NULL AND title IS NOT NULL
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);

  return rows.map(r => {
    let facts = [];
    try { facts = r.facts ? JSON.parse(r.facts) : []; } catch { facts = []; }
    // title/subtitle/narrative/facts are used only to build the judge prompt (sent to LLM)
    // but never written to the report file — keeping them here for prompt construction only
    return { ...r, facts };
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────

function buildReport(results, totalTokens, provider) {
  const disagreements = results.filter(r => !r.agrees && r.judgeType !== null);
  const errors = results.filter(r => r.error);
  const agreements = results.filter(r => r.agrees);

  const disagreeRate = ((disagreements.length / results.length) * 100).toFixed(1);

  // Correction matrix: stored_type → [proposed_type, count]
  const matrix = {};
  for (const r of disagreements) {
    const key = `${r.storedType} → ${r.judgeType}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
  }
  const matrixRows = Object.entries(matrix)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n');

  // Agreement rate by stored type
  const byType = {};
  for (const r of results) {
    if (r.error || r.judgeType === null) continue;
    if (!byType[r.storedType]) byType[r.storedType] = { agree: 0, total: 0 };
    byType[r.storedType].total++;
    if (r.agrees) byType[r.storedType].agree++;
  }
  const byTypeRows = Object.entries(byType)
    .sort(([, a], [, b]) => (a.agree/a.total) - (b.agree/b.total))
    .map(([t, s]) => `| ${t} | ${s.total} | ${s.agree} | ${((s.agree/s.total)*100).toFixed(0)}% |`)
    .join('\n');

  return `# Type Classification Judge — POC Report

**Date:** ${new Date().toISOString().split('T')[0]}
**Model:** ${provider.model}
**Sample:** ${results.length} observations (most recent)
**Total tokens:** ${totalTokens.toLocaleString()}

## Summary

| Metric | Value |
|--------|-------|
| Observations judged | ${results.length} |
| Agreements | ${agreements.length} (${((agreements.length/results.length)*100).toFixed(1)}%) |
| Disagreements | ${disagreements.length} (${disagreeRate}%) |
| Errors/invalid | ${errors.length} |

## Agreement Rate by Stored Type

| Stored Type | Total | Agree | Agreement % |
|-------------|-------|-------|-------------|
${byTypeRows}

## Correction Matrix (stored → judge)

| Correction | Count |
|------------|-------|
${matrixRows || '| — | — |'}

## Raw Results (IDs + types only — no content)

| ID | Stored | Judge | Confidence | Agrees |
|----|--------|-------|------------|--------|
${results.filter(r => !r.error).map(r =>
  `| ${r.id} | ${r.storedType} | ${r.judgeType ?? '❌'} | ${r.confidence} | ${r.agrees ? '✓' : '✗'} |`
).join('\n')}
`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const db = new Database(DB_PATH, { readonly: !APPLY });
  const provider = DRY_RUN ? { model: 'dry-run', baseUrl: '', apiKey: '' } : loadProviderConfig();

  console.log(`Type Classification Judge POC`);
  console.log(`Sample: ${SAMPLE} | Model: ${provider.model} | Dry-run: ${DRY_RUN}`);
  console.log('─'.repeat(60));

  const obs = loadObservations(db, SAMPLE);
  console.log(`Loaded ${obs.length} observations from DB`);

  const results = [];
  let totalTokens = 0;

  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    const pct = `[${(i+1).toString().padStart(3)}/${obs.length}]`;

    if (DRY_RUN) {
      console.log(`${pct} #${o.id} ${o.type}`);
      results.push({ id: o.id, storedType: o.type, judgeType: o.type, confidence: 'dry', agrees: true, error: false });
      continue;
    }

    process.stdout.write(`${pct} #${o.id} ${o.type.padEnd(10)}`);

    try {
      const prompt = buildJudgePrompt(o);
      const { content, inputTokens, outputTokens } = await callLLMWithRetry(provider, JUDGE_SYSTEM, prompt);
      totalTokens += inputTokens + outputTokens;

      const verdict = parseVerdict(content);
      const agrees = verdict.type === o.type || verdict.agrees;

      results.push({
        id: o.id,
        storedType: o.type,
        judgeType: verdict.type,
        confidence: verdict.confidence,
        agrees,
        error: false,
      });

      const marker = agrees ? '✓' : `✗ → ${verdict.type ?? '?'}`;
      console.log(` ${marker}`);
    } catch (err) {
      console.log(` ERROR: ${err.message.slice(0, 60)}`);
      results.push({ id: o.id, storedType: o.type, judgeType: null, confidence: 'error', agrees: false, error: true });
    }

    if (i < obs.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\n' + '─'.repeat(60));

  const disagreements = results.filter(r => !r.agrees && r.judgeType !== null);
  const disagreeRate = ((disagreements.length / results.length) * 100).toFixed(1);
  console.log(`Agreements: ${results.filter(r => r.agrees).length}/${results.length} (${(100 - parseFloat(disagreeRate)).toFixed(1)}%)`);
  console.log(`Disagreements: ${disagreements.length} (${disagreeRate}%)`);

  // Correction matrix summary
  const matrix = {};
  for (const r of disagreements) {
    const key = `${r.storedType} → ${r.judgeType}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
  }
  console.log('\nTop corrections:');
  Object.entries(matrix).sort(([,a],[,b]) => b-a).slice(0, 10).forEach(([k, v]) => {
    console.log(`  ${v.toString().padStart(3)}x  ${k}`);
  });

  const report = buildReport(results, totalTokens, provider);
  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(`\nReport written to ${REPORT_PATH}`);

  if (APPLY && disagreements.length > 0) {
    console.log('\n⚠️  --apply flag set. Writing corrections to DB...');
    const update = db.prepare('UPDATE observations SET type = ? WHERE id = ?');
    let corrected = 0;
    for (const r of disagreements) {
      if (r.confidence === 'high' && r.judgeType && VALID_TYPES.includes(r.judgeType)) {
        update.run(r.judgeType, r.id);
        corrected++;
      }
    }
    console.log(`Corrected ${corrected} high-confidence disagreements.`);
  }

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
