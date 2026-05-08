import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { DATA_DIR, DB_PATH, ensureDir, OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult
} from '../../types/database.js';
import type { PendingMessageStore } from './PendingMessageStore.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from './types.js';
import { computeObservationContentHash } from './observations/store.js';
import {
  capturedFromObservation,
  emptyCaptureSnapshotSource,
  insertCaptureSnapshot,
  type CaptureSnapshotSource,
} from './observations/capture-snapshot.js';
import { parseFileList } from './observations/files.js';
import {
  getObservationFeedbackStats,
  recordObservationFeedback,
  type ObservationFeedbackSignal,
  type ObservationFeedbackStats,
} from './observations/feedback.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';
import { estimateTimelineTokensFromTraceItems } from '../../shared/timeline-formatting.js';
import type {
  MemoryAssistCalibrationSnapshot,
  MemoryAssistDashboard,
  MemoryAssistDecisionRecord,
  MemoryAssistFeedbackLabel,
  MemoryAssistOutcomeSignal,
  MemoryAssistReport,
} from '../../shared/memory-assist.js';
import {
  attachMemoryAssistDecisionFeedback,
  ensureMemoryAssistDecisionsTable,
  getDecisionRowsForIds,
  getMemoryAssistDecisionsForPrompt,
  getRecentMemoryAssistDecisions,
  getRecentlyInjectedIds,
  recordMemoryAssistDecision,
  updateMemoryAssistDecisionVerdict,
} from './memory-assist/decisions.js';
import {
  attachGeneratedObservationsToOutcomeSignal,
  ensureMemoryAssistOutcomeSignalsTable,
  getOutcomeSignalsForDecisionIds,
  recordMemoryAssistOutcomeSignal,
} from './memory-assist/outcomes.js';
import {
  attachObservationOriginsToPendingMessage,
  backfillRecentObservationOrigins,
  ensureObservationToolOriginsTable,
  getObservationOrigin,
  getObservationOrigins,
  insertContextOrigin,
  type ObservationContextType,
  type ObservationToolOriginRecord,
} from './memory-assist/origins.js';
import {
  ensureMemoryAssistCalibrationTable,
  getMemoryAssistCalibrationSnapshot,
} from './memory-assist/calibration.js';
import { getMemoryAssistDashboard } from './memory-assist/dashboard.js';
import {
  ensureObservationTypeCorrectionsTable,
  recordObservationTypeCorrection,
} from './memory-assist/taxonomy.js';
import { judgeMemoryAssistDecision } from '../worker/MemoryAssistJudge.js';

function normalizeMemoryAssistPath(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\\/g, '/').trim().toLowerCase();
}

function collectSignalPaths(signal: MemoryAssistOutcomeSignal): Set<string> {
  const paths = new Set<string>();
  const primary = normalizeMemoryAssistPath(signal.filePath);
  if (primary) paths.add(primary);
  for (const related of signal.relatedFilePaths ?? []) {
    const normalized = normalizeMemoryAssistPath(related);
    if (normalized) paths.add(normalized);
  }
  return paths;
}

function collectDecisionPaths(decision: MemoryAssistDecisionRecord): Set<string> {
  const paths = new Set<string>();
  for (const item of decision.traceItems ?? []) {
    const primary = normalizeMemoryAssistPath(item.filePath);
    if (primary) paths.add(primary);
    for (const related of item.relatedFilePaths ?? []) {
      const normalized = normalizeMemoryAssistPath(related);
      if (normalized) paths.add(normalized);
    }
  }
  return paths;
}

function pickMostRecent(decisions: MemoryAssistDecisionRecord[]): MemoryAssistDecisionRecord {
  let winner = decisions[0];
  for (let i = 1; i < decisions.length; i++) {
    if (decisions[i].createdAtEpoch > winner.createdAtEpoch) {
      winner = decisions[i];
    }
  }
  return winner;
}

function pickNearestInTime(
  decisions: MemoryAssistDecisionRecord[],
  timestampMs: number
): MemoryAssistDecisionRecord {
  let bestBefore: MemoryAssistDecisionRecord | null = null;
  let bestBeforeDelta = Infinity;
  for (const d of decisions) {
    if (d.createdAtEpoch <= timestampMs) {
      const delta = timestampMs - d.createdAtEpoch;
      if (delta < bestBeforeDelta) {
        bestBefore = d;
        bestBeforeDelta = delta;
      }
    }
  }
  return bestBefore ?? pickMostRecent(decisions);
}

function resolveCreateSessionArgs(
  customTitle?: string,
  platformSource?: string
): { customTitle?: string; platformSource?: string } {
  return {
    customTitle,
    platformSource: platformSource ? normalizePlatformSource(platformSource) : undefined
  };
}

export class SessionStore {
  public db: Database;

  constructor(dbPathOrDb: string | Database = DB_PATH) {
    if (dbPathOrDb instanceof Database) {
      this.db = dbPathOrDb;
    } else {
      if (dbPathOrDb !== ':memory:') {
        ensureDir(DATA_DIR);
      }
      this.db = new Database(dbPathOrDb);

      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA synchronous = NORMAL');
      this.db.run('PRAGMA foreign_keys = ON');
      this.db.run('PRAGMA journal_size_limit = 4194304'); 
    }

    this.initializeSchema();

    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
    this.createUserPromptsTable();
    this.ensureDiscoveryTokensColumn();
    this.createPendingMessagesTable();
    this.renameSessionIdColumns();
    this.repairSessionIdColumnRename();
    this.addFailedAtEpochColumn();
    this.addOnUpdateCascadeToForeignKeys();
    this.addObservationContentHashColumn();
    this.addSessionCustomTitleColumn();
    this.addSessionPlatformSourceColumn();
    this.addObservationModelColumns();
    this.ensureMergedIntoProjectColumns();
    this.addObservationSubagentColumns();
    this.ensureObservationFeedbackTable();
    this.ensureMemoryAssistTables();
    this.createObservationsFTSIndex();
    this.addObservationDecisionDNAFields();
    this.addCaptureSnapshotTables();
    this.addObservationContextOriginFields();
    this.addMcpInvocationsTable();
    this.addMemoryImplicitSignalsTable();
    this.addLlmRawTypeColumn();
    this.addObservationsUniqueContentHashIndex();
    this.addObservationsMetadataColumn();
    this.dropDeadPendingMessagesColumns();
    this.ensurePendingMessagesToolUseIdColumn();
    this.dropWorkerPidColumn();
  }

  /**
   * Create FTS5 virtual table over observations for BM25 keyword search (migration 28)
   *
   * Duplicates MigrationRunner.createObservationsFTSIndex so the worker's SessionStore
   * path (the one actually invoked at production startup — see `worker/DatabaseManager.ts`)
   * ensures the index exists. Previously the FTS table was only created lazily by
   * `SessionSearch.ensureFTSTables` on first search; centralizing it here closes the gap
   * and makes the schema version (28) record against the same DB the worker uses.
   *
   * Column set matches migration 21's trigger recreation: title, subtitle, narrative,
   * text, facts, concepts. External-content FTS5 (content='observations') stores only
   * the token index — no row duplication. Three triggers keep the index in sync; a
   * rebuild populates existing rows on first creation.
   *
   * Graceful: if FTS5 is unavailable (e.g. Bun on Windows #791), logs a warning and
   * continues — the existing Chroma/LIKE fallback handles search.
   */
  private createObservationsFTSIndex(): void {
    const hasFTSTable = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all() as { name: string }[]).length > 0;

