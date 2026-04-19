import { Database } from 'bun:sqlite';
import type { MemoryAssistCalibrationRecord, MemoryAssistCalibrationSnapshot, MemoryAssistSource } from '../../../shared/memory-assist.js';
import { logger } from '../../../utils/logger.js';

interface CalibrationRow {
  id: number;
  project: string | null;
  source: MemoryAssistSource | null;
  semantic_threshold: number | null;
  inject_limit: number | null;
  min_query_length: number | null;
  ranker_id: string | null;
  created_at_epoch: number;
  updated_at_epoch: number;
}

function hydrateCalibration(row: CalibrationRow): MemoryAssistCalibrationRecord {
  return {
    id: row.id,
    project: row.project,
    source: row.source,
    semanticThreshold: row.semantic_threshold,
    injectLimit: row.inject_limit,
    minQueryLength: row.min_query_length,
    rankerId: row.ranker_id,
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch,
  };
}

export function ensureMemoryAssistCalibrationTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_assist_calibration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      source TEXT,
      semantic_threshold REAL,
      inject_limit INTEGER,
      min_query_length INTEGER,
      ranker_id TEXT,
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    )
  `);

  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_assist_calibration_scope ON memory_assist_calibration(COALESCE(project, \'\'), COALESCE(source, \'\'))');
}

export function getMemoryAssistCalibrationSnapshot(db: Database): MemoryAssistCalibrationSnapshot {
  const rows = db.prepare(`
    SELECT *
    FROM memory_assist_calibration
    ORDER BY updated_at_epoch DESC
  `).all() as CalibrationRow[];

  const snapshot: MemoryAssistCalibrationSnapshot = {
    global: null,
    byProject: {},
    bySource: {},
    byProjectAndSource: {},
  };

  for (const row of rows) {
    const record = hydrateCalibration(row);
    if (!record.project && !record.source) {
      snapshot.global ??= record;
      continue;
    }
    if (record.project && record.source) {
      snapshot.byProjectAndSource[`${record.project}::${record.source}`] = record;
      continue;
    }
    if (record.project) {
      snapshot.byProject[record.project] = record;
      continue;
    }
    if (record.source) {
      snapshot.bySource[record.source] = record;
    }
  }

  logger.debug(`[memory-assist-calibration] loaded ${rows.length} calibration rows`);
  return snapshot;
}
