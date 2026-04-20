import { Database } from 'bun:sqlite';
import type { MemoryAssistOutcomeSignal, MemoryAssistToolAction } from '../../../shared/memory-assist.js';
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

interface OutcomeRow {
  id: number;
  decision_id: number | null;
  pending_message_id: number | null;
  source: string | null;
  prompt_number: number | null;
  content_session_id: string | null;
  session_db_id: number | null;
  project: string | null;
  platform_source: string | null;
  signal_type: string;
  tool_name: string;
  action: MemoryAssistToolAction;
  file_path: string | null;
  related_file_paths_json: string | null;
  concepts_json: string | null;
  generated_observation_ids_json: string | null;
  metadata_json: string | null;
  created_at_epoch: number;
}

export function ensureMemoryAssistOutcomeSignalsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_assist_outcome_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER,
      pending_message_id INTEGER,
      source TEXT,
      prompt_number INTEGER,
      content_session_id TEXT,
      session_db_id INTEGER,
      project TEXT,
      platform_source TEXT,
      signal_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      action TEXT NOT NULL,
      file_path TEXT,
      related_file_paths_json TEXT,
      concepts_json TEXT,
      generated_observation_ids_json TEXT,
      metadata_json TEXT,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(decision_id) REFERENCES memory_assist_decisions(id) ON DELETE SET NULL
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_memory_assist_outcomes_decision ON memory_assist_outcome_signals(decision_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_assist_outcomes_session ON memory_assist_outcome_signals(content_session_id, created_at_epoch DESC)');
  const columns = db.query('PRAGMA table_info(memory_assist_outcome_signals)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'prompt_number')) {
    db.run('ALTER TABLE memory_assist_outcome_signals ADD COLUMN prompt_number INTEGER');
  }
  if (!columns.some((column) => column.name === 'pending_message_id')) {
    db.run('ALTER TABLE memory_assist_outcome_signals ADD COLUMN pending_message_id INTEGER');
  }
  if (!columns.some((column) => column.name === 'generated_observation_ids_json')) {
    db.run('ALTER TABLE memory_assist_outcome_signals ADD COLUMN generated_observation_ids_json TEXT');
  }
}

function hydrateOutcome(row: OutcomeRow): MemoryAssistOutcomeSignal {
  return {
    id: row.id,
    decisionId: row.decision_id,
    pendingMessageId: row.pending_message_id,
    source: row.source as MemoryAssistOutcomeSignal['source'],
    promptNumber: row.prompt_number ?? undefined,
    contentSessionId: row.content_session_id ?? undefined,
    sessionDbId: row.session_db_id ?? undefined,
    project: row.project ?? undefined,
    platformSource: row.platform_source ?? undefined,
    signalType: row.signal_type as MemoryAssistOutcomeSignal['signalType'],
    toolName: row.tool_name,
    action: row.action,
    filePath: row.file_path,
    relatedFilePaths: parseJson<string[]>(row.related_file_paths_json, []),
    concepts: parseJson<string[]>(row.concepts_json, []),
    generatedObservationIds: parseJson<number[]>(row.generated_observation_ids_json, []),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    timestamp: row.created_at_epoch,
  };
}

export function recordMemoryAssistOutcomeSignal(
  db: Database,
  signal: MemoryAssistOutcomeSignal
): MemoryAssistOutcomeSignal {
  const timestamp = signal.timestamp ?? Date.now();
  logger.debug(`[memory-assist-outcomes] recording ${signal.action} outcome for ${signal.source ?? 'unknown source'}`);
  const result = db.prepare(`
    INSERT INTO memory_assist_outcome_signals (
      decision_id,
      pending_message_id,
      source,
      prompt_number,
      content_session_id,
      session_db_id,
      project,
      platform_source,
      signal_type,
      tool_name,
      action,
      file_path,
      related_file_paths_json,
      concepts_json,
      generated_observation_ids_json,
      metadata_json,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.decisionId ?? null,
    signal.pendingMessageId ?? null,
    signal.source ?? null,
    signal.promptNumber ?? null,
    signal.contentSessionId ?? null,
    signal.sessionDbId ?? null,
    signal.project ?? null,
    signal.platformSource ?? null,
    signal.signalType,
    signal.toolName,
    signal.action,
    signal.filePath ?? null,
    serializeJson(signal.relatedFilePaths ?? []),
    serializeJson(signal.concepts ?? []),
    serializeJson(signal.generatedObservationIds ?? []),
    serializeJson(signal.metadata ?? {}),
    timestamp
  );

  const row = db.prepare(`
    SELECT *
    FROM memory_assist_outcome_signals
    WHERE id = ?
  `).get(Number(result.lastInsertRowid)) as OutcomeRow | undefined;

  const hydrated = row ? hydrateOutcome(row) : { ...signal, id: Number(result.lastInsertRowid), timestamp };
  logger.debug(`[memory-assist-outcomes] stored outcome signal ${hydrated.id ?? 'unknown'}`);
  return hydrated;
}

export function attachGeneratedObservationsToOutcomeSignal(
  db: Database,
  pendingMessageId: number,
  observationIds: number[]
): number[] {
  if (observationIds.length === 0) return [];

  return db.transaction((): number[] => {
    const row = db.prepare(`
      SELECT id, generated_observation_ids_json
      FROM memory_assist_outcome_signals
      WHERE pending_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(pendingMessageId) as Pick<OutcomeRow, 'id' | 'generated_observation_ids_json'> | undefined;

    if (!row) {
      logger.debug(`[memory-assist-outcomes] no outcome signal found for pending message ${pendingMessageId}`);
      return [];
    }

    const existing = parseJson<number[]>(row.generated_observation_ids_json, []);
    const merged = [...new Set([...existing, ...observationIds])];

    db.prepare(`
      UPDATE memory_assist_outcome_signals
      SET generated_observation_ids_json = ?
      WHERE id = ?
    `).run(serializeJson(merged), row.id);

    logger.debug(`[memory-assist-outcomes] attached ${observationIds.length} observations to pending message ${pendingMessageId}`);
    return merged;
  })();
}

export function getOutcomeSignalsForDecisionIds(
  db: Database,
  decisionIds: number[]
): Record<number, MemoryAssistOutcomeSignal[]> {
  if (decisionIds.length === 0) return {};
  const placeholders = decisionIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM memory_assist_outcome_signals
    WHERE decision_id IN (${placeholders})
    ORDER BY created_at_epoch ASC
  `).all(...decisionIds) as OutcomeRow[];

  const grouped = rows.reduce<Record<number, MemoryAssistOutcomeSignal[]>>((acc, row) => {
    const decisionId = row.decision_id;
    if (decisionId == null) return acc;
    if (!acc[decisionId]) acc[decisionId] = [];
    acc[decisionId].push(hydrateOutcome(row));
    return acc;
  }, {});
  logger.debug(`[memory-assist-outcomes] loaded ${rows.length} outcome signals for ${decisionIds.length} decisions`);
  return grouped;
}
