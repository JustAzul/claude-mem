import { Database } from 'bun:sqlite';
import type {
  MemoryAssistDecisionRecord,
  MemoryAssistFeedbackLabel,
  MemoryAssistReport,
  MemoryAssistShadowRanking,
  MemoryAssistSystemEvidence,
  MemoryAssistSystemVerdict,
  MemoryAssistTraceItem,
} from '../../../shared/memory-assist.js';
import { logger } from '../../../utils/logger.js';

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

interface DecisionRow {
  id: number;
  source: MemoryAssistDecisionRecord['source'];
  status: MemoryAssistDecisionRecord['status'];
  reason: string;
  project: string | null;
  platform_source: string | null;
  session_db_id: number | null;
  content_session_id: string | null;
  prompt_number: number | null;
  threshold: number | null;
  best_distance: number | null;
  worst_distance: number | null;
  candidate_count: number | null;
  selected_count: number | null;
  prompt_length: number | null;
  file_path: string | null;
  message: string | null;
  estimated_injected_tokens: number | null;
  trace_items_json: string | null;
  selected_ids_json: string | null;
  shadow_ranking_json: string | null;
  system_verdict: MemoryAssistSystemVerdict | null;
  system_confidence: number | null;
  system_reasons_json: string | null;
  system_evidence_json: string | null;
  user_feedback: MemoryAssistFeedbackLabel | null;
  created_at_epoch: number;
  updated_at_epoch: number;
}

export function ensureMemoryAssistDecisionsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_assist_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      project TEXT,
      platform_source TEXT,
      session_db_id INTEGER,
      content_session_id TEXT,
      prompt_number INTEGER,
      threshold REAL,
      best_distance REAL,
      worst_distance REAL,
      candidate_count INTEGER,
      selected_count INTEGER,
      prompt_length INTEGER,
      file_path TEXT,
      message TEXT,
      estimated_injected_tokens INTEGER,
      trace_items_json TEXT,
      shadow_ranking_json TEXT,
      system_verdict TEXT,
      system_confidence REAL,
      system_reasons_json TEXT,
      system_evidence_json TEXT,
      user_feedback TEXT,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_created ON memory_assist_decisions(created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_source ON memory_assist_decisions(source, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_content_session ON memory_assist_decisions(content_session_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_assist_decisions_project ON memory_assist_decisions(project, created_at_epoch DESC)');
  const columns = db.query('PRAGMA table_info(memory_assist_decisions)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'prompt_number')) {
    db.run('ALTER TABLE memory_assist_decisions ADD COLUMN prompt_number INTEGER');
  }
  if (!columns.some((column) => column.name === 'system_evidence_json')) {
    db.run('ALTER TABLE memory_assist_decisions ADD COLUMN system_evidence_json TEXT');
  }
  if (!columns.some((column) => column.name === 'selected_ids_json')) {
    db.run('ALTER TABLE memory_assist_decisions ADD COLUMN selected_ids_json TEXT');
  }
}

function hydrateDecision(row: DecisionRow): MemoryAssistDecisionRecord {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    reason: row.reason,
    timestamp: row.created_at_epoch,
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch,
    project: row.project ?? undefined,
    platformSource: row.platform_source ?? undefined,
    sessionDbId: row.session_db_id ?? undefined,
    contentSessionId: row.content_session_id ?? undefined,
    promptNumber: row.prompt_number ?? undefined,
    threshold: row.threshold ?? undefined,
    bestDistance: row.best_distance,
    worstDistance: row.worst_distance,
    candidateCount: row.candidate_count ?? undefined,
    selectedCount: row.selected_count ?? undefined,
    promptLength: row.prompt_length ?? undefined,
    filePath: row.file_path ?? undefined,
    message: row.message ?? undefined,
    estimatedInjectedTokens: row.estimated_injected_tokens ?? undefined,
    traceItems: parseJson<MemoryAssistTraceItem[]>(row.trace_items_json, []),
    selectedIds: parseJson<number[]>(row.selected_ids_json, []) || undefined,
    shadowRanking: parseJson<MemoryAssistShadowRanking | null>(row.shadow_ranking_json, null),
    systemVerdict: row.system_verdict,
    systemConfidence: row.system_confidence,
    systemReasons: parseJson<string[]>(row.system_reasons_json, []),
    systemEvidence: parseJson<MemoryAssistSystemEvidence | null>(row.system_evidence_json, null),
    userFeedback: row.user_feedback,
  };
}

export function recordMemoryAssistDecision(
  db: Database,
  report: MemoryAssistReport & {
    shadowRanking?: MemoryAssistShadowRanking | null;
    systemVerdict?: MemoryAssistSystemVerdict | null;
    systemConfidence?: number | null;
    systemReasons?: string[];
    systemEvidence?: MemoryAssistSystemEvidence | null;
  }
): MemoryAssistDecisionRecord {
  const now = report.timestamp ?? Date.now();
  logger.debug(`[memory-assist-decisions] recording ${report.source}/${report.status} decision (${report.reason})`);
  const insert = db.prepare(`
    INSERT INTO memory_assist_decisions (
      source,
      status,
      reason,
      project,
      platform_source,
      session_db_id,
      content_session_id,
      prompt_number,
      threshold,
      best_distance,
      worst_distance,
      candidate_count,
      selected_count,
      prompt_length,
      file_path,
      message,
      estimated_injected_tokens,
      trace_items_json,
      selected_ids_json,
      shadow_ranking_json,
      system_verdict,
      system_confidence,
      system_reasons_json,
      system_evidence_json,
      user_feedback,
      created_at_epoch,
      updated_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    report.source,
    report.status,
    report.reason,
    report.project ?? null,
    report.platformSource ?? null,
    report.sessionDbId ?? null,
    report.contentSessionId ?? null,
    report.promptNumber ?? null,
    report.threshold ?? null,
    report.bestDistance ?? null,
    report.worstDistance ?? null,
    report.candidateCount ?? null,
    report.selectedCount ?? null,
    report.promptLength ?? null,
    report.filePath ?? null,
    report.message ?? null,
    report.estimatedInjectedTokens ?? null,
    serializeJson(report.traceItems ?? []),
    serializeJson(report.selectedIds ?? null),
    serializeJson(report.shadowRanking ?? null),
    report.systemVerdict ?? null,
    report.systemConfidence ?? null,
    serializeJson(report.systemReasons ?? []),
    serializeJson(report.systemEvidence ?? null),
    report.userFeedback ?? null,
    now,
    now
  );
  const decision = getMemoryAssistDecisionById(db, Number(result.lastInsertRowid))!;
  logger.debug(`[memory-assist-decisions] stored decision ${decision.id ?? 'unknown'}`);
  return decision;
}

export function getMemoryAssistDecisionById(
  db: Database,
  id: number
): MemoryAssistDecisionRecord | null {
  const row = db.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE id = ?
  `).get(id) as DecisionRow | undefined;

  return row ? hydrateDecision(row) : null;
}

export function getRecentMemoryAssistDecisions(
  db: Database,
  options: {
    limit?: number;
    windowDays?: number;
    source?: MemoryAssistDecisionRecord['source'];
    project?: string;
    contentSessionId?: string;
  } = {}
): MemoryAssistDecisionRecord[] {
  // Cap at 10k rather than 200: the dashboard loads the full window into memory
  // for aggregate stats and the old 200-row clamp silently truncated the sample,
  // making a 30-day dashboard report stats over only ~200 of ~750 decisions.
  // The 10k ceiling still protects against unbounded queries but covers realistic
  // project sizes. (Audit: /api/memory-assist/dashboard was reporting injected=10
  // against a raw count of 42 claude-mem injections in the same 30d window.)
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 10_000);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.windowDays) {
    conditions.push('created_at_epoch >= ?');
    params.push(Date.now() - options.windowDays * 24 * 60 * 60 * 1000);
  }
  if (options.source) {
    conditions.push('source = ?');
    params.push(options.source);
  }
  if (options.project) {
    conditions.push('project = ?');
    params.push(options.project);
  }
  if (options.contentSessionId) {
    conditions.push('content_session_id = ?');
    params.push(options.contentSessionId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT *
    FROM memory_assist_decisions
    ${whereClause}
    ORDER BY created_at_epoch DESC
    LIMIT ${limit}
  `).all(...params) as DecisionRow[];

  const decisions = rows.map(hydrateDecision);
  logger.debug(`[memory-assist-decisions] loaded ${decisions.length} recent decisions (limit=${limit})`);
  return decisions;
}

export function getLatestDecisionForContentSession(
  db: Database,
  contentSessionId: string,
  withinMs: number
): MemoryAssistDecisionRecord | null {
  const sinceEpoch = Date.now() - withinMs;
  const row = db.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE content_session_id = ?
      AND created_at_epoch >= ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `).get(contentSessionId, sinceEpoch) as DecisionRow | undefined;

  return row ? hydrateDecision(row) : null;
}

