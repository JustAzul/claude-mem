/**
 * Implicit Signal Computer
 *
 * Computes file_reuse and content_cited signals for memory_assist_decisions
 * by inspecting post-injection tool calls and assistant messages.
 *
 * Pure computation: no DB writes. Use persistImplicitSignals to write.
 */

import type { Database } from 'bun:sqlite';
import { extractIdentifiers } from './identifier-extractor.js';

export interface ImplicitSignalRow {
  observation_id: number;
  signal_kind: 'file_reuse' | 'content_cited' | 'no_overlap';
  evidence: string | null;
  confidence: number;
}

export interface ComputeInput {
  decisionId: number;
  contentSessionId: string;
  injectedAtEpoch: number;
  injectedObservationIds: number[];
  windowMs?: number;       // default 30 * 60 * 1000
  maxToolCalls?: number;   // default 10
}

interface ObservationRow {
  id: number;
  title: string | null;
  narrative: string | null;
  facts: string | null;
  files_read: string | null;
  files_modified: string | null;
}

interface PendingMessageRow {
  tool_name: string | null;
  tool_input: string | null;
  last_assistant_message: string | null;
}

// Snapshot row from observation_capture_snapshots — persistent equivalent of
// pending_messages. The snapshot persists after pending_messages are deleted
// post-processing, so it is the correct source for post-hoc analysis.
interface SnapshotRow {
  tool_name: string | null;
  tool_input: string | null;
  prior_assistant_message: string | null;
}

const STRIP_PROJECT_RE = /^(?:\.\/|\/home\/[^/]+\/projects\/[^/]+\/)/;

function normalizePath(p: string): string {
  return p.replace(STRIP_PROJECT_RE, '').toLowerCase();
}

function basename(p: string): string {
  return p.split('/').pop()?.toLowerCase() ?? p.toLowerCase();
}

function extractToolFilePaths(row: PendingMessageRow): string[] {
  const paths: string[] = [];
  if (!row.tool_input) return paths;

  let toolInput: Record<string, unknown>;
  try {
    toolInput = JSON.parse(row.tool_input) as Record<string, unknown>;
  } catch {
    return paths;
  }

  const toolName = row.tool_name ?? '';

  // Tools that carry file_path directly
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
    const fp = toolInput['file_path'];
    if (typeof fp === 'string') paths.push(fp);
  }

  // Grep — path is optional, single or dir
  if (toolName === 'Grep') {
    const p = toolInput['path'];
    if (typeof p === 'string') paths.push(p);
  }

  // Glob — path (dir) + pattern as path hint
  if (toolName === 'Glob') {
    const p = toolInput['path'];
    if (typeof p === 'string') paths.push(p);
    // pattern may hint at file extension
    const pat = toolInput['pattern'];
    if (typeof pat === 'string') {
      const ext = /\.(?:ts|tsx|js|jsx|py|go|rs|md|json|yaml|yml|toml)\b/.exec(pat);
      if (ext) paths.push(pat);
    }
  }

  // Bash — extract file paths from command string
  if (toolName === 'Bash') {
    const cmd = toolInput['command'];
    if (typeof cmd === 'string') {
      const fileRe = /[^\s'"]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json|yaml|yml|toml)\b/g;
      let m: RegExpExecArray | null;
      while ((m = fileRe.exec(cmd)) !== null) {
        paths.push(m[0]);
      }
    }
  }

  return paths;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [];
  } catch {
    return [];
  }
}

function checkFileReuse(
  obs: ObservationRow,
  toolMessages: PendingMessageRow[]
): { evidence: string; confidence: number } | null {
  const obsFiles: string[] = [
    ...parseJsonArray(obs.files_read),
    ...parseJsonArray(obs.files_modified),
  ];

  if (obsFiles.length === 0) return null;

  const obsNormalized = obsFiles.map(normalizePath);
  const obsBasenames = obsFiles.map(basename);

  for (const msg of toolMessages) {
    const toolPaths = extractToolFilePaths(msg);
    for (const tp of toolPaths) {
      const tpNorm = normalizePath(tp);
      const tpBase = basename(tp);

      // Absolute/normalized match
      for (let i = 0; i < obsNormalized.length; i++) {
        if (tpNorm && obsNormalized[i] && tpNorm === obsNormalized[i]) {
          return { evidence: tp, confidence: 1.0 };
        }
      }

      // Basename fallback
      for (let i = 0; i < obsBasenames.length; i++) {
        if (tpBase && obsBasenames[i] && tpBase === obsBasenames[i]) {
          return { evidence: tp, confidence: 0.7 };
        }
      }
    }
  }

  return null;
}

