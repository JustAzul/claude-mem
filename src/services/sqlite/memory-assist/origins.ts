import { Database } from 'bun:sqlite';
import type { MemoryAssistToolAction } from '../../../shared/memory-assist.js';
import { logger } from '../../../utils/logger.js';

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface OutcomeOriginSourceRow {
  id: number;
  pending_message_id: number | null;
  decision_id: number | null;
  content_session_id: string | null;
  session_db_id: number | null;
  prompt_number: number | null;
  tool_name: string;
  action: MemoryAssistToolAction;
  file_path: string | null;
  generated_observation_ids_json: string | null;
  created_at_epoch: number;
}

export interface ObservationToolOriginRecord {
  id: number;
  observationId: number;
  pendingMessageId: number | null;
  decisionId: number | null;
  contentSessionId?: string;
  sessionDbId?: number;
  promptNumber?: number;
  toolName: string;
  action: MemoryAssistToolAction;
  filePath?: string | null;
  createdAtEpoch: number;
  contextType?: string | null;
  contextRef?: Record<string, unknown> | null;
}

/**
 * Context types for observations that originate outside a tool-call.
 * Kept as a TS union (not enum) so the DB stores free-form text but callers
 * stay type-checked at the insert site.
 */
export type ObservationContextType =
  | 'user_prompt'
  | 'init_prompt'
  | 'continuation_prompt'
  | 'summary_prompt';

/**
 * Sentinels inserted into the NOT NULL tool_name / action columns when the
 * row represents a context-based origin. Keeping them distinct from any real
 * tool name makes trace-endpoint filtering trivial and prevents context
 * origins from being mistaken for tool invocations in downstream telemetry.
 */
const CONTEXT_ORIGIN_TOOL_NAME = '__context__';
const CONTEXT_ORIGIN_ACTION: MemoryAssistToolAction = 'other';

interface OriginRow {
  id: number;
  observation_id: number;
  pending_message_id: number | null;
  decision_id: number | null;
  content_session_id: string | null;
  session_db_id: number | null;
  prompt_number: number | null;
  tool_name: string;
  action: MemoryAssistToolAction;
  file_path: string | null;
  created_at_epoch: number;
  context_type?: string | null;
  context_ref_json?: string | null;
}

function hydrateOrigin(row: OriginRow): ObservationToolOriginRecord {
  return {
    id: row.id,
    observationId: row.observation_id,
    pendingMessageId: row.pending_message_id,
    decisionId: row.decision_id,
    contentSessionId: row.content_session_id ?? undefined,
    sessionDbId: row.session_db_id ?? undefined,
    promptNumber: row.prompt_number ?? undefined,
    toolName: row.tool_name,
    action: row.action,
    filePath: row.file_path,
    createdAtEpoch: row.created_at_epoch,
    contextType: row.context_type ?? null,
    contextRef: parseJson<Record<string, unknown> | null>(row.context_ref_json ?? null, null),
  };
}

export function ensureObservationToolOriginsTable(db: Database): void {
  // NOTE: tool_name / action are only required for tool-based origins. For
  // context-based origins (see insertContextOrigin) these are synthesized as
  // '__context__' so the NOT NULL constraint remains satisfied while keeping
  // the tool-based write path unchanged.
  db.run(`
    CREATE TABLE IF NOT EXISTS observation_tool_origins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL,
      pending_message_id INTEGER,
      decision_id INTEGER,
      content_session_id TEXT,
      session_db_id INTEGER,
      prompt_number INTEGER,
      tool_name TEXT NOT NULL,
      action TEXT NOT NULL,
      file_path TEXT,
      created_at_epoch INTEGER NOT NULL,
      context_type TEXT,
      context_ref_json TEXT,
      FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE,
      FOREIGN KEY(decision_id) REFERENCES memory_assist_decisions(id) ON DELETE SET NULL
    )
  `);

  // V31 dual-path: the migration runner replaces the old unique index with
  // the composite one below on upgraded DBs. For fresh DBs, ensure we create
  // only the new composite unique index — never the legacy one.
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_tool_origins_observation_pending_context ON observation_tool_origins(observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, \'\'))');
  db.run('CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_observation ON observation_tool_origins(observation_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_pending ON observation_tool_origins(pending_message_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_context_type ON observation_tool_origins(context_type)');
}

