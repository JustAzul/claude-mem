/**
 * Dual-path canary tests for migration V30.
 *
 * V30 introduces two tables used by the capture-quality probe:
 *   - observation_capture_snapshots (raw source + captured fields paired to each obs)
 *   - observation_rubric_scores      (per-snapshot judge output)
 *
 * Both paths apply the schema:
 *   1. MigrationRunner.runAllMigrations() — the canonical path
 *   2. new SessionStore(':memory:') — inline mirror that bootstraps from zero
 *
 * These tests run on real SQLite (:memory:) — no mocks. They catch the
 * "dual-path drift" trap that burned V28/V29/P1: forgetting to mirror a
 * schema change in one of the two migration sites.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import {
  insertCaptureSnapshot,
  emptyCaptureSnapshotSource,
  capturedFromObservation,
} from '../../../src/services/sqlite/observations/capture-snapshot.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

interface TableExistsRow {
  name: string;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as TableExistsRow | undefined;
  return !!row;
}

function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.map(r => r.name);
}

function foreignKeys(db: Database, table: string): ForeignKeyInfo[] {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyInfo[];
}

function sessionIdForContent(db: Database, contentSessionId: string): number {
  const row = db
    .prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
    .get(contentSessionId) as { id: number };
  return row.id;
}

const EXPECTED_SNAPSHOT_COLUMNS = [
  'id',
  'observation_id',
  'memory_session_id',
  'content_session_id',
  'prompt_number',
  'user_prompt',
  'prior_assistant_message',
  'tool_name',
  'tool_input',
  'tool_output',
  'cwd',
  'captured_type',
  'captured_title',
  'captured_subtitle',
  'captured_narrative',
  'captured_facts',
  'captured_concepts',
  'captured_why',
  'captured_alternatives_rejected',
  'captured_related_observation_ids',
  'created_at_epoch',
];

const EXPECTED_RUBRIC_COLUMNS = [
  'id',
  'observation_id',
  'snapshot_id',
  'judge_model',
  'fidelity',
  'intent_fit',
  'concept_accuracy',
  'type_correctness',
  'ceiling_flagged',
  'judge_notes',
  'scored_at_epoch',
];

describe('migration V30 — capture snapshots + rubric scores', () => {
  describe('MigrationRunner path', () => {
    let db: Database;

    beforeEach(() => {
      db = new Database(':memory:');
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA foreign_keys = ON');
    });

    afterEach(() => {
      db.close();
    });

    it('creates observation_capture_snapshots with every expected column', () => {
      new MigrationRunner(db).runAllMigrations();

      expect(tableExists(db, 'observation_capture_snapshots')).toBe(true);
      const cols = columnNames(db, 'observation_capture_snapshots');
      for (const expected of EXPECTED_SNAPSHOT_COLUMNS) {
        expect(cols).toContain(expected);
      }
    });

    it('creates observation_rubric_scores with every expected column', () => {
      new MigrationRunner(db).runAllMigrations();

      expect(tableExists(db, 'observation_rubric_scores')).toBe(true);
      const cols = columnNames(db, 'observation_rubric_scores');
      for (const expected of EXPECTED_RUBRIC_COLUMNS) {
        expect(cols).toContain(expected);
      }
    });

    it('records schema version 30 in schema_versions', () => {
      new MigrationRunner(db).runAllMigrations();

      const row = db
        .prepare('SELECT version FROM schema_versions WHERE version = 30')
        .get() as { version: number } | undefined;
      expect(row?.version).toBe(30);
    });
  });

  describe('SessionStore inline path', () => {
    let store: SessionStore;

    beforeEach(() => {
      store = new SessionStore(':memory:');
    });

    afterEach(() => {
      store.close();
    });

    it('creates both V30 tables with identical column shape to the runner path', () => {
      const db = store.db;

      expect(tableExists(db, 'observation_capture_snapshots')).toBe(true);
      expect(tableExists(db, 'observation_rubric_scores')).toBe(true);

      const snapshotCols = columnNames(db, 'observation_capture_snapshots');
      const rubricCols = columnNames(db, 'observation_rubric_scores');

      for (const expected of EXPECTED_SNAPSHOT_COLUMNS) {
        expect(snapshotCols).toContain(expected);
      }
      for (const expected of EXPECTED_RUBRIC_COLUMNS) {
        expect(rubricCols).toContain(expected);
      }
    });

    it('points observation_capture_snapshots FK at observations.id with ON DELETE CASCADE', () => {
      const db = store.db;
      const fks = foreignKeys(db, 'observation_capture_snapshots');
      const obsFk = fks.find(fk => fk.table === 'observations' && fk.from === 'observation_id');

      expect(obsFk).toBeDefined();
      expect(obsFk?.to).toBe('id');
      expect(obsFk?.on_delete).toBe('CASCADE');
    });
  });

  describe('insertCaptureSnapshot end-to-end', () => {
    let store: SessionStore;
    let db: Database;

    beforeEach(() => {
      store = new SessionStore(':memory:');
      db = store.db;
    });

    afterEach(() => {
      store.close();
    });

    it('persists a fully-populated snapshot paired to an observation and cascades on delete', () => {
      const memorySessionId = 'mem-session-v30-test';
      const contentSessionId = 'content-session-v30-test';
      const project = 'test-project';

      store.createSDKSession(contentSessionId, project, 'please refactor the parser');
      const sessionDbId = sessionIdForContent(db, contentSessionId);
      store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);

      const captureSource = {
        memorySessionId,
        contentSessionId,
        promptNumber: 7,
        userPrompt: 'please refactor the parser',
        priorAssistantMessage: 'I will extract the tokenizer',
        toolName: 'Edit',
        toolInput: JSON.stringify({ file_path: '/tmp/parser.ts', old_string: 'a', new_string: 'b' }),
        toolOutput: JSON.stringify({ ok: true }),
        cwd: '/tmp/proj',
      };

      const obs = {
        type: 'refactor',
        title: 'Extracted tokenizer',
        subtitle: 'parser cleanup',
        facts: ['split tokenizer into module'],
        narrative: 'Moved tokenizer out of parser for SRP.',
        concepts: ['tokenizer', 'parser'],
        files_read: [],
        files_modified: ['/tmp/parser.ts'],
        why: 'SRP violation was blocking test isolation',
        alternatives_rejected: null,
        related_observation_ids: [],
      };

      const { id: observationId } = store.storeObservation(
        memorySessionId,
        project,
        obs,
        7,
        0,
        undefined,
        'test-model',
        captureSource
      );

      const snapshotRow = db
        .prepare(
          `SELECT observation_id, tool_name, tool_input, captured_type, captured_narrative, captured_why
           FROM observation_capture_snapshots WHERE observation_id = ?`
        )
        .get(observationId) as
        | {
            observation_id: number;
            tool_name: string;
            tool_input: string;
            captured_type: string;
            captured_narrative: string;
            captured_why: string;
          }
        | undefined;

      expect(snapshotRow).toBeDefined();
      expect(snapshotRow!.observation_id).toBe(observationId);
      expect(snapshotRow!.tool_name).toBe('Edit');
      expect(snapshotRow!.tool_input).toContain('/tmp/parser.ts');
      expect(snapshotRow!.captured_type).toBe('refactor');
      expect(snapshotRow!.captured_narrative).toBe('Moved tokenizer out of parser for SRP.');
      expect(snapshotRow!.captured_why).toBe('SRP violation was blocking test isolation');

      // Verify FK CASCADE: delete the observation and the snapshot goes with it.
      db.prepare('DELETE FROM observations WHERE id = ?').run(observationId);
      const afterDelete = db
        .prepare('SELECT COUNT(*) as c FROM observation_capture_snapshots WHERE observation_id = ?')
        .get(observationId) as { c: number };
      expect(afterDelete.c).toBe(0);
    });

    it('gracefully falls back to emptyCaptureSnapshotSource when callers provide no source', () => {
      const memorySessionId = 'mem-session-v30-empty';
      const contentSessionId = 'content-session-v30-empty';
      const project = 'test-project';

      store.createSDKSession(contentSessionId, project, 'x');
      const sessionDbId = sessionIdForContent(db, contentSessionId);
      store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);

      const obs = {
        type: 'discovery',
        title: 'Read a file',
        subtitle: null,
        facts: [],
        narrative: 'Saw the file',
        concepts: [],
        files_read: ['/tmp/x.ts'],
        files_modified: [],
      };

      const { id: observationId } = store.storeObservation(memorySessionId, project, obs);

      const row = db
        .prepare(
          `SELECT tool_input, tool_output, user_prompt, captured_type
           FROM observation_capture_snapshots WHERE observation_id = ?`
        )
        .get(observationId) as
        | {
            tool_input: string | null;
            tool_output: string | null;
            user_prompt: string | null;
            captured_type: string;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row!.tool_input).toBeNull();
      expect(row!.tool_output).toBeNull();
      expect(row!.user_prompt).toBeNull();
      expect(row!.captured_type).toBe('discovery');
    });

    it('insertCaptureSnapshot direct-call appends a manually-built snapshot row', () => {
      const memorySessionId = 'mem-direct';
      const contentSessionId = 'content-direct';
      const project = 'test-project';

      store.createSDKSession(contentSessionId, project, 'x');
      const sessionDbId = sessionIdForContent(db, contentSessionId);
      store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);

      const obs = {
        type: 'discovery',
        title: 'direct',
        subtitle: null,
        facts: [],
        narrative: 'direct narrative',
        concepts: [],
        files_read: [],
        files_modified: [],
      };

      const { id: observationId } = store.storeObservation(memorySessionId, project, obs);

      insertCaptureSnapshot(
        db,
        observationId,
        {
          ...emptyCaptureSnapshotSource(memorySessionId, contentSessionId, 99),
          toolName: 'Read',
          toolInput: JSON.stringify({ file_path: '/etc/hosts' }),
        },
        capturedFromObservation(obs),
        Date.now()
      );

      // storeObservation auto-inserts one snapshot; the direct call adds a second.
      const count = db
        .prepare('SELECT COUNT(*) as c FROM observation_capture_snapshots WHERE observation_id = ?')
        .get(observationId) as { c: number };
      expect(count.c).toBe(2);
    });
  });
});
