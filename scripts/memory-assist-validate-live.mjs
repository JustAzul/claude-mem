#!/usr/bin/env node

import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const BUN = process.env.BUN_PATH || 'bun';
const WORKER_URL = process.env.CLAUDE_MEM_WORKER_URL || 'http://127.0.0.1:37777';
const WORKER_SCRIPT = path.join(ROOT, 'plugin', 'scripts', 'worker-service.cjs');
const PROJECT = 'claude-mem-calibration-scratch';
const SCRATCH_DIR = path.join(tmpdir(), PROJECT);
const FILE_REL = 'src/example/service.ts';
const FILE_ABS = path.join(SCRATCH_DIR, FILE_REL);
const WINDOW_DAYS = 30;
const MAX_WAIT_MS = 120_000;
const POLL_MS = 2_000;
const SEED_PROMPT = 'Record the synthetic timeout handling pattern so later prompts can reuse it safely.';
const FILE_PROMPT = 'Inspect the synthetic timeout service before editing it, and keep the public API stable.';
const SEMANTIC_INJECT_PROMPT = SEED_PROMPT;
const SEMANTIC_SKIP_PROMPT = 'Summarize the Synthetic Timeout Handling Pattern and explain why it keeps the public API unchanged.';

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function fail(message, detail) {
  out(`FAIL: ${message}`);
  if (detail) out(detail);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

async function getJson(route, init) {
  const response = await fetch(`${WORKER_URL}${route}`, init);
  if (!response.ok) {
    throw new Error(`${route} returned ${response.status}`);
  }
  return response.json();
}

async function ensureWorkerHealthy({ prepare = false } = {}) {
  try {
    await getJson('/health');
    return;
  } catch (error) {
    if (!prepare) {
      fail('Worker is not healthy. Re-run with --prepare or start the worker first.', String(error));
    }
  }

  out('Preparing worker: build -> sync -> restart');
  for (const [command, args] of [
    ['npm', ['run', 'build']],
    ['npm', ['run', 'sync-marketplace:force']],
    [BUN, [WORKER_SCRIPT, 'restart']],
  ]) {
    const result = run(command, args);
    if (result.status !== 0) {
      fail(`Preparation command failed: ${command} ${args.join(' ')}`, result.stderr || result.stdout);
    }
  }

  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      await getJson('/health');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  fail('Worker did not become healthy after prepare.');
}

function runHook(event, payload) {
  const result = run(BUN, [WORKER_SCRIPT, 'hook', 'raw', event], {
    input: JSON.stringify(payload),
  });
  if (result.status !== 0) {
    fail(`Hook failed: ${event}`, result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

function prepareScratchProject() {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(FILE_ABS), { recursive: true });
  const repeatedComment = Array.from({ length: 48 }, (_, index) => `// synthetic-timeout-note-${index}: keep the public API stable while varying internal timeout behavior.`).join('\n');
  writeFileSync(
    FILE_ABS,
    [
      'export interface TimeoutPolicy {',
      '  timeoutMs: number;',
      "  mode: 'interactive' | 'background';",
      '}',
      '',
      'export function createTimeoutPolicy(timeoutMs = 5000): TimeoutPolicy {',
      "  return { timeoutMs, mode: 'interactive' };",
      '}',
      '',
      'export function normalizeTimeoutLabel(policy: TimeoutPolicy): string {',
      "  return `${policy.mode}:${policy.timeoutMs}`;",
      '}',
      '',
      repeatedComment,
      '',
    ].join('\n'),
    'utf8'
  );
}

async function waitFor(label, predicate, timeoutMs = MAX_WAIT_MS) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  fail(`Timed out waiting for ${label}`, lastError ? String(lastError) : undefined);
}

async function getDecisions(filters = {}) {
  const params = new URLSearchParams({
    limit: '50',
    days: String(WINDOW_DAYS),
  });
  for (const [key, value] of Object.entries(filters)) {
    if (value != null && value !== '') {
      params.set(key, String(value));
    }
  }
  const payload = await getJson(`/api/memory-assist/decisions?${params.toString()}`);
  return payload.decisions ?? [];
}

async function waitForDecision(label, predicate) {
  return waitFor(label, async () => {
    const decisions = await getDecisions({ project: PROJECT });
    return decisions.find(predicate) ?? null;
  });
}

async function waitForDecisionOrFail(label, filters, successPredicate, terminalFailurePredicate) {
  return waitFor(label, async () => {
    const decisions = await getDecisions({ project: PROJECT, ...filters });
    const success = decisions.find(successPredicate);
    if (success) {
      return success;
    }
    const terminalFailure = decisions.find(terminalFailurePredicate);
    if (terminalFailure) {
      fail(
        `${label} hit a terminal skip instead of succeeding.`,
        JSON.stringify({
          id: terminalFailure.id,
          source: terminalFailure.source,
          status: terminalFailure.status,
          reason: terminalFailure.reason,
          contentSessionId: terminalFailure.contentSessionId,
        }, null, 2)
      );
    }
    return null;
  });
}

async function waitForObservationSeed() {
  return waitFor('seeded file observations', async () => {
    const params = new URLSearchParams({
      path: FILE_REL,
      projects: PROJECT,
      limit: '10',
    });
    const payload = await getJson(`/api/observations/by-file?${params.toString()}`);
    return (payload.count ?? 0) > 0 ? payload : null;
  });
}

async function assertOriginLink(observationId, pendingMessageId) {
  const origin = await getJson(`/api/observations/${observationId}/origin`);
  if ((origin.pendingMessageId ?? null) !== (pendingMessageId ?? null)) {
    fail(
      `Origin link mismatch for observation #${observationId}`,
      `Expected pendingMessageId=${pendingMessageId ?? 'null'}, got ${origin.pendingMessageId ?? 'null'}`
    );
  }
}

function buildSessionId(prefix, runId) {
  return `${prefix}-${runId}`;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const prepare = args.has('--prepare');
  const runId = Date.now();

  await ensureWorkerHealthy({ prepare });

  const settings = await getJson('/api/settings');
  if (String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() !== 'true') {
    fail('CLAUDE_MEM_SEMANTIC_INJECT must be enabled before running live calibration validation.');
  }

  prepareScratchProject();

  const seedSession = buildSessionId('validation-seed', runId);
  const fileSession = buildSessionId('validation-file', runId);
  const semanticInjectSession = buildSessionId('validation-semantic-inject', runId);
  const semanticSkipSession = buildSessionId('validation-semantic-skip', runId);

  out('Seeding synthetic file observations through the real hook path');
  runHook('session-init', {
    sessionId: seedSession,
    cwd: SCRATCH_DIR,
    prompt: SEED_PROMPT,
  });
  runHook('observation', {
    sessionId: seedSession,
    cwd: SCRATCH_DIR,
    toolName: 'Read',
    toolInput: { file_path: FILE_REL },
    toolResponse: 'Observed createTimeoutPolicy returning an interactive timeout policy with a stable public shape.',
  });
  runHook('observation', {
    sessionId: seedSession,
    cwd: SCRATCH_DIR,
    toolName: 'Edit',
    toolInput: {
      file_path: FILE_REL,
      old_string: "return { timeoutMs, mode: 'interactive' };",
      new_string: "return { timeoutMs, mode: 'interactive' };",
    },
    toolResponse: 'Confirmed the synthetic timeout policy keeps the public API shape unchanged while preserving the interactive mode.',
  });
  await waitForObservationSeed();
  const olderThanMemory = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(FILE_ABS, olderThanMemory, olderThanMemory);

  out('Triggering file memory and follow-up tool actions');
  runHook('session-init', {
    sessionId: fileSession,
    cwd: SCRATCH_DIR,
    prompt: FILE_PROMPT,
  });
  runHook('file-context', {
    sessionId: fileSession,
    cwd: SCRATCH_DIR,
    toolName: 'Read',
    toolInput: { file_path: FILE_REL },
  });

  const fileDecision = await waitForDecisionOrFail(
    'file_context inject',
    { contentSessionId: fileSession },
    (decision) => decision.contentSessionId === fileSession && decision.source === 'file_context' && decision.status === 'injected',
    (decision) => decision.contentSessionId === fileSession && decision.source === 'file_context' && decision.status === 'skipped'
  );

  runHook('observation', {
    sessionId: fileSession,
    cwd: SCRATCH_DIR,
    toolName: 'Read',
    toolInput: { file_path: FILE_REL },
    toolResponse: 'Re-read the synthetic timeout policy to confirm the same target before editing.',
  });
  runHook('observation', {
    sessionId: fileSession,
    cwd: SCRATCH_DIR,
    toolName: 'Edit',
    toolInput: {
      file_path: FILE_REL,
      old_string: "return `${policy.mode}:${policy.timeoutMs}`;",
      new_string: "return `${policy.mode}:${policy.timeoutMs}`;",
    },
    toolResponse: 'Adjusted the synthetic timeout label formatting without changing the public API shape.',
  });

  const likelyHelpedFileDecision = await waitForDecision(
    'file_context likely_helped verdict with exact observation linkage',
    (decision) =>
      decision.id === fileDecision.id
      && decision.systemVerdict === 'likely_helped'
      && (decision.systemEvidence?.usedOutcomes ?? []).some(
        (outcome) => outcome.signalSource === 'exact_observation_link' && (outcome.generatedObservationIds?.length ?? 0) > 0
      )
  );

  const exactUsedOutcome = (likelyHelpedFileDecision.systemEvidence?.usedOutcomes ?? [])
    .find((outcome) => outcome.signalSource === 'exact_observation_link' && (outcome.generatedObservationIds?.length ?? 0) > 0);
  if (!exactUsedOutcome) {
    fail('Expected a likely_helped file_context decision with exact observation linkage evidence.');
  }
  await assertOriginLink(exactUsedOutcome.generatedObservationIds[0], exactUsedOutcome.pendingMessageId ?? null);

  out('Triggering semantic prompt injection');
  runHook('session-init', {
    sessionId: semanticInjectSession,
    cwd: SCRATCH_DIR,
    prompt: SEMANTIC_INJECT_PROMPT,
  });

  await waitForDecisionOrFail(
    'semantic_prompt inject',
    { contentSessionId: semanticInjectSession },
    (decision) => decision.contentSessionId === semanticInjectSession && decision.source === 'semantic_prompt' && decision.status === 'injected',
    (decision) =>
      decision.contentSessionId === semanticInjectSession
      && decision.source === 'semantic_prompt'
      && (decision.status === 'error' || decision.status === 'skipped')
  );

  out('Triggering semantic prompt skip');
  runHook('session-init', {
    sessionId: semanticSkipSession,
    cwd: SCRATCH_DIR,
    prompt: SEMANTIC_SKIP_PROMPT,
  });

  await waitForDecisionOrFail(
    'semantic_prompt skip',
    { contentSessionId: semanticSkipSession },
    (decision) =>
      decision.contentSessionId === semanticSkipSession
      && decision.source === 'semantic_prompt'
      && decision.status === 'skipped'
      && decision.reason === 'below_threshold',
    (decision) =>
      decision.contentSessionId === semanticSkipSession
      && decision.source === 'semantic_prompt'
      && (
        decision.status === 'error'
        || decision.status === 'injected'
        || (decision.status === 'skipped' && decision.reason !== 'below_threshold')
      )
  );

  const stats = await getJson(`/api/memory-assist/stats?days=${WINDOW_DAYS}`);
  const decisions = await getDecisions({ project: PROJECT });

  const hasSemanticInject = decisions.some((decision) =>
    decision.contentSessionId === semanticInjectSession
    && decision.source === 'semantic_prompt'
    && decision.status === 'injected'
  );
  const hasSemanticSkip = decisions.some((decision) =>
    decision.contentSessionId === semanticSkipSession
    && decision.source === 'semantic_prompt'
    && decision.status === 'skipped'
  );
  const hasFileInject = decisions.some((decision) =>
    decision.contentSessionId === fileSession
    && decision.source === 'file_context'
    && decision.status === 'injected'
  );
  const hasLikelyHelpedExactLink = decisions.some((decision) =>
    decision.contentSessionId === fileSession
    && decision.systemVerdict === 'likely_helped'
    && (decision.systemEvidence?.usedOutcomes ?? []).some((outcome) => outcome.signalSource === 'exact_observation_link')
  );
  const hasShadowRanking = (stats.shadowRanking?.totalCompared ?? 0) > 0;

  const checks = [
    ['semantic_prompt inject', hasSemanticInject],
    ['semantic_prompt skip', hasSemanticSkip],
    ['file_context inject', hasFileInject],
    ['likely_helped with exact-link evidence', hasLikelyHelpedExactLink],
    ['shadowRanking populated', hasShadowRanking],
  ];

  const failures = checks.filter(([, ok]) => !ok);
  if (failures.length > 0) {
    const detail = failures.map(([label]) => `- missing: ${label}`).join('\n');
    fail('Live validation did not observe all required runtime invariants.', detail);
  }

  out('');
  out('PASS: live memory-assist validation observed the required runtime invariants.');
  for (const [label] of checks) {
    out(`- ${label}`);
  }
  out('');
  out(`Project: ${PROJECT}`);
  out(`Scratch directory: ${SCRATCH_DIR}`);
  out(`Validated against: ${WORKER_URL}/api/memory-assist/stats?days=${WINDOW_DAYS}`);
}

main().catch((error) => {
  fail('Unhandled validation error.', error instanceof Error ? error.stack || error.message : String(error));
});
