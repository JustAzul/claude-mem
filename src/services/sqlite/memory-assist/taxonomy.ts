import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export interface MemoryAssistTaxonomyCorrection {
  originalType: string;
  normalizedType: string;
  count: number;
}

function ensureColumn(db: Database, tableName: string, columnName: string, sqlType: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType}`);
}

export function ensureObservationTypeCorrectionsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS observation_type_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode_id TEXT,
      original_type TEXT NOT NULL,
      normalized_type TEXT NOT NULL,
      fallback_type TEXT NOT NULL,
      strategy TEXT NOT NULL,
      correlation_id TEXT,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  ensureColumn(db, 'observation_type_corrections', 'project', 'TEXT');
  ensureColumn(db, 'observation_type_corrections', 'platform_source', 'TEXT');
  db.run('CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_created ON observation_type_corrections(created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_project ON observation_type_corrections(project)');
  db.run('CREATE INDEX IF NOT EXISTS idx_observation_type_corrections_source ON observation_type_corrections(platform_source)');
}

export function recordObservationTypeCorrection(
  db: Database,
  input: {
    modeId: string;
    originalType: string;
    normalizedType: string;
    fallbackType: string;
    strategy: 'alias' | 'fallback';
    correlationId?: string;
    project?: string;
    platformSource?: string;
  }
): void {
  logger.debug(
    `[memory-assist-taxonomy] ${input.originalType} -> ${input.normalizedType} (${input.strategy}) in mode=${input.modeId}`
  );
  db.prepare(`
    INSERT INTO observation_type_corrections (
      mode_id,
      original_type,
      normalized_type,
      fallback_type,
      strategy,
      correlation_id,
      project,
      platform_source,
      created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.modeId,
    input.originalType,
    input.normalizedType,
    input.fallbackType,
    input.strategy,
    input.correlationId ?? null,
    input.project ?? null,
    input.platformSource ?? null,
    Date.now()
  );
}

export function getObservationTypeCorrectionStats(
  db: Database,
  windowDays = 30,
  filters: {
    project?: string;
    platformSource?: string;
  } = {}
): { total: number; aliases: MemoryAssistTaxonomyCorrection[] } {
  const sinceEpoch = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const clauses = ['created_at_epoch >= ?'];
  const params: Array<number | string> = [sinceEpoch];

  if (filters.project) {
    clauses.push('project = ?');
    params.push(filters.project);
  }
  if (filters.platformSource) {
    clauses.push('platform_source = ?');
    params.push(filters.platformSource);
  }

  const rows = db.prepare(`
    SELECT original_type, normalized_type, COUNT(*) AS count
    FROM observation_type_corrections
    WHERE ${clauses.join(' AND ')}
    GROUP BY original_type, normalized_type
    ORDER BY count DESC, original_type ASC
  `).all(...params) as Array<{
    original_type: string;
    normalized_type: string;
    count: number;
  }>;

  const stats = {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    aliases: rows.map((row) => ({
      originalType: row.original_type,
      normalizedType: row.normalized_type,
      count: row.count,
    })),
  };
  logger.debug(`[memory-assist-taxonomy] loaded correction stats for ${windowDays}d window (${stats.total} corrections)`);
  return stats;
}