export function attachObservationOriginsToPendingMessage(
  db: Database,
  pendingMessageId: number,
  observationIds: number[]
): ObservationToolOriginRecord[] {
  if (observationIds.length === 0) return [];

  const source = db.prepare(`
    SELECT
      id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      generated_observation_ids_json,
      created_at_epoch
    FROM memory_assist_outcome_signals
    WHERE pending_message_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(pendingMessageId) as OutcomeOriginSourceRow | undefined;

  if (!source) {
    logger.debug('DB', `memory-assist-origins: no outcome signal found for pending message ${pendingMessageId}`);
    return [];
  }

  const exactIds = parseJson<number[]>(source.generated_observation_ids_json, []);
  const idsToAttach = exactIds.length > 0
    ? observationIds.filter((id) => exactIds.includes(id))
    : observationIds;

  if (idsToAttach.length === 0) {
    logger.debug('DB', `memory-assist-origins: no exact observation ids to attach for pending message ${pendingMessageId}`);
    return [];
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO observation_tool_origins (
      observation_id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((ids: number[]) => {
    for (const observationId of ids) {
      insert.run(
        observationId,
        source.pending_message_id,
        source.decision_id,
        source.content_session_id,
        source.session_db_id,
        source.prompt_number,
        source.tool_name,
        source.action,
        source.file_path,
        source.created_at_epoch
      );
    }
  });
  tx(idsToAttach);

  const placeholders = idsToAttach.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE pending_message_id = ?
      AND observation_id IN (${placeholders})
    ORDER BY observation_id ASC
  `).all(pendingMessageId, ...idsToAttach) as OriginRow[];

  logger.debug('DB', `memory-assist-origins: attached ${rows.length} observation origins for pending message ${pendingMessageId}`);
  return rows.map(hydrateOrigin);
}

export function getObservationOrigin(
  db: Database,
  observationId: number
): ObservationToolOriginRecord | null {
  const row = db.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(observationId) as OriginRow | undefined;

  return row ? hydrateOrigin(row) : null;
}

/**
 * Insert a context-based origin row for an observation that was NOT produced
 * by a tool call (e.g. init prompt, continuation prompt, summary prompt, or a
 * user-prompt-only turn). Keeps pending_message_id NULL and stores the
 * originating context in context_type + context_ref_json so the trace
 * endpoint can surface something other than "No origin link found".
 *
 * Guard: silently no-op on empty observation id list to match the shape of
 * attachObservationOriginsToPendingMessage.
 */
export function insertContextOrigin(
  db: Database,
  observationId: number,
  contextType: ObservationContextType,
  contextRef: Record<string, unknown>,
  createdAtEpoch: number = Date.now()
): ObservationToolOriginRecord | null {
  if (!Number.isFinite(observationId) || observationId <= 0) {
    logger.warn('DB', `memory-assist-origins: insertContextOrigin: invalid observationId=${observationId} — skipping`);
    return null;
  }

  const contentSessionId = (contextRef.contentSessionId ?? contextRef.content_session_id ?? null) as string | null;
  const sessionDbId = (contextRef.sessionDbId ?? contextRef.session_db_id ?? null) as number | null;
  const promptNumber = (contextRef.promptNumber ?? contextRef.prompt_number ?? null) as number | null;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO observation_tool_origins (
      observation_id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      created_at_epoch,
      context_type,
      context_ref_json
    ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `);

  insert.run(
    observationId,
    contentSessionId,
    sessionDbId,
    promptNumber,
    CONTEXT_ORIGIN_TOOL_NAME,
    CONTEXT_ORIGIN_ACTION,
    createdAtEpoch,
    contextType,
    JSON.stringify(contextRef)
  );

  const row = db.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ? AND context_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(observationId, contextType) as OriginRow | undefined;

  if (!row) {
    logger.debug('DB', `memory-assist-origins: insertContextOrigin: no row materialized for obs=${observationId} (already existed?)`);
    return null;
  }

  return hydrateOrigin(row);
}

/**
 * Get every origin row for an observation — both tool-based and context-based.
 * Trace endpoints use this to render whichever origin exists; UI prefers tool
 * origin when both are present.
 */
export function getObservationOrigins(
  db: Database,
  observationId: number
): ObservationToolOriginRecord[] {
  const rows = db.prepare(`
    SELECT *
    FROM observation_tool_origins
    WHERE observation_id = ?
    ORDER BY id ASC
  `).all(observationId) as OriginRow[];

  return rows.map(hydrateOrigin);
}

export function backfillRecentObservationOrigins(
  db: Database,
  options: { limit?: number; windowDays?: number } = {}
): { resolvedCount: number; unresolvedCount: number } {
  const limit = options.limit ?? 200;
  const windowDays = options.windowDays ?? 30;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT
      id,
      pending_message_id,
      decision_id,
      content_session_id,
      session_db_id,
      prompt_number,
      tool_name,
      action,
      file_path,
      generated_observation_ids_json,
      created_at_epoch
    FROM memory_assist_outcome_signals
    WHERE created_at_epoch >= ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(cutoff, limit) as OutcomeOriginSourceRow[];

  let resolvedCount = 0;
  let unresolvedCount = 0;

  for (const row of rows) {
    const observationIds = parseJson<number[]>(row.generated_observation_ids_json, []);
    if (observationIds.length === 0 || row.pending_message_id == null) {
      unresolvedCount += 1;
      continue;
    }

    const attached = attachObservationOriginsToPendingMessage(db, row.pending_message_id, observationIds);
    if (attached.length > 0) {
      resolvedCount += attached.length;
      continue;
    }
    unresolvedCount += 1;
  }

  logger.debug('DB', `memory-assist-origins: backfill complete: resolved=${resolvedCount} unresolved=${unresolvedCount}`);
  return { resolvedCount, unresolvedCount };
}
