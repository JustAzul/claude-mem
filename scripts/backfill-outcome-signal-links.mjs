#!/usr/bin/env bun
// Backfill: relink orphan memory_assist_outcome_signals (decision_id IS NULL) to
// memory_assist_decisions using SessionStore.resolveMemoryAssistDecisionId.
//
// Root cause: before this fix, resolveMemoryAssistDecisionId required exactly one
// candidate decision in the 15-min window. Active sessions commonly had 5+, so
// most tool-call signals were stored unlinked — starving the judge of inputs.
//
// This script is idempotent. Rerunning it after the first pass is a no-op on
// already-linked rows. Safe to run multiple times.
//
// Usage:
//   bun scripts/backfill-outcome-signal-links.mjs            (apply)
//   bun scripts/backfill-outcome-signal-links.mjs --dry-run  (plan only)
//   bun scripts/backfill-outcome-signal-links.mjs --since-days 7  (default 7)

import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/services/sqlite/SessionStore.ts';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const sinceDaysIdx = args.indexOf('--since-days');
const SINCE_DAYS = sinceDaysIdx >= 0 && args[sinceDaysIdx + 1]
  ? Math.max(1, parseInt(args[sinceDaysIdx + 1], 10))
  : 7;

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const sinceEpoch = Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000;

console.log(`[backfill] db=${DB_PATH}`);
console.log(`[backfill] window=${SINCE_DAYS}d (since ${new Date(sinceEpoch).toISOString()})`);
console.log(`[backfill] mode=${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
console.log('');

const store = new SessionStore(DB_PATH);

const orphanIds = store.listOrphanOutcomeSignalIds(sinceEpoch);
console.log(`[backfill] orphan signals in window: ${orphanIds.length}`);

if (orphanIds.length === 0) {
  console.log('[backfill] nothing to do.');
  store.close();
  process.exit(0);
}

let linked = 0;
let stillOrphan = 0;
const touchedDecisionIds = new Set();
const touchedSignalIds = [];

for (const signalId of orphanIds) {
  if (DRY_RUN) {
    // Dry run: peek at the resolver result via relink (it still writes on match).
    // To avoid writes, we can't easily reuse relinkOrphanOutcomeSignal without a
    // rollback. Instead, skip dry-run simulation and only print the plan size.
    continue;
  }
  const decisionId = store.relinkOrphanOutcomeSignal(signalId);
  if (decisionId) {
    linked++;
    touchedDecisionIds.add(decisionId);
    touchedSignalIds.push(signalId);
  } else {
    stillOrphan++;
  }
}

if (DRY_RUN) {
  console.log(`[backfill] DRY RUN: would attempt to relink ${orphanIds.length} orphan signals.`);
  console.log('[backfill] no writes performed.');
  store.close();
  process.exit(0);
}

console.log('');
console.log(`[backfill] linked:        ${linked}`);
console.log(`[backfill] still orphan:  ${stillOrphan}`);
console.log(`[backfill] touched decisions: ${touchedDecisionIds.size}`);

// Judge rerun for every touched decision so verdicts update now that new signals
// are visible.
let verdictsRefreshed = 0;
for (const decisionId of touchedDecisionIds) {
  const result = store.refreshMemoryAssistDecisionVerdict(decisionId);
  if (result) verdictsRefreshed++;
}
console.log(`[backfill] verdicts refreshed: ${verdictsRefreshed}`);

console.log('');
console.log('[backfill] touched signal ids (for targeted rollback if needed):');
// Print in chunks so a large list doesn't blow up the terminal
for (let i = 0; i < touchedSignalIds.length; i += 20) {
  console.log('  ' + touchedSignalIds.slice(i, i + 20).join(','));
}

store.close();
console.log('');
console.log('[backfill] done.');