function checkContentCited(
  obs: ObservationRow,
  assistantMessages: PendingMessageRow[]
): { evidence: string; confidence: number } | null {
  const sourceText = [
    obs.title ?? '',
    obs.narrative ?? '',
    obs.facts ?? '',
  ].join(' ');

  const candidates = extractIdentifiers(sourceText);
  if (candidates.length === 0) return null;

  const haystack = assistantMessages
    .map((m) => m.last_assistant_message ?? '')
    .join(' ')
    .toLowerCase();

  if (!haystack.trim()) return null;

  for (const candidate of candidates) {
    if (haystack.includes(candidate)) {
      return { evidence: candidate, confidence: 0.7 };
    }
  }

  return null;
}

/**
 * Compute implicit signals for a decision. Pure — does not write to DB.
 * Returns one row per (decision_id, observation_id) pair.
 */
export function computeImplicitSignals(
  db: Database,
  input: ComputeInput
): ImplicitSignalRow[] {
  const {
    contentSessionId,
    injectedAtEpoch,
    injectedObservationIds,
    windowMs = 30 * 60 * 1000,
    maxToolCalls = 10,
  } = input;

  if (injectedObservationIds.length === 0) return [];

  const windowEnd = injectedAtEpoch + windowMs;

  // Source: observation_capture_snapshots — persists after pending_messages are
  // deleted post-processing. Carries tool_name, tool_input, prior_assistant_message.
  // We map prior_assistant_message → last_assistant_message so downstream checks
  // (checkFileReuse, checkContentCited) keep a stable shape.
  const snapshots = db.prepare(`
    SELECT tool_name, tool_input, prior_assistant_message
    FROM observation_capture_snapshots
    WHERE content_session_id = ?
      AND created_at_epoch > ?
      AND created_at_epoch <= ?
    ORDER BY created_at_epoch ASC
    LIMIT ?
  `).all(contentSessionId, injectedAtEpoch, windowEnd, maxToolCalls) as SnapshotRow[];

  const toolMessages: PendingMessageRow[] = snapshots.map((s) => ({
    tool_name: s.tool_name,
    tool_input: s.tool_input,
    last_assistant_message: s.prior_assistant_message,
  }));

  // Assistant messages: same snapshot rows, filtered to those with assistant text.
  const assistantMessages: PendingMessageRow[] = toolMessages
    .filter((m) => !!m.last_assistant_message)
    .slice(0, 3);

  const results: ImplicitSignalRow[] = [];

  for (const obsId of injectedObservationIds) {
    const obs = db.prepare(`
      SELECT id, title, narrative, facts, files_read, files_modified
      FROM observations
      WHERE id = ?
    `).get(obsId) as ObservationRow | undefined;

    if (!obs) continue;

    // 1. file_reuse check
    const fileReuseHit = checkFileReuse(obs, toolMessages);
    if (fileReuseHit) {
      results.push({
        observation_id: obsId,
        signal_kind: 'file_reuse',
        evidence: fileReuseHit.evidence,
        confidence: fileReuseHit.confidence,
      });
      continue;
    }

    // 2. content_cited check
    const citedHit = checkContentCited(obs, assistantMessages);
    if (citedHit) {
      results.push({
        observation_id: obsId,
        signal_kind: 'content_cited',
        evidence: citedHit.evidence,
        confidence: citedHit.confidence,
      });
      continue;
    }

    // 3. no_overlap
    results.push({
      observation_id: obsId,
      signal_kind: 'no_overlap',
      evidence: null,
      confidence: 1.0,
    });
  }

  return results;
}

/**
 * Batch write signals. Skips pairs that already have a row (idempotent).
 */
export function persistImplicitSignals(
  db: Database,
  decisionId: number,
  signals: ImplicitSignalRow[]
): void {
  if (signals.length === 0) return;

  // Check which (decision_id, observation_id) pairs already exist
  const existingPairs = new Set<string>();
  const existingRows = db.prepare(`
    SELECT decision_id, observation_id
    FROM memory_implicit_signals
    WHERE decision_id = ?
  `).all(decisionId) as Array<{ decision_id: number; observation_id: number }>;

  for (const row of existingRows) {
    existingPairs.add(`${row.decision_id}:${row.observation_id}`);
  }

  const insert = db.prepare(`
    INSERT INTO memory_implicit_signals
      (decision_id, observation_id, signal_kind, evidence, confidence, computed_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  for (const signal of signals) {
    const key = `${decisionId}:${signal.observation_id}`;
    if (existingPairs.has(key)) continue;

    insert.run(
      decisionId,
      signal.observation_id,
      signal.signal_kind,
      signal.evidence ?? null,
      signal.confidence,
      now
    );
  }
}
