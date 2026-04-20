import { Database } from 'bun:sqlite';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  SdkSessionRecord,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult
} from '../../types/database.js';
import type { PendingMessageStore } from './PendingMessageStore.js';
import { computeObservationContentHash, findDuplicateObservation } from './observations/store.js';
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

/**
 * Session data store for SDK sessions, observations, and summaries
 * Provides simple, synchronous CRUD operations for session-based memory
 */
export class SessionStore {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }
    this.db = new Database(dbPath);

    // Ensure optimized settings
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');

    // Initialize schema if needed (fresh database)
    this.initializeSchema();

    // Run migrations
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
    this.ensureObservationFeedbackTable();
    this.ensureMemoryAssistTables();
    this.createObservationsFTSIndex();
    this.addObservationDecisionDNAFields();
    this.addCaptureSnapshotTables();
    this.addObservationContextOriginFields();
    this.addMcpInvocationsTable();
    this.addMemoryImplicitSignalsTable();
    this.addLlmRawTypeColumn();
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

  /**
   * Initialize database schema (migration004)
   *
   * ALWAYS creates core tables using CREATE TABLE IF NOT EXISTS — safe to run
   * regardless of schema_versions state.  This fixes issue #979 where the old
   * DatabaseManager migration system (versions 1-7) shared the schema_versions
   * table, causing maxApplied > 0 and skipping core table creation entirely.
   */
  private initializeSchema(): void {
    // Create schema_versions table if it doesn't exist
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    // Always create core tables — IF NOT EXISTS makes this idempotent
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

    // Record migration004 as applied (OR IGNORE handles re-runs safely)
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
  }

  /**
   * Ensure worker_port column exists (migration 5)
   *
   * NOTE: Version 5 conflicts with old DatabaseManager migration005 (which drops orphaned tables).
   * We check actual column state rather than relying solely on version tracking.
   */
  private ensureWorkerPortColumn(): void {
    // Check actual column existence — don't rely on version tracking alone (issue #979)
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

    if (!hasWorkerPort) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
  }

  /**
   * Ensure prompt tracking columns exist (migration 6)
   *
   * NOTE: Version 6 conflicts with old DatabaseManager migration006 (which creates FTS5 tables).
   * We check actual column state rather than relying solely on version tracking.
   */
  private ensurePromptTrackingColumns(): void {
    // Check actual column existence — don't rely on version tracking alone (issue #979)
    // Check sdk_sessions for prompt_counter
    const sessionsInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

    if (!hasPromptCounter) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    // Check observations for prompt_number
    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

    if (!obsHasPromptNumber) {
      this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    // Check session_summaries for prompt_number
    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

    if (!sumHasPromptNumber) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
  }

  /**
   * Remove UNIQUE constraint from session_summaries.memory_session_id (migration 7)
   *
   * NOTE: Version 7 conflicts with old DatabaseManager migration007 (which adds discovery_tokens).
   * We check actual constraint state rather than relying solely on version tracking.
   */
  private removeSessionSummariesUniqueConstraint(): void {
    // Check actual constraint state — don't rely on version tracking alone (issue #979)
    const summariesIndexes = this.db.query('PRAGMA index_list(session_summaries)').all() as IndexInfo[];
    const hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1 && idx.origin !== 'pk');

    if (!hasUniqueConstraint) {
      // Already migrated (no constraint exists)
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    // Begin transaction
    this.db.run('BEGIN TRANSACTION');

    // Clean up leftover temp table from a previously-crashed run
    this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    // Create new table without UNIQUE constraint
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

    // Copy data from old table
    this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);

    // Drop old table
    this.db.run('DROP TABLE session_summaries');

    // Rename new table
    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    // Recreate indexes
    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    // Commit transaction
    this.db.run('COMMIT');

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());

    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  /**
   * Add hierarchical fields to observations table (migration 8)
   */
  private addObservationHierarchicalFields(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(8) as SchemaVersion | undefined;
    if (applied) return;

    // Check if new fields already exist
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasTitle = tableInfo.some(col => col.name === 'title');

    if (hasTitle) {
      // Already migrated
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Adding hierarchical fields to observations table');

    // Add new columns
    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());

    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  /**
   * Make observations.text nullable (migration 9)
   * The text field is deprecated in favor of structured fields (title, subtitle, narrative, etc.)
   */
  private makeObservationsTextNullable(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(9) as SchemaVersion | undefined;
    if (applied) return;

    // Check if text column is already nullable
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const textColumn = tableInfo.find(col => col.name === 'text');

    if (!textColumn || textColumn.notnull === 0) {
      // Already migrated or text column doesn't exist
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Making observations.text nullable');

    // Begin transaction
    this.db.run('BEGIN TRANSACTION');

    // Clean up leftover temp table from a previously-crashed run
    this.db.run('DROP TABLE IF EXISTS observations_new');

    // Create new table with text as nullable
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

    // Copy data from old table (all existing columns)
    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);

    // Drop old table
    this.db.run('DROP TABLE observations');

    // Rename new table
    this.db.run('ALTER TABLE observations_new RENAME TO observations');

    // Recreate indexes
    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);

    // Commit transaction
    this.db.run('COMMIT');

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());

    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  /**
   * Create user_prompts table with FTS5 support (migration 10)
   */
  private createUserPromptsTable(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(10) as SchemaVersion | undefined;
    if (applied) return;

    // Check if table already exists
    const tableInfo = this.db.query('PRAGMA table_info(user_prompts)').all() as TableColumnInfo[];
    if (tableInfo.length > 0) {
      // Already migrated
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    // Begin transaction
    this.db.run('BEGIN TRANSACTION');

    // Create main table (using content_session_id since memory_session_id is set asynchronously by worker)
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

    // Create FTS5 virtual table — skip if FTS5 is unavailable (e.g., Bun on Windows #791).
    // The user_prompts table itself is still created; only FTS indexing is skipped.
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        );
      `);

      // Create triggers to sync FTS5
      this.db.run(`
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
      `);
    } catch (ftsError) {
      logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, ftsError as Error);
    }

    // Commit transaction
    this.db.run('COMMIT');

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());

    logger.debug('DB', 'Successfully created user_prompts table');
  }

  /**
   * Ensure discovery_tokens column exists (migration 11)
   * CRITICAL: This migration was incorrectly using version 7 (which was already taken by removeSessionSummariesUniqueConstraint)
   * The duplicate version number may have caused migration tracking issues in some databases
   */
  private ensureDiscoveryTokensColumn(): void {
    // Check if migration already applied to avoid unnecessary re-runs
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(11) as SchemaVersion | undefined;
    if (applied) return;

    // Check if discovery_tokens column exists in observations table
    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

    if (!obsHasDiscoveryTokens) {
      this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    // Check if discovery_tokens column exists in session_summaries table
    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

    if (!sumHasDiscoveryTokens) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    // Record migration only after successful column verification/addition
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
  }

  /**
   * Create pending_messages table for persistent work queue (migration 16)
   * Messages are persisted before processing and deleted after success.
   * Enables recovery from SDK hangs and worker crashes.
   */
  private createPendingMessagesTable(): void {
    // Check if migration already applied
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(16) as SchemaVersion | undefined;
    if (applied) return;

    // Check if table already exists
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
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());

    logger.debug('DB', 'pending_messages table created successfully');
  }

  /**
   * Rename session ID columns for semantic clarity (migration 17)
   * - claude_session_id → content_session_id (user's observed session)
   * - sdk_session_id → memory_session_id (memory agent's session for resume)
   *
   * IDEMPOTENT: Checks each table individually before renaming.
   * This handles databases in any intermediate state (partial migration, fresh install, etc.)
   */
  private renameSessionIdColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(17) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');

    let renamesPerformed = 0;

    // Helper to safely rename a column if it exists
    const safeRenameColumn = (table: string, oldCol: string, newCol: string): boolean => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const hasOldCol = tableInfo.some(col => col.name === oldCol);
      const hasNewCol = tableInfo.some(col => col.name === newCol);

      if (hasNewCol) {
        // Already renamed, nothing to do
        return false;
      }

      if (hasOldCol) {
        // SQLite 3.25+ supports ALTER TABLE RENAME COLUMN
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      // Neither column exists - table might not exist or has different schema
      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    // Rename in sdk_sessions table
    if (safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in pending_messages table
    if (safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Rename in observations table
    if (safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in session_summaries table
    if (safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    // Rename in user_prompts table
    if (safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    // Record migration
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());

    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  /**
   * Repair session ID column renames (migration 19)
   * DEPRECATED: Migration 17 is now fully idempotent and handles all cases.
   * This migration is kept for backwards compatibility but does nothing.
   */
  private repairSessionIdColumnRename(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(19) as SchemaVersion | undefined;
    if (applied) return;

    // Migration 17 now handles all column rename cases idempotently.
    // Just record this migration as applied.
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(19, new Date().toISOString());
  }

  /**
   * Add failed_at_epoch column to pending_messages (migration 20)
   * Used by markSessionMessagesFailed() for error recovery tracking
   */
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

  /**
   * Add ON UPDATE CASCADE to FK constraints on observations and session_summaries (migration 21)
   *
   * Both tables have FK(memory_session_id) -> sdk_sessions(memory_session_id) with ON DELETE CASCADE
   * but missing ON UPDATE CASCADE. This causes FK constraint violations when code updates
   * sdk_sessions.memory_session_id while child rows still reference the old value.
   *
   * SQLite doesn't support ALTER TABLE for FK changes, so we recreate both tables.
   */
  private addOnUpdateCascadeToForeignKeys(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(21) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    // PRAGMA foreign_keys must be set outside a transaction
    this.db.run('PRAGMA foreign_keys = OFF');
    this.db.run('BEGIN TRANSACTION');

    try {
      // ==========================================
      // 1. Recreate observations table
      // ==========================================

      // Drop FTS triggers first (they reference the observations table)
      this.db.run('DROP TRIGGER IF EXISTS observations_ai');
      this.db.run('DROP TRIGGER IF EXISTS observations_ad');
      this.db.run('DROP TRIGGER IF EXISTS observations_au');

      // Clean up leftover temp table from a previously-crashed run
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
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);

      this.db.run(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, created_at, created_at_epoch
        FROM observations
      `);

      this.db.run('DROP TABLE observations');
      this.db.run('ALTER TABLE observations_new RENAME TO observations');

      // Recreate indexes
      this.db.run(`
        CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX idx_observations_project ON observations(project);
        CREATE INDEX idx_observations_type ON observations(type);
        CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      `);

      // Recreate FTS triggers only if observations_fts exists
      // (SessionSearch.ensureFTSTables creates it on first use with IF NOT EXISTS)
      const hasFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all() as { name: string }[]).length > 0;
      if (hasFTS) {
        this.db.run(`
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
        `);
      }

      // ==========================================
      // 2. Recreate session_summaries table
      // ==========================================

      // Clean up leftover temp table from a previously-crashed run
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
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);

      this.db.run(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM session_summaries
      `);

      // Drop session_summaries FTS triggers before dropping the table
      this.db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
      this.db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
      this.db.run('DROP TRIGGER IF EXISTS session_summaries_au');

      this.db.run('DROP TABLE session_summaries');
      this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

      // Recreate indexes
      this.db.run(`
        CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `);

      // Recreate session_summaries FTS triggers if FTS table exists
      const hasSummariesFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all() as { name: string }[]).length > 0;
      if (hasSummariesFTS) {
        this.db.run(`
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
        `);
      }

      // Record migration
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString());

      this.db.run('COMMIT');
      this.db.run('PRAGMA foreign_keys = ON');

      logger.debug('DB', 'Successfully added ON UPDATE CASCADE to FK constraints');
    } catch (error) {
      this.db.run('ROLLBACK');
      this.db.run('PRAGMA foreign_keys = ON');
      throw error;
    }
  }

  /**
   * Add content_hash column to observations for deduplication (migration 22)
   */
  private addObservationContentHashColumn(): void {
    // Check actual schema first — cross-machine DB sync can leave schema_versions
    // claiming this migration ran while the column is actually missing.
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

  /**
   * Add custom_title column to sdk_sessions for agent attribution (migration 23)
   */
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

  /**
   * Add platform_source column to sdk_sessions for Claude/Codex isolation (migration 24)
   */
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

  /**
   * Add generated_by_model and relevance_count columns to observations (migration 26)
   *
   * Note: Cannot trust schema_versions alone — the old MigrationRunner may have
   * recorded version 26 without the ALTER TABLE actually succeeding. Always
   * check column existence directly.
   */
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
   * Update the memory session ID for a session
   * Called by SDKAgent when it captures the session ID from the first SDK message
   * Also used to RESET to null on stale resume failures (worker-service.ts)
   */
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

  /**
   * Ensures memory_session_id is registered in sdk_sessions before FK-constrained INSERT.
   * This fixes Issue #846 where observations fail after worker restart because the
   * SDK generates a new memory_session_id but it's not registered in the parent table
   * before child records try to reference it.
   *
   * @param sessionDbId - The database ID of the session
   * @param memorySessionId - The memory session ID to ensure is registered
   */
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

  /**
   * Get recent session summaries for a project
   */
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

    return stmt.all(project, limit);
  }

  /**
   * Get recent summaries with session info for context display
   */
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

    return stmt.all(project, limit);
  }

  /**
   * Get recent observations for a project
   */
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

    return stmt.all(project, limit);
  }

  /**
   * Get recent observations across all projects (for web UI)
   */
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

    return stmt.all(limit);
  }

  /**
   * Get recent summaries across all projects (for web UI)
   */
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

    return stmt.all(limit);
  }

  /**
   * Get recent user prompts across all sessions (for web UI)
   */
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

    return stmt.all(limit);
  }

  /**
   * Get all unique projects from the database (for web UI project filter)
   */
  getAllProjects(platformSource?: string): string[] {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let query = `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
    `;
    const params: unknown[] = [];

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
      GROUP BY COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}'), project
      ORDER BY latest_epoch DESC
    `).all() as Array<{ platform_source: string; project: string; latest_epoch: number }>;

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

  /**
   * Get latest user prompt with session info for a Claude session
   * Used for syncing prompts to Chroma during session initialization
   */
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

    return stmt.all(project, limit);
  }

  /**
   * Get observations for a specific session
   */
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

    return stmt.all(memorySessionId);
  }

  /**
   * Get a single observation by ID
   */
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
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): ObservationRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';

    // Build placeholders for IN clause
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    // Apply project filter
    if (project) {
      additionalConditions.push('project = ?');
      params.push(project);
    }

    // Apply type filter
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

    // Apply concepts filter
    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(() =>
        'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    // Apply files filter
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
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...params) as ObservationRecord[];
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
    `).all(...params, beforeEpoch, limit) as Array<{
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

    return stmt.get(memorySessionId) || null;
  }

  /**
   * Get aggregated files from all observations for a session
   */
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
      // Parse files_read
      parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

      // Parse files_modified
      parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
    }

    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }

  /**
   * Get session by ID
   */
  getSessionById(id: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
  } | null {
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return stmt.get(id) || null;
  }

  /**
   * Get SDK sessions by SDK session IDs
   * Used for exporting session metadata
   */
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






  /**
   * Get current prompt number by counting user_prompts for this session
   * Replaces the prompt_counter column which is no longer maintained
   */
  getPromptNumberFromUserPrompts(contentSessionId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(contentSessionId) as { count: number };
    return result.count;
  }

  /**
   * Create a new SDK session (idempotent - returns existing session ID if already exists)
   *
   * CRITICAL ARCHITECTURE: Session ID Threading
   * ============================================
   * This function is the KEY to how claude-mem stays unified across hooks:
   *
   * - NEW hook calls: createSDKSession(session_id, project, prompt)
   * - SAVE hook calls: createSDKSession(session_id, '', '')
   * - Both use the SAME session_id from Claude Code's hook context
   *
   * IDEMPOTENT BEHAVIOR (INSERT OR IGNORE):
   * - Prompt #1: session_id not in database → INSERT creates new row
   * - Prompt #2+: session_id exists → INSERT ignored, fetch existing ID
   * - Result: Same database ID returned for all prompts in conversation
   *
   * Pure get-or-create: never modifies memory_session_id.
   * Multi-terminal isolation is handled by ON UPDATE CASCADE at the schema level.
   */
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

    // Session reuse: Return existing session ID if already created for this contentSessionId.
    const existing = this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(contentSessionId) as { id: number; platform_source: string | null } | undefined;

    if (existing) {
      // Backfill project if session was created by another hook with empty project
      if (project) {
        this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(project, contentSessionId);
      }
      // Backfill custom_title if provided and not yet set
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

    // New session - insert fresh row
    // NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
    // response and stored via ensureMemorySessionIdRegistered(). CRITICAL: memory_session_id
    // must NEVER equal contentSessionId - that would inject memory messages into the user's transcript!
    this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, now.toISOString(), nowEpoch);

    // Return new ID
    const row = this.db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
      .get(contentSessionId) as { id: number };
    return row.id;
  }




  /**
   * Save a user prompt
   */
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

  /**
   * Get user prompt by session ID and prompt number
   * Returns the prompt text, or null if not found
   */
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

  /**
   * Store an observation (from SDK parsing)
   * Assumes session already exists (created by hook)
   * Performs content-hash deduplication: skips INSERT if an identical observation exists within 30s
   */
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
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string,
    captureSource?: CaptureSnapshotSource
  ): { id: number; createdAtEpoch: number } {
    // Use override timestamp if provided (for processing backlog messages with original timestamps)
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Content-hash deduplication
    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
    const existing = findDuplicateObservation(this.db, contentHash, timestampEpoch);
    if (existing) {
      return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
       generated_by_model, why, alternatives_rejected, related_observation_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
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
      contentHash,
      timestampIso,
      timestampEpoch,
      generatedByModel || null,
      observation.why ?? null,
      observation.alternatives_rejected ?? null,
      observation.related_observation_ids && observation.related_observation_ids.length > 0
        ? JSON.stringify(observation.related_observation_ids)
        : null
    );

    const observationId = Number(result.lastInsertRowid);

    insertCaptureSnapshot(
      this.db,
      observationId,
      captureSource ?? emptyCaptureSnapshotSource(memorySessionId, null, promptNumber ?? null),
      capturedFromObservation(observation),
      timestampEpoch
    );

    return {
      id: observationId,
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * Store a session summary (from SDK parsing)
   * Assumes session already exists - will fail with FK error if not
   */
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
    // Use override timestamp if provided (for processing backlog messages with original timestamps)
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

  /**
   * ATOMIC: Store observations + summary (no message tracking)
   *
   * Simplified version for use with claim-and-delete queue pattern.
   * Messages are deleted from queue immediately on claim, so there's no
   * message completion to track. This just stores observations and summary.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
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
    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Create transaction that wraps all operations
    const storeTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      // 1. Store all observations (with content-hash deduplication)
      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const snapshotSource =
        captureSource ?? emptyCaptureSnapshotSource(memorySessionId, null, promptNumber ?? null);

      for (const observation of observations) {
        // Content-hash deduplication (same logic as storeObservation singular)
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const existing = findDuplicateObservation(this.db, contentHash, timestampEpoch);
        if (existing) {
          observationIds.push(existing.id);
          continue;
        }

        const result = obsStmt.run(
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
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null,
          observation.why ?? null,
          observation.alternatives_rejected ?? null,
          observation.related_observation_ids && observation.related_observation_ids.length > 0
            ? JSON.stringify(observation.related_observation_ids)
            : null
        );
        const observationId = Number(result.lastInsertRowid);
        observationIds.push(observationId);

        // Capture snapshot pairs source inputs with captured outputs so later
        // rubric runs have ground truth. Same transaction, same fate.
        insertCaptureSnapshot(
          this.db,
          observationId,
          snapshotSource,
          capturedFromObservation(observation),
          timestampEpoch
        );
      }

      // 2. Store summary if provided
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

    // Execute the transaction and return results
    return storeTx();
  }

  /**
   * @deprecated Use storeObservations instead. This method is kept for backwards compatibility.
   *
   * ATOMIC: Store observations + summary + mark pending message as processed
   *
   * This method wraps observation storage, summary storage, and message completion
   * in a single database transaction to prevent race conditions. If the worker crashes
   * during processing, either all operations succeed together or all fail together.
   *
   * This fixes the observation duplication bug where observations were stored but
   * the message wasn't marked complete, causing reprocessing on crash recovery.
   *
   * @param memorySessionId - SDK memory session ID
   * @param project - Project name
   * @param observations - Array of observations to store (can be empty)
   * @param summary - Optional summary to store
   * @param messageId - Pending message ID to mark as processed
   * @param pendingStore - PendingMessageStore instance for marking complete
   * @param promptNumber - Optional prompt number
   * @param discoveryTokens - Discovery tokens count
   * @param overrideTimestampEpoch - Optional override timestamp
   * @returns Object with observation IDs, optional summary ID, and timestamp
   */
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
    // Use override timestamp if provided
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    // Create transaction that wraps all operations
    const storeAndMarkTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      // 1. Store all observations (with content-hash deduplication)
      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model, why, alternatives_rejected, related_observation_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const snapshotSource =
        captureSource ?? emptyCaptureSnapshotSource(memorySessionId, null, promptNumber ?? null);

      for (const observation of observations) {
        // Content-hash deduplication (same logic as storeObservation singular)
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const existing = findDuplicateObservation(this.db, contentHash, timestampEpoch);
        if (existing) {
          observationIds.push(existing.id);
          continue;
        }

        const result = obsStmt.run(
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
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null,
          observation.why ?? null,
          observation.alternatives_rejected ?? null,
          observation.related_observation_ids && observation.related_observation_ids.length > 0
            ? JSON.stringify(observation.related_observation_ids)
            : null
        );
        const observationId = Number(result.lastInsertRowid);
        observationIds.push(observationId);

        // Capture snapshot pairs source inputs with captured outputs (same transaction).
        insertCaptureSnapshot(
          this.db,
          observationId,
          snapshotSource,
          capturedFromObservation(observation),
          timestampEpoch
        );
      }

      // 2. Store summary if provided
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

      // 3. Mark pending message as processed
      // This UPDATE is part of the same transaction, so if it fails,
      // observations and summary will be rolled back
      const updateStmt = this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `);
      updateStmt.run(timestampEpoch, messageId);

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    // Execute the transaction and return results
    return storeAndMarkTx();
  }



  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // There's no such thing as an "orphaned" session. Sessions are created by hooks
  // and managed by Claude Code's lifecycle. Worker restarts don't invalidate them.
  // Marking all active sessions as 'failed' on startup destroys the user's current work.

  /**
   * Get session summaries by IDs (for hybrid Chroma search)
   * Returns summaries in specified temporal order
   */
  getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): SessionSummaryRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
    const whereClause = project
      ? `WHERE id IN (${placeholders}) AND project = ?`
      : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT * FROM session_summaries
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...params) as SessionSummaryRecord[];
  }

  /**
   * Get user prompts by IDs (for hybrid Chroma search)
   * Returns prompts in specified temporal order
   */
  getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): UserPromptRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Apply project filter
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
      ORDER BY up.created_at_epoch ${orderClause}
      ${limitClause}
    `);

    return stmt.all(...params) as UserPromptRecord[];
  }

  /**
   * Get a unified timeline of all records (observations, sessions, prompts) around an anchor point
   * @param anchorEpoch The anchor timestamp (epoch milliseconds)
   * @param depthBefore Number of records to retrieve before anchor (any type)
   * @param depthAfter Number of records to retrieve after anchor (any type)
   * @param project Optional project filter
   * @returns Object containing observations, sessions, and prompts for the specified window
   */
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

  /**
   * Get timeline around a specific observation ID
   * Uses observation ID offsets to determine time boundaries, then fetches all record types in that window
   */
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
      // Get boundary observations by ID offset
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

        // Get the earliest and latest timestamps from boundary observations
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary observations', undefined, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      // For timestamp-based anchors, use time-based boundaries
      // Get observations to find the time window
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
      } catch (err: any) {
        logger.error('DB', 'Error getting boundary timestamps', undefined, { error: err, project });
        return { observations: [], sessions: [], prompts: [] };
      }
    }

    // Now query ALL record types within the time window
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

  /**
   * Get a single user prompt by ID
   */
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

    return stmt.get(id) || null;
  }

  /**
   * Get multiple user prompts by IDs
   */
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

  /**
   * Get full session summary by ID (includes request_summary and learned_summary)
   */
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

    return stmt.get(id) || null;
  }

  /**
   * Get or create a manual session for storing user-created observations
   * Manual sessions use a predictable ID format: "manual-{project}"
   */
  getOrCreateManualSession(project: string): string {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = this.db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get(memorySessionId) as { memory_session_id: string } | undefined;

    if (existing) {
      return memorySessionId;
    }

    // Create new manual session
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

  // ===========================================
  // Import Methods (for import-memories script)
  // ===========================================

  /**
   * Import SDK session with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
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
    // Check if session already exists
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

  /**
   * Import session summary with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
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
    // Check if summary already exists for this session
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

  /**
   * Import observation with duplicate checking
   * Duplicates are identified by memory_session_id + title + created_at_epoch
   * Returns: { imported: boolean, id: number }
   */
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
  }): { imported: boolean; id: number } {
    // Check if observation already exists
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
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      obs.created_at,
      obs.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  /**
   * Rebuild the FTS5 index for observations.
   * Should be called after bulk imports to ensure imported rows are searchable.
   * No-op if observations_fts table does not exist.
   */
  rebuildObservationsFTSIndex(): void {
    const hasFTS = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all() as { name: string }[]).length > 0;

    if (!hasFTS) {
      return;
    }

    this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  }

  /**
   * Import user prompt with duplicate checking
   * Duplicates are identified by content_session_id + prompt_number
   * Returns: { imported: boolean, id: number }
   */
  importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    // Check if prompt already exists
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