export function getMemoryAssistDecisionsForPrompt(
  db: Database,
  contentSessionId: string,
  promptNumber: number,
  withinMs: number,
  referenceEpoch: number = Date.now()
): MemoryAssistDecisionRecord[] {
  // Past window with small forward drift tolerance: decisions are written
  // before the signal that resolves them, so only past rows are valid
  // candidates. A symmetric [ref-withinMs, ref+withinMs] window would double
  // the effective span and raise cross-prompt collisions on rapid re-prompting.
  // 100ms forward tolerance absorbs clock drift / batched writes where the
  // decision's epoch can land microseconds after referenceEpoch. Keeping it
  // tight (vs 1s) prevents bleeding into the next prompt on rapid re-prompting.
  const DRIFT_TOLERANCE_MS = 100;
  const sinceEpoch = referenceEpoch - withinMs;
  const untilEpoch = referenceEpoch + DRIFT_TOLERANCE_MS;
  const rows = db.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE content_session_id = ?
      AND prompt_number = ?
      AND created_at_epoch >= ?
      AND created_at_epoch <= ?
    ORDER BY created_at_epoch DESC
  `).all(contentSessionId, promptNumber, sinceEpoch, untilEpoch) as DecisionRow[];

  return rows.map(hydrateDecision);
}

export function updateMemoryAssistDecisionVerdict(
  db: Database,
  decisionId: number,
  verdict: MemoryAssistSystemVerdict | null,
  confidence: number | null,
  reasons: string[],
  evidence: MemoryAssistSystemEvidence | null
): void {
  db.prepare(`
    UPDATE memory_assist_decisions
    SET system_verdict = ?,
        system_confidence = ?,
        system_reasons_json = ?,
        system_evidence_json = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `).run(
    verdict,
    confidence,
    serializeJson(reasons),
    serializeJson(evidence),
    Date.now(),
    decisionId
  );
}

export function attachMemoryAssistDecisionFeedback(
  db: Database,
  decisionId: number,
  label: MemoryAssistFeedbackLabel
): void {
  db.prepare(`
    UPDATE memory_assist_decisions
    SET user_feedback = ?,
        updated_at_epoch = ?
    WHERE id = ?
  `).run(label, Date.now(), decisionId);
}

export function getRecentlyInjectedIds(
  db: Database,
  contentSessionId: string,
  currentPromptNumber: number,
  windowSize: number
): Set<number> {
  const minPrompt = currentPromptNumber - windowSize;
  const rows = db.prepare(`
    SELECT selected_ids_json
    FROM memory_assist_decisions
    WHERE content_session_id = ?
      AND status = 'injected'
      AND prompt_number >= ?
      AND prompt_number < ?
  `).all(contentSessionId, minPrompt, currentPromptNumber) as Array<{ selected_ids_json: string | null }>;

  const ids = new Set<number>();
  for (const row of rows) {
    const parsed = parseJson<number[]>(row.selected_ids_json, []);
    for (const id of parsed) {
      if (Number.isFinite(id) && id > 0) ids.add(id);
    }
  }
  return ids;
}

export function getDecisionRowsForIds(
  db: Database,
  decisionIds: number[]
): MemoryAssistDecisionRecord[] {
  if (decisionIds.length === 0) return [];
  const placeholders = decisionIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM memory_assist_decisions
    WHERE id IN (${placeholders})
  `).all(...decisionIds) as DecisionRow[];
  return rows.map(hydrateDecision);
}