    try {
      if (!hasFTSTable) {
        this.db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
            title, subtitle, narrative, text, facts, concepts,
            content='observations', content_rowid='id',
            tokenize='porter unicode61'
          )
        `);

        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `);

        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          END
        `);

        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `);

        // External-content FTS5 needs `rebuild` to actually tokenize existing rows —
        // direct INSERT only registers rowid mappings without building the token index.
        this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");

        logger.debug('DB', 'SessionStore: Created observations_fts virtual table, sync triggers, and backfilled existing rows');
      }
    } catch (ftsError: unknown) {
      logger.warn('DB', 'FTS5 not available, observations_fts index skipped', {}, ftsError as Error);
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
    logger.debug('DB', 'SessionStore: Observations FTS5 index ensured');
  }

  private dropWorkerPidColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(36) as SchemaVersion | undefined;

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasColumn = cols.some(c => c.name === 'worker_pid');
    if (applied && !hasColumn) return;

    if (hasColumn) {
      try {
        this.db.run('DROP INDEX IF EXISTS idx_pending_messages_worker_pid');
        this.db.run('ALTER TABLE pending_messages DROP COLUMN worker_pid');
        logger.debug('DB', 'Dropped worker_pid column and its index from pending_messages');
      } catch (error) {
        logger.warn('DB', 'Failed to drop worker_pid column from pending_messages', {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(36, new Date().toISOString());
    }
  }

  private dropDeadPendingMessagesColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(35) as SchemaVersion | undefined;

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const colNames = new Set(cols.map(c => c.name));
    const deadColumns = ['retry_count', 'failed_at_epoch', 'completed_at_epoch'];
    const toDrop = deadColumns.filter(name => colNames.has(name));
    if (applied && toDrop.length === 0) return;

    if (toDrop.length > 0) {
      this.db.run('BEGIN TRANSACTION');
      try {
        this.db.run(`DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')`);
        for (const colName of toDrop) {
          this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${colName}`);
          logger.debug('DB', `Dropped dead column ${colName} from pending_messages`);
        }
        if (!applied) {
          this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());
        }
        this.db.run('COMMIT');
      } catch (error) {
        this.db.run('ROLLBACK');
        logger.warn('DB', 'Failed to drop dead columns from pending_messages', {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      return;
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());
    }
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
  }

  private ensureWorkerPortColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

    if (!hasWorkerPort) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
  }

  private ensurePromptTrackingColumns(): void {
    const sessionsInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

    if (!hasPromptCounter) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

    if (!obsHasPromptNumber) {
      this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

    if (!sumHasPromptNumber) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
  }

  private removeSessionSummariesUniqueConstraint(): void {
    const summariesIndexes = this.db.query('PRAGMA index_list(session_summaries)').all() as IndexInfo[];
    const hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1 && idx.origin !== 'pk');

    if (!hasUniqueConstraint) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    this.db.run('BEGIN TRANSACTION');

    this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);

    this.db.run('DROP TABLE session_summaries');

    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());

    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  private addObservationHierarchicalFields(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(8) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasTitle = tableInfo.some(col => col.name === 'title');

    if (hasTitle) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Adding hierarchical fields to observations table');

    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());

    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  private makeObservationsTextNullable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(9) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const textColumn = tableInfo.find(col => col.name === 'text');

    if (!textColumn || textColumn.notnull === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Making observations.text nullable');

    this.db.run('BEGIN TRANSACTION');

    this.db.run('DROP TABLE IF EXISTS observations_new');

    this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);

    this.db.run('DROP TABLE observations');

    this.db.run('ALTER TABLE observations_new RENAME TO observations');

    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());

    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  private createUserPromptsTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(10) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(user_prompts)').all() as TableColumnInfo[];
    if (tableInfo.length > 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    this.db.run('BEGIN TRANSACTION');

    this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);

    const ftsCreateSQL = `
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `;
    const ftsTriggersSQL = `
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `;

    try {
      this.db.run(ftsCreateSQL);
      this.db.run(ftsTriggersSQL);
    } catch (ftsError) {
      if (ftsError instanceof Error) {
        logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, ftsError);
      } else {
        logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, new Error(String(ftsError)));
      }
      this.db.run('COMMIT');
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      logger.debug('DB', 'Created user_prompts table (without FTS5)');
      return;
    }

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());

    logger.debug('DB', 'Successfully created user_prompts table');
  }

  private ensureDiscoveryTokensColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(11) as SchemaVersion | undefined;
    if (applied) return;

    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

    if (!obsHasDiscoveryTokens) {
      this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

    if (!sumHasDiscoveryTokens) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
  }

  private createPendingMessagesTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(16) as SchemaVersion | undefined;
    if (applied) return;

    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all() as TableNameRow[];
    if (tables.length > 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating pending_messages table');

    this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());

    logger.debug('DB', 'pending_messages table created successfully');
  }

  private renameSessionIdColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(17) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');

    let renamesPerformed = 0;

    const safeRenameColumn = (table: string, oldCol: string, newCol: string): boolean => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const hasOldCol = tableInfo.some(col => col.name === oldCol);
      const hasNewCol = tableInfo.some(col => col.name === newCol);

      if (hasNewCol) {
        return false;
      }

      if (hasOldCol) {
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    if (safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    if (safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());

    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  private repairSessionIdColumnRename(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(19) as SchemaVersion | undefined;
    if (applied) return;

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(19, new Date().toISOString());
  }

  private addFailedAtEpochColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(20) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'failed_at_epoch');

    if (!hasColumn) {
      this.db.run('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER');
      logger.debug('DB', 'Added failed_at_epoch column to pending_messages table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(20, new Date().toISOString());
  }

  private addOnUpdateCascadeToForeignKeys(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(21) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    this.db.run('PRAGMA foreign_keys = OFF');
    this.db.run('BEGIN TRANSACTION');

    this.db.run('DROP TRIGGER IF EXISTS observations_ai');
    this.db.run('DROP TRIGGER IF EXISTS observations_ad');
    this.db.run('DROP TRIGGER IF EXISTS observations_au');

    this.db.run('DROP TABLE IF EXISTS observations_new');

    const observationsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const observationsHasMetadata = observationsCols.some(c => c.name === 'metadata');
    const metadataColumnSQL = observationsHasMetadata ? ',\n        metadata TEXT' : '';
    const metadataSelectSQL = observationsHasMetadata ? ', metadata' : '';

    const observationsNewSQL = `
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL${metadataColumnSQL},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const observationsCopySQL = `
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${metadataSelectSQL}
      FROM observations
    `;
    const observationsIndexesSQL = `
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `;
    const observationsFTSTriggersSQL = `
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `;

    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_au');

    this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    const summariesNewSQL = `
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const summariesCopySQL = `
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `;
    const summariesIndexesSQL = `
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `;
    const summariesFTSTriggersSQL = `
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
    `;

    try {
      this.recreateObservationsWithCascade(observationsNewSQL, observationsCopySQL, observationsIndexesSQL, observationsFTSTriggersSQL);
      this.recreateSessionSummariesWithCascade(summariesNewSQL, summariesCopySQL, summariesIndexesSQL, summariesFTSTriggersSQL);

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString());
      this.db.run('COMMIT');
      this.db.run('PRAGMA foreign_keys = ON');
      logger.debug('DB', 'Successfully added ON UPDATE CASCADE to FK constraints');
    } catch (error) {
      this.db.run('ROLLBACK');
      this.db.run('PRAGMA foreign_keys = ON');
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }

  private recreateObservationsWithCascade(createSQL: string, copySQL: string, indexesSQL: string, ftsTriggersSQL: string): void {
    this.db.run(createSQL);
    this.db.run(copySQL);
    this.db.run('DROP TABLE observations');
    this.db.run('ALTER TABLE observations_new RENAME TO observations');
    this.db.run(indexesSQL);

    const hasFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all() as { name: string }[]).length > 0;
    if (hasFTS) {
      this.db.run(ftsTriggersSQL);
    }
  }

  private recreateSessionSummariesWithCascade(createSQL: string, copySQL: string, indexesSQL: string, ftsTriggersSQL: string): void {
    this.db.run(createSQL);
    this.db.run(copySQL);
    this.db.run('DROP TABLE session_summaries');
    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');
    this.db.run(indexesSQL);

    const hasSummariesFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all() as { name: string }[]).length > 0;
    if (hasSummariesFTS) {
      this.db.run(ftsTriggersSQL);
    }
  }

  private addObservationContentHashColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'content_hash');

    if (hasColumn) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
      return;
    }

    this.db.run('ALTER TABLE observations ADD COLUMN content_hash TEXT');
    this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL");
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)');
    logger.debug('DB', 'Added content_hash column to observations table with backfill and index');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
  }

  private addSessionCustomTitleColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(23) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'custom_title');

    if (!hasColumn) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT');
      logger.debug('DB', 'Added custom_title column to sdk_sessions table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(23, new Date().toISOString());
  }

  private addSessionPlatformSourceColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'platform_source');
    const indexInfo = this.db.query('PRAGMA index_list(sdk_sessions)').all() as IndexInfo[];
    const hasIndex = indexInfo.some(index => index.name === 'idx_sdk_sessions_platform_source');
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(24) as SchemaVersion | undefined;

    if (applied && hasColumn && hasIndex) return;

    if (!hasColumn) {
      this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`);
      logger.debug('DB', 'Added platform_source column to sdk_sessions table');
    }

    this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
      WHERE platform_source IS NULL OR platform_source = ''
    `);

    if (!hasIndex) {
      this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
  }

  private addObservationModelColumns(): void {
    const columns = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasGeneratedByModel = columns.some(col => col.name === 'generated_by_model');
    const hasRelevanceCount = columns.some(col => col.name === 'relevance_count');

    if (hasGeneratedByModel && hasRelevanceCount) return;

    if (!hasGeneratedByModel) {
      this.db.run('ALTER TABLE observations ADD COLUMN generated_by_model TEXT');
    }
    if (!hasRelevanceCount) {
      this.db.run('ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(26, new Date().toISOString());
  }

  /**
   * Ensure observation_feedback table exists for memory-assist feedback stats (migration 27)
   */
  private ensureObservationFeedbackTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        session_db_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_feedback_signal ON observation_feedback(signal_type)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(27, new Date().toISOString());
  }

  private ensureMemoryAssistTables(): void {
    ensureMemoryAssistDecisionsTable(this.db);
    ensureMemoryAssistOutcomeSignalsTable(this.db);
    ensureObservationToolOriginsTable(this.db);
    ensureMemoryAssistCalibrationTable(this.db);
    ensureObservationTypeCorrectionsTable(this.db);
  }

  /**
   * Add why / alternatives_rejected / related_observation_ids to observations (migration 29)
   *
   * Duplicates MigrationRunner.migrateToV29 so the worker's SessionStore path (the
   * one actually invoked at production startup) applies the schema change. An audit
   * (N=30 observations) found 53% captured no rationale because the capture prompt
   * never asked for it. These three columns hold the decision DNA so future sessions
   * see not just WHAT changed but WHY and what was rejected.
   *
   * Also extends observations_fts to include `why` + `alternatives_rejected` so
   * rationale content is searchable. `related_observation_ids` stores integers as
   * JSON text and is excluded from full-text search.
   *
   * Idempotent: checks actual column presence before ALTER and checks FTS column
   * list before DROP/recreate so cross-machine DB sync or partial runs don't fail.
   */
  private addObservationDecisionDNAFields(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(29) as SchemaVersion | undefined;

    // Even if version is marked applied, verify columns exist — belt-and-suspenders
    // for cross-machine DB sync where schema_versions could ship ahead of columns.
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const names = new Set(tableInfo.map(col => col.name));
    const needWhy = !names.has('why');
    const needAlt = !names.has('alternatives_rejected');
    const needRel = !names.has('related_observation_ids');

    if (applied && !needWhy && !needAlt && !needRel) return;

    if (needWhy) this.db.run('ALTER TABLE observations ADD COLUMN why TEXT');
    if (needAlt) this.db.run('ALTER TABLE observations ADD COLUMN alternatives_rejected TEXT');
    if (needRel) this.db.run('ALTER TABLE observations ADD COLUMN related_observation_ids TEXT');

    // Extend FTS5 to include why + alternatives_rejected. External-content FTS5 has
    // no ALTER TABLE, so we DROP + recreate. Skip gracefully if FTS5 is unavailable.
    try {
      const hasFTSTable = (this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
      ).all() as { name: string }[]).length > 0;

      if (hasFTSTable) {
        const ftsCols = this.db.query('PRAGMA table_info(observations_fts)').all() as TableColumnInfo[];
        const ftsHasWhy = ftsCols.some(col => col.name === 'why');

        if (!ftsHasWhy) {
          this.db.run('DROP TRIGGER IF EXISTS observations_ai');
          this.db.run('DROP TRIGGER IF EXISTS observations_ad');
          this.db.run('DROP TRIGGER IF EXISTS observations_au');
          this.db.run('DROP TABLE IF EXISTS observations_fts');

          this.db.run(`
            CREATE VIRTUAL TABLE observations_fts USING fts5(
              title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected,
              content='observations', content_rowid='id',
              tokenize='porter unicode61'
            )
          `);

          this.db.run(`
            CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
              INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts, new.why, new.alternatives_rejected);
            END
          `);

          this.db.run(`
            CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
              INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts, old.why, old.alternatives_rejected);
            END
          `);

          this.db.run(`
            CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
              INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts, old.why, old.alternatives_rejected);
              INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected)
              VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts, new.why, new.alternatives_rejected);
            END
          `);

          this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
          logger.debug('DB', 'SessionStore: rebuilt observations_fts with why + alternatives_rejected columns');
        }
      }
    } catch (ftsError: unknown) {
      logger.warn('DB', 'SessionStore: FTS5 extension for V29 skipped', {}, ftsError instanceof Error ? ftsError : undefined);
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
    logger.debug('DB', 'SessionStore: migration V29 complete (why/alternatives_rejected/related_observation_ids)');
  }

  /**
   * Add observation_capture_snapshots + observation_rubric_scores tables (migration 30)
   *
   * Duplicates MigrationRunner.migrateToV30 so the worker's SessionStore path
   * (the one actually invoked at production startup) applies the schema
   * change. See the migrations/runner.ts docblock for full rationale.
   *
   * Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
   */
  private addCaptureSnapshotTables(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(30) as SchemaVersion | undefined;

    // Belt-and-suspenders: verify tables exist even if the version is marked
    // applied (cross-machine DB sync can ship schema_versions ahead of tables).
    const tableNames = this.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('observation_capture_snapshots','observation_rubric_scores')")
      .all() as TableNameRow[];
    const existing = new Set(tableNames.map(r => r.name));
    const needSnapshot = !existing.has('observation_capture_snapshots');
    const needRubric = !existing.has('observation_rubric_scores');

    if (applied && !needSnapshot && !needRubric) return;

    if (needSnapshot) {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS observation_capture_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id INTEGER NOT NULL,
          memory_session_id TEXT,
          content_session_id TEXT,
          prompt_number INTEGER,
          user_prompt TEXT,
          prior_assistant_message TEXT,
          tool_name TEXT,
          tool_input TEXT,
          tool_output TEXT,
          cwd TEXT,
          captured_type TEXT,
          captured_title TEXT,
          captured_subtitle TEXT,
          captured_narrative TEXT,
          captured_facts TEXT,
          captured_concepts TEXT,
          captured_why TEXT,
          captured_alternatives_rejected TEXT,
          captured_related_observation_ids TEXT,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
        )
      `);
      this.db.run('CREATE INDEX IF NOT EXISTS idx_capture_snapshot_obs ON observation_capture_snapshots(observation_id)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_capture_snapshot_created ON observation_capture_snapshots(created_at_epoch DESC)');
    }

    if (needRubric) {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS observation_rubric_scores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id INTEGER NOT NULL,
          snapshot_id INTEGER,
          judge_model TEXT,
          fidelity REAL,
          intent_fit REAL,
          concept_accuracy REAL,
          type_correctness REAL,
          ceiling_flagged INTEGER,
          judge_notes TEXT,
          scored_at_epoch INTEGER NOT NULL,
          FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
        )
      `);
      this.db.run('CREATE INDEX IF NOT EXISTS idx_rubric_obs ON observation_rubric_scores(observation_id)');
      this.db.run('CREATE INDEX IF NOT EXISTS idx_rubric_scored ON observation_rubric_scores(scored_at_epoch DESC)');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(30, new Date().toISOString());
    logger.debug('DB', 'SessionStore: migration V30 complete (observation_capture_snapshots + observation_rubric_scores)');
  }

  /**
   * Add context-origin columns to observation_tool_origins (migration 31)
   *
   * Duplicates MigrationRunner.migrateToV31 so the worker's SessionStore path
   * (the one actually invoked at production startup) applies the schema
   * change. See the migrations/runner.ts docblock for full rationale.
   *
   * Idempotent: verifies column presence via PRAGMA before ALTER so partial
   * runs or cross-machine DB sync don't fail.
   */
  private addObservationContextOriginFields(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(31) as SchemaVersion | undefined;

    const cols = this.db.query('PRAGMA table_info(observation_tool_origins)').all() as TableColumnInfo[];
    // Fresh DB: table doesn't exist. It'll be created by ensureOriginsTables
    // with the full schema already including context columns. Mark V31 applied
    // and short-circuit to avoid ALTER TABLE on non-existent table.
    if (cols.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
      return;
    }
    const names = new Set(cols.map(col => col.name));
    const needContextType = !names.has('context_type');
    const needContextRef = !names.has('context_ref_json');

    if (applied && !needContextType && !needContextRef) return;

    if (needContextType) {
      this.db.run('ALTER TABLE observation_tool_origins ADD COLUMN context_type TEXT');
    }
    if (needContextRef) {
      this.db.run('ALTER TABLE observation_tool_origins ADD COLUMN context_ref_json TEXT');
    }

    this.db.run('DROP INDEX IF EXISTS idx_observation_tool_origins_observation_pending');
    this.db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_tool_origins_observation_pending_context ' +
      'ON observation_tool_origins(observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, \'\'))'
    );
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_context_type ON observation_tool_origins(context_type)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
    logger.debug('DB', 'SessionStore: migration V31 complete (context_type + context_ref_json on observation_tool_origins)');
  }

  /**
   * Create mcp_invocations table for MCP tool call logging (migration 32)
   *
   * Duplicates MigrationRunner.migrateToV32 so the worker's SessionStore path
   * (the one actually invoked at production startup) applies the schema.
   * See the migrations/runner.ts docblock for the dual-path rationale.
   *
   * Idempotent: checks table existence before DDL to handle fresh DBs where
   * CREATE TABLE IF NOT EXISTS makes the schema_versions guard unnecessary for
   * the DDL itself, but we still skip if both version row AND table exist.
   */
  private addMcpInvocationsTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(32) as SchemaVersion | undefined;
    const tableCheck = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_invocations'").get() as { name: string } | undefined;

    if (applied && tableCheck) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS mcp_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        args_summary TEXT,
        result_status TEXT NOT NULL,
        error_message TEXT,
        duration_ms INTEGER,
        invoked_at_epoch INTEGER NOT NULL
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_mcp_invocations_tool_time ON mcp_invocations(tool_name, invoked_at_epoch DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_mcp_invocations_time ON mcp_invocations(invoked_at_epoch DESC)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(32, new Date().toISOString());
    logger.debug('DB', 'SessionStore: migration V32 complete (mcp_invocations table)');
  }

  /**
   * Create memory_implicit_signals table for implicit use tracking (migration 33)
   *
   * Duplicates MigrationRunner.migrateToV33 so the worker's SessionStore path
   * (the one actually invoked at production startup) applies the schema.
   * See the migrations/runner.ts docblock for the dual-path rationale.
   *
   * Stores file_reuse and content_cited signals computed after injection events,
   * enabling direct evidence of whether injected memory was actually used.
   *
   * Idempotent: checks table existence before DDL to handle fresh DBs where
   * CREATE TABLE IF NOT EXISTS makes the schema_versions guard unnecessary for
   * the DDL itself, but we still skip if both version row AND table exist.
   */
  private addMemoryImplicitSignalsTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(33) as SchemaVersion | undefined;
    const tableCheck = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_implicit_signals'").get() as { name: string } | undefined;

    if (applied && tableCheck) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_implicit_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL,
        observation_id INTEGER NOT NULL,
        signal_kind TEXT NOT NULL CHECK(signal_kind IN ('file_reuse', 'content_cited', 'no_overlap')),
        evidence TEXT,
        confidence REAL,
        computed_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (decision_id) REFERENCES memory_assist_decisions(id),
        FOREIGN KEY (observation_id) REFERENCES observations(id)
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_mis_decision ON memory_implicit_signals(decision_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_mis_obs ON memory_implicit_signals(observation_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_mis_kind_time ON memory_implicit_signals(signal_kind, computed_at_epoch DESC)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(33, new Date().toISOString());
    logger.debug('DB', 'SessionStore: migration V33 complete (memory_implicit_signals table)');
  }

  /**
   * Duplicates MigrationRunner.migrateToV34 so the worker's SessionStore path
   * (the one actually invoked at production startup) applies the schema.
   * Adds llm_raw_type column to observation_capture_snapshots to track pre-gate types.
   */
  private addLlmRawTypeColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(34) as SchemaVersion | undefined;
    if (applied) return;

    // Guard against cross-machine DB sync that already added the column.
    const cols = this.db.prepare('PRAGMA table_info(observation_capture_snapshots)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'llm_raw_type')) {
      this.db.run(`ALTER TABLE observation_capture_snapshots ADD COLUMN llm_raw_type TEXT`);
    }
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(34, new Date().toISOString());
    logger.debug('DB', 'SessionStore: migration V34 complete (llm_raw_type column on observation_capture_snapshots)');
  }

  /**
   * Returns decisions with status='injected' for this session that don't yet
   * have any row in memory_implicit_signals.
   */
  getUncomputedDecisionsForSession(
    contentSessionId: string,
    limit = 50
  ): Array<{ decision_id: number; trace_items_json: string | null; created_at_epoch: number }> {
    return this.db.prepare(`
      SELECT d.id as decision_id, d.trace_items_json, d.created_at_epoch
      FROM memory_assist_decisions d
      WHERE d.content_session_id = ?
        AND d.status = 'injected'
        AND NOT EXISTS (
          SELECT 1 FROM memory_implicit_signals s WHERE s.decision_id = d.id
        )
      ORDER BY d.created_at_epoch DESC
      LIMIT ?
    `).all(contentSessionId, limit) as Array<{ decision_id: number; trace_items_json: string | null; created_at_epoch: number }>;
  }

  /**
   * Insert a single implicit signal row. No dedup guard here — callers
   * (persistImplicitSignals) are responsible for filtering duplicates.
   */
  insertImplicitSignal(
    decisionId: number,
    observationId: number,
    kind: 'file_reuse' | 'content_cited' | 'no_overlap',
    evidence: string | null,
    confidence: number,
    computedAtEpoch: number
  ): void {
    this.db.prepare(`
      INSERT INTO memory_implicit_signals
        (decision_id, observation_id, signal_kind, evidence, confidence, computed_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(decisionId, observationId, kind, evidence, confidence, computedAtEpoch);
  }

  /**
   * Ensure merged_into_project columns + indices exist on observations and session_summaries.
   *
   * Self-idempotent via PRAGMA table_info guard — does NOT bump schema_versions.
   * Mirrors MigrationRunner.ensureMergedIntoProjectColumns so bundled artifacts
   * that embed SessionStore (e.g. context-generator.cjs) stay schema-consistent
   * with the standalone migration path.
   */
  private ensureMergedIntoProjectColumns(): void {
    const obsCols = this.db
      .query('PRAGMA table_info(observations)')
      .all() as TableColumnInfo[];
    if (!obsCols.some(c => c.name === 'merged_into_project')) {
      this.db.run('ALTER TABLE observations ADD COLUMN merged_into_project TEXT');
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)'
    );

    const sumCols = this.db
      .query('PRAGMA table_info(session_summaries)')
      .all() as TableColumnInfo[];
    if (!sumCols.some(c => c.name === 'merged_into_project')) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT');
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)'
    );
  }

  private addObservationSubagentColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(27) as SchemaVersion | undefined;

    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasAgentType = obsCols.some(col => col.name === 'agent_type');
    const obsHasAgentId = obsCols.some(col => col.name === 'agent_id');

    if (!obsHasAgentType) {
      this.db.run('ALTER TABLE observations ADD COLUMN agent_type TEXT');
    }
    if (!obsHasAgentId) {
      this.db.run('ALTER TABLE observations ADD COLUMN agent_id TEXT');
    }
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)');

    const pendingCols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    if (pendingCols.length > 0) {
      const pendingHasAgentType = pendingCols.some(col => col.name === 'agent_type');
      const pendingHasAgentId = pendingCols.some(col => col.name === 'agent_id');
      if (!pendingHasAgentType) {
        this.db.run('ALTER TABLE pending_messages ADD COLUMN agent_type TEXT');
      }
      if (!pendingHasAgentId) {
        this.db.run('ALTER TABLE pending_messages ADD COLUMN agent_id TEXT');
      }
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(27, new Date().toISOString());
    }
  }

  private ensurePendingMessagesToolUseIdColumn(): void {
    const tables = this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
    ).all() as TableNameRow[];
    if (tables.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
      return;
    }

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasToolUseId = cols.some(c => c.name === 'tool_use_id');

    if (!hasToolUseId) {
      this.db.run('ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT');
    }

    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run(`
        DELETE FROM pending_messages
         WHERE id IN (
           SELECT id
             FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY content_session_id, tool_use_id
                        ORDER BY CASE status
                          WHEN 'processing' THEN 0
                          WHEN 'pending' THEN 1
                          ELSE 2
                        END, id
                      ) AS duplicate_rank
                 FROM pending_messages
                WHERE tool_use_id IS NOT NULL
             )
            WHERE duplicate_rank > 1
           )
      `);
      this.db.run(`
        -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
        -- only for rows that came from a concrete tool-use event.
        CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
        ON pending_messages(content_session_id, tool_use_id)
        WHERE tool_use_id IS NOT NULL
      `);

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  private addObservationsUniqueContentHashIndex(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(29) as SchemaVersion | undefined;
    if (applied) return;

    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasMem = obsCols.some(c => c.name === 'memory_session_id');
    const hasHash = obsCols.some(c => c.name === 'content_hash');
    if (!hasMem || !hasHash) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
      return;
    }

    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run(`
        DELETE FROM observations
         WHERE id NOT IN (
           SELECT MIN(id) FROM observations
            GROUP BY memory_session_id, content_hash
         )
      `);
      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
        ON observations(memory_session_id, content_hash)
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  private addObservationsMetadataColumn(): void {
    const cols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasColumn = cols.some(c => c.name === 'metadata');

    if (!hasColumn) {
      this.db.run('ALTER TABLE observations ADD COLUMN metadata TEXT');
      logger.debug('DB', 'Added metadata column to observations table (#2116)');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(30, new Date().toISOString());
  }

  updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): void {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(memorySessionId, sessionDbId);
  }

  markSessionCompleted(sessionDbId: number): void {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(nowIso, nowEpoch, sessionDbId);
  }

  ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): void {
    const session = this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId) as { id: number; memory_session_id: string | null } | undefined;

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }

    if (session.memory_session_id !== memorySessionId) {
      this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(memorySessionId, sessionDbId);

      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId
      });
    }
  }

  getRecentSummaries(project: string, limit: number = 10): Array<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit) as Array<{
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      prompt_number: number | null;
      created_at: string;
    }>;
  }

  getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Array<{
    memory_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit) as Array<{
      memory_session_id: string;
      request: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      prompt_number: number | null;
      created_at: string;
    }>;
  }

  getRecentObservations(project: string, limit: number = 20): Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit) as Array<{
      type: string;
      text: string;
      prompt_number: number | null;
      created_at: string;
    }>;
  }

  getAllRecentObservations(limit: number = 100): Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit) as Array<{
      id: number;
      type: string;
      title: string | null;
      subtitle: string | null;
      text: string;
      project: string;
      platform_source: string;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getAllRecentSummaries(limit: number = 50): Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        ss.id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.files_read,
        ss.files_edited,
        ss.notes,
        ss.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit) as Array<{
      id: number;
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      project: string;
      platform_source: string;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getAllRecentUserPrompts(limit: number = 100): Array<{
    id: number;
    content_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit) as Array<{
      id: number;
      content_session_id: string;
      project: string;
      platform_source: string;
      prompt_number: number;
      prompt_text: string;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getAllProjects(platformSource?: string): string[] {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let query = `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `;
    const params: SQLQueryBindings[] = [OBSERVER_SESSIONS_PROJECT];

    if (normalizedPlatformSource) {
      query += ' AND COALESCE(platform_source, ?) = ?';
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }

    query += ' ORDER BY project ASC';

    const rows = this.db.prepare(query).all(...params) as Array<{ project: string }>;
    return rows.map(row => row.project);
  }

  getProjectCatalog(): {
    projects: string[];
    sources: string[];
    projectsBySource: Record<string, string[]>;
  } {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}'), project
      ORDER BY latest_epoch DESC
    `).all(OBSERVER_SESSIONS_PROJECT) as Array<{ platform_source: string; project: string; latest_epoch: number }>;

    const projects: string[] = [];
    const seenProjects = new Set<string>();
    const projectsBySource: Record<string, string[]> = {};

    for (const row of rows) {
      const source = normalizePlatformSource(row.platform_source);

      if (!projectsBySource[source]) {
        projectsBySource[source] = [];
      }

      if (!projectsBySource[source].includes(row.project)) {
        projectsBySource[source].push(row.project);
      }

      if (!seenProjects.has(row.project)) {
        seenProjects.add(row.project);
        projects.push(row.project);
      }
    }

    const sources = sortPlatformSources(Object.keys(projectsBySource));

    return {
      projects,
      sources,
      projectsBySource: Object.fromEntries(
        sources.map(source => [source, projectsBySource[source] || []])
      )
    };
  }

  getLatestUserPrompt(contentSessionId: string): {
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined {
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `);

    return stmt.get(contentSessionId) as LatestPromptResult | undefined;
  }

  /**
   * Get the latest saved user prompt timestamp for a session.
   * Used by worker wall-clock guards so active prompting resets the age budget.
   */
  getLatestUserPromptEpoch(contentSessionId: string): number | null {
    const stmt = this.db.prepare(`
      SELECT MAX(created_at_epoch) as latest_epoch
      FROM user_prompts
      WHERE content_session_id = ?
    `);

    const result = stmt.get(contentSessionId) as { latest_epoch: number | null } | undefined;
    return result?.latest_epoch ?? null;
  }

  /**
   * Get the latest pending-work activity timestamp for a session.
   * Considers both enqueue time and processing start time for in-flight work.
   */
  getLatestPendingWorkEpoch(sessionDbId: number): number | null {
    const stmt = this.db.prepare(`
      SELECT MAX(epoch) as latest_epoch
      FROM (
        SELECT created_at_epoch as epoch
        FROM pending_messages
        WHERE session_db_id = ? AND status IN ('pending', 'processing')
        UNION ALL
        SELECT started_processing_at_epoch as epoch
        FROM pending_messages
        WHERE session_db_id = ? AND status = 'processing' AND started_processing_at_epoch IS NOT NULL
      )
    `);

    const result = stmt.get(sessionDbId, sessionDbId) as { latest_epoch: number | null } | undefined;
    return result?.latest_epoch ?? null;
  }

  /**
   * Get recent sessions with their status and summary info
   */
  getRecentSessionsWithStatus(project: string, limit: number = 3): Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `);

    return stmt.all(project, limit) as Array<{
      memory_session_id: string | null;
      status: string;
      started_at: string;
      user_prompt: string | null;
      has_summary: boolean;
    }>;
  }

  getObservationsForSession(memorySessionId: string): Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `);

    return stmt.all(memorySessionId) as Array<{
      title: string;
      subtitle: string;
      type: string;
      prompt_number: number | null;
    }>;
  }

  getObservationById(id: number): ObservationRecord | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `);

    return stmt.get(id) as ObservationRecord | undefined || null;
  }

  getObservationOrigin(id: number): ObservationToolOriginRecord | null {
    return getObservationOrigin(this.db, id);
  }

  recordObservationFeedback(
    observationIds: number[],
    signalType: ObservationFeedbackSignal,
    sessionDbId?: number | null,
    metadata?: Record<string, unknown>
  ): void {
    recordObservationFeedback(this.db, observationIds, signalType, sessionDbId, metadata);
  }

  getObservationFeedbackStats(windowDays = 30): ObservationFeedbackStats {
    return getObservationFeedbackStats(this.db, windowDays);
  }

  recordMemoryAssistDecision(
    report: MemoryAssistReport & {
      shadowRanking?: MemoryAssistDecisionRecord['shadowRanking'];
      systemVerdict?: MemoryAssistDecisionRecord['systemVerdict'];
      systemConfidence?: MemoryAssistDecisionRecord['systemConfidence'];
      systemReasons?: string[];
      systemEvidence?: MemoryAssistDecisionRecord['systemEvidence'];
    }
  ): MemoryAssistDecisionRecord {
    const derivedPromptNumber = report.contentSessionId
      ? this.getPromptNumberFromUserPrompts(report.contentSessionId)
      : undefined;
    const promptNumber = report.promptNumber
      ?? (derivedPromptNumber && derivedPromptNumber > 0 ? derivedPromptNumber : undefined);
    const decision = recordMemoryAssistDecision(this.db, {
      ...report,
      promptNumber,
    });
    return this.refreshMemoryAssistDecisionVerdict(decision.id) ?? decision;
  }

  getRecentMemoryAssistDecisions(
    options: {
      limit?: number;
      windowDays?: number;
      source?: MemoryAssistDecisionRecord['source'];
      project?: string;
      contentSessionId?: string;
    } = {}
  ): MemoryAssistDecisionRecord[] {
    return getRecentMemoryAssistDecisions(this.db, options);
  }

  getRecentlyInjectedIds(
    contentSessionId: string,
    currentPromptNumber: number,
    windowSize: number
  ): Set<number> {
    return getRecentlyInjectedIds(this.db, contentSessionId, currentPromptNumber, windowSize);
  }

  recordMemoryAssistOutcomeSignal(signal: MemoryAssistOutcomeSignal): MemoryAssistOutcomeSignal {
    const promptNumber = signal.promptNumber
      ?? (typeof signal.metadata?.promptNumber === 'number' ? signal.metadata.promptNumber : undefined);
    const decisionId = signal.decisionId
      ?? this.resolveMemoryAssistDecisionId({
        ...signal,
        promptNumber,
      });

    const persisted = recordMemoryAssistOutcomeSignal(this.db, {
      ...signal,
      promptNumber,
      decisionId,
    });

    if (decisionId) {
      this.refreshMemoryAssistDecisionVerdict(decisionId);
    }

    return persisted;
  }

  /**
   * Retroactively link an orphan outcome_signal (decision_id IS NULL) to a decision
   * using the current resolver. Used by scripts/backfill-outcome-signal-links.mjs.
   * Returns the newly-linked decisionId, or null if no candidate was resolvable.
   */
  relinkOrphanOutcomeSignal(signalId: number): number | null {
    const row = this.db.prepare(`
      SELECT content_session_id, prompt_number, file_path, related_file_paths_json,
             concepts_json, tool_name, action, signal_type, created_at_epoch
      FROM memory_assist_outcome_signals
      WHERE id = ? AND decision_id IS NULL
    `).get(signalId) as {
      content_session_id: string | null;
      prompt_number: number | null;
      file_path: string | null;
      related_file_paths_json: string | null;
      concepts_json: string | null;
      tool_name: string;
      action: string;
      signal_type: string;
      created_at_epoch: number;
    } | undefined;

    if (!row || !row.content_session_id || !row.prompt_number) {
      return null;
    }

    const relatedFilePaths = row.related_file_paths_json
      ? (JSON.parse(row.related_file_paths_json) as string[])
      : [];
    const concepts = row.concepts_json ? (JSON.parse(row.concepts_json) as string[]) : [];

    const synthSignal: MemoryAssistOutcomeSignal = {
      contentSessionId: row.content_session_id,
      promptNumber: row.prompt_number,
      filePath: row.file_path,
      relatedFilePaths,
      concepts,
      toolName: row.tool_name,
      action: row.action as MemoryAssistOutcomeSignal['action'],
      signalType: row.signal_type as MemoryAssistOutcomeSignal['signalType'],
      timestamp: row.created_at_epoch,
    };

    const decisionId = this.resolveMemoryAssistDecisionId(synthSignal);
    if (!decisionId) {
      return null;
    }

    this.db.prepare(`
      UPDATE memory_assist_outcome_signals SET decision_id = ? WHERE id = ?
    `).run(decisionId, signalId);

    return decisionId;
  }

  /**
   * Bulk fetch of orphan outcome_signal ids for the backfill script. Returns ids
   * only (script calls relinkOrphanOutcomeSignal per id to reuse resolver logic).
   */
  listOrphanOutcomeSignalIds(sinceEpoch: number): number[] {
    const rows = this.db.prepare(`
      SELECT id FROM memory_assist_outcome_signals
      WHERE decision_id IS NULL
        AND content_session_id IS NOT NULL
        AND prompt_number IS NOT NULL
        AND created_at_epoch >= ?
      ORDER BY created_at_epoch ASC
    `).all(sinceEpoch) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  attachGeneratedObservationsToOutcomeSignal(
    pendingMessageId: number,
    observationIds: number[]
  ): MemoryAssistOutcomeSignal | null {
    if (observationIds.length === 0) return null;

    const merged = attachGeneratedObservationsToOutcomeSignal(this.db, pendingMessageId, observationIds);
    if (merged.length === 0) return null;

    const outcome = this.db.prepare(`
      SELECT *
      FROM memory_assist_outcome_signals
      WHERE pending_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(pendingMessageId) as {
      id: number;
      decision_id: number | null;
      source: string | null;
      prompt_number: number | null;
      content_session_id: string | null;
      session_db_id: number | null;
      project: string | null;
      platform_source: string | null;
      signal_type: string;
      tool_name: string;
      action: string;
      file_path: string | null;
      related_file_paths_json: string | null;
      concepts_json: string | null;
      generated_observation_ids_json: string | null;
      metadata_json: string | null;
      created_at_epoch: number;
    } | undefined;

    if (!outcome) return null;

    const hydrated: MemoryAssistOutcomeSignal = {
      id: outcome.id,
      decisionId: outcome.decision_id,
      pendingMessageId,
      source: outcome.source as MemoryAssistOutcomeSignal['source'],
      promptNumber: outcome.prompt_number ?? undefined,
      contentSessionId: outcome.content_session_id ?? undefined,
      sessionDbId: outcome.session_db_id ?? undefined,
      project: outcome.project ?? undefined,
      platformSource: outcome.platform_source ?? undefined,
      signalType: outcome.signal_type as MemoryAssistOutcomeSignal['signalType'],
      toolName: outcome.tool_name,
      action: outcome.action as MemoryAssistOutcomeSignal['action'],
      filePath: outcome.file_path,
      relatedFilePaths: outcome.related_file_paths_json ? JSON.parse(outcome.related_file_paths_json) : [],
      concepts: outcome.concepts_json ? JSON.parse(outcome.concepts_json) : [],
      generatedObservationIds: merged,
      metadata: outcome.metadata_json ? JSON.parse(outcome.metadata_json) : {},
      timestamp: outcome.created_at_epoch,
    };

    if (hydrated.decisionId) {
      this.refreshMemoryAssistDecisionVerdict(hydrated.decisionId);
    }

    return hydrated;
  }

  attachObservationOriginsToPendingMessage(
    pendingMessageId: number,
    observationIds: number[]
  ): ObservationToolOriginRecord[] {
    return attachObservationOriginsToPendingMessage(this.db, pendingMessageId, observationIds);
  }

  /**
   * Register a context-based origin for observations that did not come from a
   * tool call. See memory-assist/origins.ts docblock for the "why".
   */
  insertContextOrigin(
    observationId: number,
    contextType: ObservationContextType,
    contextRef: Record<string, unknown>,
    createdAtEpoch?: number
  ): ObservationToolOriginRecord | null {
    return insertContextOrigin(this.db, observationId, contextType, contextRef, createdAtEpoch);
  }

  /**
   * Return all origin rows (tool-based + context-based) for an observation.
   * Used by the trace endpoint so the UI can render whichever kind exists.
   */
  getObservationOrigins(observationId: number): ObservationToolOriginRecord[] {
    return getObservationOrigins(this.db, observationId);
  }

  private resolveMemoryAssistDecisionId(signal: MemoryAssistOutcomeSignal): number | null {
    if (!signal.contentSessionId || !signal.promptNumber) {
      return null;
    }

    // Use the signal's timestamp as the window anchor so backfill replays resolve
    // identically to live — otherwise historical signals see only "now" and fetch
    // zero candidates.
    const signalTimestamp = signal.timestamp ?? Date.now();
    const candidates = getMemoryAssistDecisionsForPrompt(
      this.db,
      signal.contentSessionId,
      signal.promptNumber,
      15 * 60 * 1000,
      signalTimestamp
    );

    if (candidates.length === 0) {
      return null;
    }

    const injectedCandidates = candidates.filter((decision) => decision.status === 'injected');
    if (injectedCandidates.length === 0) {
      return null;
    }

    const signalPaths = collectSignalPaths(signal);
    const overlappingFileCandidates = injectedCandidates.filter((decision) => {
      if (decision.source !== 'file_context') return false;
      if (signalPaths.size === 0) return false;
      const decisionPaths = collectDecisionPaths(decision);
      return [...signalPaths].some((path) => decisionPaths.has(path));
    });
    if (overlappingFileCandidates.length > 0) {
      return pickMostRecent(overlappingFileCandidates).id;
    }

    const semanticCandidates = injectedCandidates.filter((decision) => decision.source === 'semantic_prompt');
    if (semanticCandidates.length > 0) {
      return pickMostRecent(semanticCandidates).id;
    }

    // Nearest-in-time fallback: tool calls that don't overlap any injected file path
    // (e.g. Bash, Grep without path, or a Read outside the injected file set) still
    // belong to the most likely decision — the one that just fired. Prefer a decision
    // at-or-before the signal; otherwise fall back to the most recent overall so the
    // link is never NULL when an injected candidate exists in the window.
    return pickNearestInTime(injectedCandidates, signalTimestamp).id;
  }

  attachMemoryAssistDecisionFeedback(
    decisionId: number,
    label: MemoryAssistFeedbackLabel
  ): void {
    attachMemoryAssistDecisionFeedback(this.db, decisionId, label);
    this.refreshMemoryAssistDecisionVerdict(decisionId, label);
  }

  getMemoryAssistDashboard(windowDays = 30): MemoryAssistDashboard & ObservationFeedbackStats {
    // Dashboard aggregates must reflect the full window, not a top-N clamp.
    // A prior session raised the cap in decisions.ts from 200 to 10_000 but left
    // this dashboard path silently clamped at 500, so 30-day windows with >500
    // decisions produced systematically under-counted rates, wrong recommended
    // actions (confidence 80% on bad data), and misleading skip-reason charts.
    // 10_000 matches the decisions.ts convention and covers any realistic window.
    const decisions = getRecentMemoryAssistDecisions(this.db, { limit: 10_000, windowDays });
    return getMemoryAssistDashboard(this.db, decisions, windowDays);
  }

  backfillRecentFileContextTokenEstimates(
    options: {
      limit?: number;
      windowDays?: number;
    } = {}
  ): { updatedCount: number } {
    const decisions = getRecentMemoryAssistDecisions(this.db, {
      limit: options.limit ?? 200,
      windowDays: options.windowDays ?? 30,
      source: 'file_context',
    });

    let updatedCount = 0;
    for (const decision of decisions) {
      if (decision.status !== 'injected') continue;
      if ((decision.estimatedInjectedTokens ?? 0) > 0) continue;
      const estimate = estimateTimelineTokensFromTraceItems(decision.traceItems, decision.filePath);
      if (estimate <= 0) continue;
      this.db.prepare(`
        UPDATE memory_assist_decisions
        SET estimated_injected_tokens = ?,
            updated_at_epoch = ?
        WHERE id = ?
      `).run(estimate, Date.now(), decision.id);
      updatedCount += 1;
    }

    logger.debug('DB', `memory-assist-decisions: backfilled file-context token estimates for ${updatedCount} decisions`);
    return { updatedCount };
  }

  backfillRecentMemoryAssistEvidence(
    options: {
      limit?: number;
      windowDays?: number;
    } = {}
  ): MemoryAssistDecisionRecord[] {
    const decisions = getRecentMemoryAssistDecisions(this.db, {
      limit: options.limit ?? 200,
      windowDays: options.windowDays ?? 30,
    });

    const refreshed = decisions.map((decision) => (
      this.refreshMemoryAssistDecisionVerdict(decision.id) ?? decision
    ));

    return refreshed;
  }

  backfillRecentObservationOrigins(
    options: {
      limit?: number;
      windowDays?: number;
    } = {}
  ): { resolvedCount: number; unresolvedCount: number } {
    return backfillRecentObservationOrigins(this.db, options);
  }

  getMemoryAssistCalibrationSnapshot(): MemoryAssistCalibrationSnapshot {
    return getMemoryAssistCalibrationSnapshot(this.db);
  }

  recordObservationTypeCorrection(input: {
    modeId: string;
    originalType: string;
    normalizedType: string;
    fallbackType: string;
    strategy: 'alias' | 'fallback';
    correlationId?: string;
    project?: string;
    platformSource?: string;
  }): void {
    recordObservationTypeCorrection(this.db, input);
  }

  /**
   * Re-run the system judge for a decision. Idempotent — safe to call any number of
   * times. Public so post-hoc backfill tooling (scripts/backfill-outcome-signal-links.mjs)
   * can refresh verdicts after relinking orphan signals.
   */
  refreshMemoryAssistDecisionVerdict(
    decisionId: number,
    feedback?: MemoryAssistFeedbackLabel | null
  ): MemoryAssistDecisionRecord | null {
    const [decision] = getDecisionRowsForIds(this.db, [decisionId]);
    if (!decision) return null;

    const outcomesByDecisionId = getOutcomeSignalsForDecisionIds(this.db, [decisionId]);
    const result = judgeMemoryAssistDecision(
      decision,
      outcomesByDecisionId[decisionId] ?? [],
      feedback
    );

    updateMemoryAssistDecisionVerdict(
      this.db,
      decisionId,
      result.verdict,
      result.confidence,
      result.reasons,
      result.evidence
    );

    return getDecisionRowsForIds(this.db, [decisionId])[0] ?? null;
  }

  /**
   * Get observations by array of IDs with ordering and limit
   */
  getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): ObservationSearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit ? `LIMIT ${limit}` : '';

    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (project) {
      additionalConditions.push('project = ?');
      params.push(project);
    }

    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => '?').join(',');
        additionalConditions.push(`type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push('type = ?');
        params.push(type);
      }
    }

    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(() =>
        'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileConditions = filesList.map(() => {
        return '(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))';
      });
      filesList.forEach(file => {
        params.push(`%${file}%`, `%${file}%`);
      });
      additionalConditions.push(`(${fileConditions.join(' OR ')})`);
    }

    const whereClause = additionalConditions.length > 0
      ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
      : `WHERE id IN (${placeholders})`;

    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as ObservationSearchResult[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => rowMap.get(id)).filter((r): r is ObservationSearchResult => !!r);
  }

  /**
   * Returns up to `limit` chronologically oldest observations that touched any of
   * the given files, created before `beforeEpoch`. Used to inject file-context
   * timeline into observation prompts.
   */
  getPriorObservationsForFiles(
    files: string[],
    beforeEpoch: number,
    limit = 3
  ): string[] {
    if (files.length === 0) return [];

    const conditions = files
      .map(() =>
        `(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR
          EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))`
      )
      .join(' OR ');

    const params: unknown[] = files.flatMap(f => [`%${f}%`, `%${f}%`]);

    const rows = this.db.prepare(`
      SELECT type, title, created_at_epoch
      FROM observations
      WHERE (${conditions}) AND created_at_epoch < ?
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `).all(...(params as SQLQueryBindings[]), beforeEpoch, limit) as Array<{
      type: string; title: string | null; created_at_epoch: number;
    }>;

    return rows.map(r => {
      const time = new Date(r.created_at_epoch)
        .toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `${time} [${r.type}] ${(r.title ?? '').slice(0, 100)}`;
    });
  }

  /**
   * Get summary for a specific session
   */
  getSummaryForSession(memorySessionId: string): {
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `);

    return (stmt.get(memorySessionId) as {
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    } | null) || null;
  }

  getFilesForSession(memorySessionId: string): {
    filesRead: string[];
    filesModified: string[];
  } {
    const stmt = this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `);

    const rows = stmt.all(memorySessionId) as Array<{
      files_read: string | null;
      files_modified: string | null;
    }>;

    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();

    for (const row of rows) {
      parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

      parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
    }

    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }

  getSessionById(id: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  } | null {
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as {
      id: number;
      content_session_id: string;
      memory_session_id: string | null;
      project: string;
      platform_source: string;
      user_prompt: string;
      custom_title: string | null;
      status: string;
    } | null) || null;
  }

  getSdkSessionsBySessionIds(memorySessionIds: string[]): {
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[] {
    if (memorySessionIds.length === 0) return [];

    const placeholders = memorySessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `);

    return stmt.all(...memorySessionIds) as any[];
  }

  getPromptNumberFromUserPrompts(contentSessionId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(contentSessionId) as { count: number };
    return result.count;
  }

  createSDKSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    customTitle?: string,
    platformSource?: string
  ): number {
    const now = new Date();
    const nowEpoch = now.getTime();
    const resolved = resolveCreateSessionArgs(customTitle, platformSource);
    const normalizedPlatformSource = resolved.platformSource ?? DEFAULT_PLATFORM_SOURCE;

    const existing = this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(contentSessionId) as { id: number; platform_source: string | null } | undefined;

    if (existing) {
      if (project) {
        this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(project, contentSessionId);
      }
      if (resolved.customTitle) {
        this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(resolved.customTitle, contentSessionId);
      }

      if (resolved.platformSource) {
        const storedPlatformSource = existing.platform_source?.trim()
          ? normalizePlatformSource(existing.platform_source)
          : undefined;

        if (!storedPlatformSource) {
          this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(resolved.platformSource, contentSessionId);
        } else if (storedPlatformSource !== resolved.platformSource) {
          throw new Error(
            `Platform source conflict for session ${contentSessionId}: existing=${storedPlatformSource}, received=${resolved.platformSource}`
          );
        }
      }
      return existing.id;
    }

    this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, now.toISOString(), nowEpoch);

    const row = this.db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
      .get(contentSessionId) as { id: number };
    return row.id;
  }

  saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch);
    return result.lastInsertRowid as number;
  }

  getUserPrompt(contentSessionId: string, promptNumber: number): string | null {
    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);

    const result = stmt.get(contentSessionId, promptNumber) as { prompt_text: string } | undefined;
    return result?.prompt_text ?? null;
  }

  storeObservation(
    memorySessionId: string,
    project: string,
    observation: {
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      why?: string | null;
      alternatives_rejected?: string | null;
      related_observation_ids?: number[];
      agent_type?: string | null;
      agent_id?: string | null;
      metadata?: string | null;
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string,
    captureSource?: CaptureSnapshotSource
  ): { id: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
       generated_by_model, metadata, why, alternatives_rejected, related_observation_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id, created_at_epoch
    `);

    const inserted = stmt.get(
      memorySessionId,
      project,
      observation.type,
      observation.title,
      observation.subtitle,
      JSON.stringify(observation.facts),
      observation.narrative,
      JSON.stringify(observation.concepts),
      JSON.stringify(observation.files_read),
      JSON.stringify(observation.files_modified),
      promptNumber || null,
      discoveryTokens,
      observation.agent_type ?? null,
      observation.agent_id ?? null,
      contentHash,
      timestampIso,
      timestampEpoch,
      generatedByModel || null,
      observation.metadata ?? null,
      observation.why ?? null,
      observation.alternatives_rejected ?? null,
      observation.related_observation_ids && observation.related_observation_ids.length > 0
        ? JSON.stringify(observation.related_observation_ids)
        : null
    ) as { id: number; created_at_epoch: number } | null;

    if (inserted) {
      insertCaptureSnapshot(
        this.db,
        inserted.id,
        captureSource ?? emptyCaptureSnapshotSource(memorySessionId, null, promptNumber ?? null),
        capturedFromObservation(observation),
        timestampEpoch
      );
      return { id: inserted.id, createdAtEpoch: inserted.created_at_epoch };
    }

    const existing = this.db.prepare(
      'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?'
    ).get(memorySessionId, contentHash) as { id: number; created_at_epoch: number } | null;

    if (!existing) {
      throw new Error(
        `storeObservation: ON CONFLICT without existing row for content_hash=${contentHash}`
      );
    }
    return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
  }

  storeSummary(
    memorySessionId: string,
    project: string,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): { id: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      memorySessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      promptNumber || null,
      discoveryTokens,
      timestampIso,
      timestampEpoch
    );

    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }

  storeObservations(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      why?: string | null;
      alternatives_rejected?: string | null;
      related_observation_ids?: number[];
      agent_type?: string | null;
      agent_id?: string | null;
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string,
    captureSource?: CaptureSnapshotSource
  ): { observationIds: number[]; summaryId: number | null; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const storeTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `);
      const lookupExistingStmt = this.db.prepare(
        'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
      );

      const snapshotSource =
        captureSource ?? emptyCaptureSnapshotSource(memorySessionId, null, promptNumber ?? null);

      for (const observation of observations) {
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const inserted = obsStmt.get(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          observation.agent_type ?? null,
          observation.agent_id ?? null,
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null,
          observation.why ?? null,
          observation.alternatives_rejected ?? null,
          observation.related_observation_ids && observation.related_observation_ids.length > 0
            ? JSON.stringify(observation.related_observation_ids)
            : null
        ) as { id: number } | null;

        if (inserted) {
          observationIds.push(inserted.id);
          // Capture snapshot pairs source inputs with captured outputs so later
          // rubric runs have ground truth. Same transaction, same fate.
          insertCaptureSnapshot(
            this.db,
            inserted.id,
            snapshotSource,
            capturedFromObservation(observation),
            timestampEpoch
          );
          continue;
        }

        const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
        if (!existing) {
          throw new Error(
            `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`
          );
        }
        observationIds.push(existing.id);
      }

      let summaryId: number | null = null;
      if (summary) {
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    return storeTx();
  }

  storeObservationsAndMarkComplete(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      why?: string | null;
      alternatives_rejected?: string | null;
      related_observation_ids?: number[];
      agent_type?: string | null;
      agent_id?: string | null;
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    messageId: number,
    _pendingStore: PendingMessageStore,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string,
    captureSource?: CaptureSnapshotSource
  ): { observationIds: number[]; summaryId?: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const storeAndMarkTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `);
      const lookupExistingStmt = this.db.prepare(
        'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
      );

      const snapshotSource =
        captureSource ?? emptyCaptureSnapshotSource(memorySessionId, null, promptNumber ?? null);

      for (const observation of observations) {
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const inserted = obsStmt.get(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          observation.agent_type ?? null,
          observation.agent_id ?? null,
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null,
          observation.why ?? null,
          observation.alternatives_rejected ?? null,
          observation.related_observation_ids && observation.related_observation_ids.length > 0
            ? JSON.stringify(observation.related_observation_ids)
            : null
        ) as { id: number } | null;

        if (inserted) {
          observationIds.push(inserted.id);
          // Capture snapshot pairs source inputs with captured outputs (same transaction).
          insertCaptureSnapshot(
            this.db,
            inserted.id,
            snapshotSource,
            capturedFromObservation(observation),
            timestampEpoch
          );
          continue;
        }

        const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
        if (!existing) {
          throw new Error(
            `storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${contentHash}`
          );
        }
        observationIds.push(existing.id);
      }

      let summaryId: number | undefined;
      if (summary) {
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }

      // Current queue rows are live work only; completed work is removed, not retained as processed.
      const deleteStmt = this.db.prepare(`
        DELETE FROM pending_messages
        WHERE id = ? AND status = 'processing'
      `);
      const deleteResult = deleteStmt.run(messageId);
      if (deleteResult.changes !== 1) {
        throw new Error(`storeObservationsAndMarkComplete: failed to complete pending message ${messageId}`);
      }

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    return storeAndMarkTx();
  }

  getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string } = {}
  ): SessionSummarySearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    const whereClause = project
      ? `WHERE id IN (${placeholders}) AND project = ?`
      : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT * FROM session_summaries
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as SessionSummarySearchResult[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => rowMap.get(id)).filter((r): r is SessionSummarySearchResult => !!r);
  }

  getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string } = {}
  ): UserPromptRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY up.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    const projectFilter = project ? 'AND s.project = ?' : '';
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as UserPromptRecord[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => rowMap.get(id)).filter((r): r is UserPromptRecord => !!r);
  }

  getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    const projectFilter = project ? 'AND project = ?' : '';
    const projectParams = project ? [project] : [];

    let startEpoch: number;
    let endEpoch: number;

    if (anchorObservationId !== null) {
      const beforeQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${projectFilter}
        ORDER BY id DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${projectFilter}
        ORDER BY id ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorObservationId, ...projectParams, depthBefore + 1) as Array<{id: number; created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorObservationId, ...projectParams, depthAfter + 1) as Array<{id: number; created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error('DB', 'Error getting boundary observations', { project }, err);
        } else {
          logger.error('DB', 'Error getting boundary observations with non-Error', {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      const beforeQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${projectFilter}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...projectParams, depthBefore) as Array<{created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...projectParams, depthAfter + 1) as Array<{created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error('DB', 'Error getting boundary timestamps', { project }, err);
        } else {
          logger.error('DB', 'Error getting boundary timestamps with non-Error', {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    }

    const obsQuery = `
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const sessQuery = `
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
      ORDER BY up.created_at_epoch ASC
    `;

    const observations = this.db.prepare(obsQuery).all(startEpoch, endEpoch, ...projectParams) as ObservationRecord[];
    const sessions = this.db.prepare(sessQuery).all(startEpoch, endEpoch, ...projectParams) as SessionSummaryRecord[];
    const prompts = this.db.prepare(promptQuery).all(startEpoch, endEpoch, ...projectParams) as UserPromptRecord[];

    return {
      observations,
      sessions: sessions.map(s => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch
      })),
      prompts: prompts.map(p => ({
        id: p.id,
        content_session_id: p.content_session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        project: p.project,
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }

  getPromptById(id: number): {
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as {
      id: number;
      content_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    } | null) || null;
  }

  getPromptsByIds(ids: number[]): Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${placeholders})
      ORDER BY p.created_at_epoch DESC
    `);

    return stmt.all(...ids) as Array<{
      id: number;
      content_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getSessionSummaryById(id: number): {
    id: number;
    memory_session_id: string | null;
    content_session_id: string;
    project: string;
    user_prompt: string;
    request_summary: string | null;
    learned_summary: string | null;
    status: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as {
      id: number;
      memory_session_id: string | null;
      content_session_id: string;
      project: string;
      user_prompt: string;
      request_summary: string | null;
      learned_summary: string | null;
      status: string;
      created_at: string;
      created_at_epoch: number;
    } | null) || null;
  }

  getOrCreateManualSession(project: string): string {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = this.db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get(memorySessionId) as { memory_session_id: string } | undefined;

    if (existing) {
      return memorySessionId;
    }

    const now = new Date();
    this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(memorySessionId, contentSessionId, project, DEFAULT_PLATFORM_SOURCE, now.toISOString(), now.getTime());

    logger.info('SESSION', 'Created manual session', { memorySessionId, project });

    return memorySessionId;
  }

  /**
   * Batch-fetch retrieval context (user_prompt, prior_assistant_message,
   * content_session_id, prompt_number) for a set of observation IDs.
   *
   * Reads from observation_capture_snapshots (V30). If an observation has no
   * snapshot row, its key is simply absent from the returned Map. When
   * duplicates exist for the same observation_id, the latest by created_at_epoch
   * wins — same tie-break as the capture audit queries.
   */
  getObservationRetrievalContext(
    ids: number[]
  ): Map<number, { user_prompt: string | null; prior_assistant_message: string | null; content_session_id: string | null; prompt_number: number | null }> {
    const result = new Map<number, { user_prompt: string | null; prior_assistant_message: string | null; content_session_id: string | null; prompt_number: number | null }>();
    if (ids.length === 0) return result;

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT observation_id, user_prompt, prior_assistant_message, content_session_id, prompt_number
      FROM observation_capture_snapshots
      WHERE observation_id IN (${placeholders})
      GROUP BY observation_id
      HAVING created_at_epoch = MAX(created_at_epoch)
      ORDER BY observation_id
    `).all(...ids) as Array<{ observation_id: number; user_prompt: string | null; prior_assistant_message: string | null; content_session_id: string | null; prompt_number: number | null }>;

    for (const row of rows) {
      result.set(row.observation_id, {
        user_prompt: row.user_prompt,
        prior_assistant_message: row.prior_assistant_message,
        content_session_id: row.content_session_id,
        prompt_number: row.prompt_number,
      });
    }

    return result;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  importSdkSession(session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source?: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(
      'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
    ).get(session.content_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      session.content_session_id,
      session.memory_session_id,
      session.project,
      normalizePlatformSource(session.platform_source),
      session.user_prompt,
      session.started_at,
      session.started_at_epoch,
      session.completed_at,
      session.completed_at_epoch,
      session.status
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  importSessionSummary(summary: {
    memory_session_id: string;
    project: string;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(
      'SELECT id FROM session_summaries WHERE memory_session_id = ?'
    ).get(summary.memory_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.memory_session_id,
      summary.project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.files_read,
      summary.files_edited,
      summary.notes,
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.created_at,
      summary.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  importObservation(obs: {
    memory_session_id: string;
    project: string;
    text: string | null;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string | null;
    narrative: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
    agent_type?: string | null;
    agent_id?: string | null;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.memory_session_id, obs.title, obs.created_at_epoch) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.memory_session_id,
      obs.project,
      obs.text,
      obs.type,
      obs.title,
      obs.subtitle,
      obs.facts,
      obs.narrative,
      obs.concepts,
      obs.files_read,
      obs.files_modified,
      obs.prompt_number,
      obs.discovery_tokens || 0,
      obs.agent_type ?? null,
      obs.agent_id ?? null,
      obs.created_at,
      obs.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  rebuildObservationsFTSIndex(): void {
    const hasFTS = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all() as { name: string }[]).length > 0;

    if (!hasFTS) {
      return;
    }

    this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  }

  importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(prompt.content_session_id, prompt.prompt_number) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      prompt.content_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at,
      prompt.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }
}
