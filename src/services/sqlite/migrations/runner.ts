import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion
} from '../../../types/database.js';
import { DEFAULT_PLATFORM_SOURCE } from '../../../shared/platform-source.js';

/**
 * MigrationRunner handles all database schema migrations
 * Extracted from SessionStore to separate concerns
 */
export class MigrationRunner {
  constructor(private db: Database) {}

  /**
   * Run all migrations in order
   * This is the only public method - all migrations are internal
   */
  runAllMigrations(): void {
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
    this.createObservationFeedbackTable();
    this.addSessionPlatformSourceColumn();
    this.createObservationsFTSIndex();
    this.migrateToV29();
    this.migrateToV30();
    this.migrateToV31();
    this.migrateToV32();
    this.migrateToV33();
    this.migrateToV34();
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
   * - claude_session_id -> content_session_id (user's observed session)
   * - sdk_session_id -> memory_session_id (memory agent's session for resume)
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
      // ===================================
      // 1. Recreate observations table
      // ===================================
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

      // ===================================
      // 2. Recreate session_summaries table
      // ===================================
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
   * Prevents duplicate observations from being stored when the same content is processed multiple times.
   * Backfills existing rows with unique random hashes so they don't block new inserts.
   */
  private addObservationContentHashColumn(): void {
    // Check actual schema first — cross-machine DB sync can leave schema_versions
    // claiming this migration ran while the column is actually missing (e.g. migration 21
    // recreated the table without content_hash on the synced machine).
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'content_hash');

    if (hasColumn) {
      // Column exists — just ensure version record is present
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
      return;
    }

    this.db.run('ALTER TABLE observations ADD COLUMN content_hash TEXT');
    // Backfill existing rows with unique random hashes
    this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL");
    // Index for fast dedup lookups
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)');
    logger.debug('DB', 'Added content_hash column to observations table with backfill and index');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
  }

  /**
   * Add custom_title column to sdk_sessions for agent attribution (migration 23)
   * Allows callers (e.g. Maestro agents) to label sessions with a human-readable name.
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
   * Create observation_feedback table for tracking observation usage signals.
   * Foundation for tier routing optimization and future Thompson Sampling.
   * Schema version 24.
   */
  private createObservationFeedbackTable(): void {
    const applied = this.db.query('SELECT 1 FROM schema_versions WHERE version = 24').get();
    if (applied) return;

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

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
    logger.debug('DB', 'Created observation_feedback table for usage tracking');
  }

  /**
   * Add platform_source column to sdk_sessions for Claude/Codex isolation (migration 25)
   */
  private addSessionPlatformSourceColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'platform_source');
    const indexInfo = this.db.query('PRAGMA index_list(sdk_sessions)').all() as IndexInfo[];
    const hasIndex = indexInfo.some(index => index.name === 'idx_sdk_sessions_platform_source');
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(25) as SchemaVersion | undefined;

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

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(25, new Date().toISOString());
  }

  /**
   * Create FTS5 virtual table over observations for BM25 keyword search (migration 28)
   *
   * Uses external-content FTS5 so no data is duplicated — the virtual table holds only
   * the token index. Three DML triggers keep the index in sync with `observations`.
   * An idempotent backfill runs every startup and inserts any rows not yet indexed.
   *
   * Column set matches the trigger definitions in migration 21 exactly:
   *   title, subtitle, narrative, text, facts, concepts
   *
   * Graceful: if FTS5 is somehow unavailable (very rare in bun), logs a warning and
   * continues without blocking worker startup.
   */
  private createObservationsFTSIndex(): void {
    // Check actual table state — skip the whole method if already set up
    const hasFTSTable = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all() as { name: string }[]).length > 0;

    try {
      if (!hasFTSTable) {
        // Create the FTS5 external-content virtual table
        this.db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
            title, subtitle, narrative, text, facts, concepts,
            content='observations', content_rowid='id',
            tokenize='porter unicode61'
          )
        `);

        // INSERT trigger
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `);

        // DELETE trigger
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          END
        `);

        // UPDATE trigger
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END
        `);

        // Backfill existing rows using 'rebuild' — required for external-content FTS5 to
        // tokenize source-table content correctly. Direct INSERT only registers rowid mappings
        // but does not build token index; 'rebuild' reads from content='observations' and
        // tokenizes every row. Safe to call once on table creation; triggers handle future syncs.
        this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");

        logger.debug('DB', 'Created observations_fts virtual table, sync triggers, and backfilled existing rows');
      }

    } catch (ftsError) {
      logger.warn('DB', 'FTS5 not available, observations_fts index skipped', {}, ftsError as Error);
    }

    // Record migration regardless of FTS availability
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
    logger.debug('DB', 'Observations FTS5 index ensured');
  }

  /**
   * Add why, alternatives_rejected, related_observation_ids columns to observations (migration 29)
   *
   * WHY: A rubric-based audit (N=30) found 53% of observations carried no rationale,
   * alternatives, or cross-references — because the capture prompt never asked for them.
   * These three columns store "decision DNA" so future sessions can see not just WHAT
   * changed but WHY and what was rejected.
   *
   * FTS5: why + alternatives_rejected are added to observations_fts so they are
   * searchable. related_observation_ids is numeric and excluded from FTS.
   *
   * Cross-machine safety: checks actual column presence before ALTER TABLE, so a DB
   * that was synced after the columns were already added won't fail.
   */
  private migrateToV29(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(29) as SchemaVersion | undefined;
    if (applied) return;

    // Wrap the full migration (schema ALTERs + FTS recreate + schema_versions insert)
    // in one transaction. Without this, a mid-way FTS failure leaves observations
    // altered + schema_versions marked V29-applied, which makes the missing FTS
    // triggers permanent: next boot's idempotency check at 1023 skips the block.
    const runMigration = this.db.transaction(() => {
      // Check schema first in case cross-machine DB sync already added the columns
      const cols = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
      const names = new Set(cols.map(c => c.name));
      const needWhy = !names.has('why');
      const needAlt = !names.has('alternatives_rejected');
      const needRel = !names.has('related_observation_ids');

      if (needWhy) this.db.run('ALTER TABLE observations ADD COLUMN why TEXT');
      if (needAlt) this.db.run('ALTER TABLE observations ADD COLUMN alternatives_rejected TEXT');
      if (needRel) this.db.run('ALTER TABLE observations ADD COLUMN related_observation_ids TEXT');

      // Extend FTS5 virtual table to include why and alternatives_rejected.
      // External-content FTS5 does not support ALTER TABLE, so we must DROP and recreate.
      // Any failure here aborts the transaction (no try/catch by design): we would
      // rather retry on next boot than mark V29 applied with missing FTS triggers.
      const hasFTSTable = (this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
      ).all() as { name: string }[]).length > 0;

      if (hasFTSTable) {
        // Check if why column already exists in FTS (idempotency for re-runs)
        const ftsCols = this.db.prepare('PRAGMA table_info(observations_fts)').all() as Array<{ name: string }>;
        const ftsHasWhy = ftsCols.some(c => c.name === 'why');

        if (!ftsHasWhy) {
          // Drop old triggers first — they reference the old FTS column set
          this.db.run('DROP TRIGGER IF EXISTS observations_ai');
          this.db.run('DROP TRIGGER IF EXISTS observations_ad');
          this.db.run('DROP TRIGGER IF EXISTS observations_au');

          // Drop and recreate the FTS virtual table with new columns
          this.db.run('DROP TABLE IF EXISTS observations_fts');

          this.db.run(`
            CREATE VIRTUAL TABLE observations_fts USING fts5(
              title, subtitle, narrative, text, facts, concepts, why, alternatives_rejected,
              content='observations', content_rowid='id',
              tokenize='porter unicode61'
            )
          `);

          // Recreate triggers with the extended column set
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

          // Backfill: rebuild index from source table content
          this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");

          logger.debug('DB', 'Rebuilt observations_fts with why + alternatives_rejected columns');
        }
      }

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
    });
    runMigration();
    logger.debug('DB', 'Migration V29 complete: why/alternatives_rejected/related_observation_ids added to observations');
  }

  /**
   * Add observation_capture_snapshots + observation_rubric_scores tables (migration 30)
   *
   * WHY: We cannot measure observation capture quality empirically because we
   * never preserved the raw source (tool_input, tool_output, user_prompt,
   * prior_assistant_message) alongside the captured fields (narrative, facts,
   * why, etc.). Without that pairing there is no ground truth for "did the
   * LLM hallucinate?" or "did the rubric score go up after X intent change?".
   *
   * `observation_capture_snapshots`: paired to each observation at write time
   *   — stores raw inputs + captured outputs so later rubric runs can score
   *   fidelity, intent_fit, concept_accuracy, type_correctness.
   *
   * `observation_rubric_scores`: stores judge output (per snapshot) so we can
   *   track capture quality over time without re-calling the LLM.
   *
   * Idempotent — uses CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
   */
  private migrateToV30(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(30) as SchemaVersion | undefined;
    if (applied) return;

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

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(30, new Date().toISOString());
    logger.debug('DB', 'Migration V30 complete: observation_capture_snapshots + observation_rubric_scores');
  }

  /**
   * Add context-origin tracking to observation_tool_origins (migration 31)
   *
   * WHY: Observations generated outside the tool-call path (init prompt,
   * continuation prompt, summary prompt, user-prompt-only turns) had no row
   * in observation_tool_origins because the existing insert path keyed off
   * pending_message_id, which is only set on tool_use messages. Those
   * observations rendered in the trace modal as permanent orphans ("No origin
   * link found"). Example: obs #11779 "Plano formal solicitado para 1,2,3".
   *
   * Fix: add two nullable columns to the existing table so context-based
   * origins can coexist with tool-based origins:
   *   - context_type TEXT      — 'user_prompt' | 'init_prompt' |
   *                              'continuation_prompt' | 'summary_prompt' |
   *                              NULL (tool-based)
   *   - context_ref_json TEXT  — JSON payload referencing the source
   *                              (e.g. {"user_prompt_id":123} or
   *                              {"session_db_id":45,"prompt_number":3})
   *
   * The old unique index idx_observation_tool_origins_observation_pending
   * used COALESCE(pending_message_id, -1), which would collide all
   * context-based origins for the same observation on the sentinel -1. Drop
   * it and recreate a composite index that keys on
   * (observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, ''))
   * so tool-based and context-based origins can coexist per observation.
   *
   * Idempotent: checks existing columns via PRAGMA before ALTER.
   */
  private migrateToV31(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(31) as SchemaVersion | undefined;

    const cols = this.db.prepare('PRAGMA table_info(observation_tool_origins)').all() as TableColumnInfo[];
    // Fresh DB: table doesn't exist yet. It'll be created later by ensureOriginsTables
    // with the new schema already including context_type + context_ref_json. Mark
    // V31 as applied so we don't try to ALTER a non-existent table.
    if (cols.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
      return;
    }
    const names = new Set(cols.map(c => c.name));
    const needContextType = !names.has('context_type');
    const needContextRef = !names.has('context_ref_json');

    if (applied && !needContextType && !needContextRef) return;

    if (needContextType) {
      this.db.run('ALTER TABLE observation_tool_origins ADD COLUMN context_type TEXT');
    }
    if (needContextRef) {
      this.db.run('ALTER TABLE observation_tool_origins ADD COLUMN context_ref_json TEXT');
    }

    // Relax the unique index so multiple context origins can coexist with a
    // tool-based origin on the same observation. The old index collapsed all
    // NULL pending_message_id rows to sentinel -1 and would prevent the
    // insertion of >1 context origin per observation.
    this.db.run('DROP INDEX IF EXISTS idx_observation_tool_origins_observation_pending');
    this.db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_tool_origins_observation_pending_context ' +
      'ON observation_tool_origins(observation_id, COALESCE(pending_message_id, -1), COALESCE(context_type, \'\'))'
    );
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observation_tool_origins_context_type ON observation_tool_origins(context_type)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
    logger.debug('DB', 'Migration V31 complete: context_type + context_ref_json on observation_tool_origins');
  }

  /**
   * Create mcp_invocations table for MCP tool call logging (migration 32)
   *
   * Logs every MCP tool invocation (name, args summary, result status, duration)
   * for aggregation in the Memory Assist viewer.
   *
   * Idempotent: uses CREATE TABLE IF NOT EXISTS and checks table existence
   * before recording the version row.
   */
  private migrateToV32(): void {
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
    logger.debug('DB', 'Migration V32 complete: mcp_invocations table');
  }

  /**
   * Create memory_implicit_signals table for implicit use tracking (migration 33)
   *
   * Stores file_reuse and content_cited signals computed after injection events,
   * enabling direct evidence of whether injected memory was actually used.
   *
   * Idempotent: checks table existence before DDL.
   */
  private migrateToV33(): void {
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
    logger.debug('DB', 'Migration V33 complete: memory_implicit_signals table');
  }

  private migrateToV34(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(34) as SchemaVersion | undefined;
    if (applied) return;

    // Guard against cross-machine DB sync that already added the column.
    const cols = this.db.prepare('PRAGMA table_info(observation_capture_snapshots)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'llm_raw_type')) {
      this.db.run(`ALTER TABLE observation_capture_snapshots ADD COLUMN llm_raw_type TEXT`);
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(34, new Date().toISOString());
    logger.debug('DB', 'Migration V34 complete: llm_raw_type column on observation_capture_snapshots');
  }
}
