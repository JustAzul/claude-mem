/**
 * Dual-path canary tests for migration V32.
 *
 * V32 introduces the mcp_invocations table for MCP tool call logging.
 *
 * Both paths apply the schema:
 *   1. MigrationRunner.runAllMigrations() — the canonical path
 *   2. new SessionStore(':memory:') — inline mirror that bootstraps from zero
 *
 * These tests run on real SQLite (:memory:) — no mocks. They catch the
 * "dual-path drift" trap: forgetting to mirror a schema change in one of
 * the two migration sites.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

interface TableExistsRow {
  name: string;
}

interface IndexRow {
  name: string;
}

interface ColumnInfo {
  name: string;
  type: string;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as TableExistsRow | undefined;
  return !!row;
}

function indexExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as IndexRow | undefined;
  return !!row;
}

function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return rows.map(r => r.name);
}

const EXPECTED_COLUMNS = [
  'id',
  'tool_name',
  'args_summary',
  'result_status',
  'error_message',
  'duration_ms',
  'invoked_at_epoch',
];

describe('migration V32 — mcp_invocations', () => {
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

    it('creates mcp_invocations table with all expected columns', () => {
      new MigrationRunner(db).runAllMigrations();

      expect(tableExists(db, 'mcp_invocations')).toBe(true);
      const cols = columnNames(db, 'mcp_invocations');
      for (const expected of EXPECTED_COLUMNS) {
        expect(cols).toContain(expected);
      }
    });

    it('creates both indexes on mcp_invocations', () => {
      new MigrationRunner(db).runAllMigrations();

      expect(indexExists(db, 'idx_mcp_invocations_tool_time')).toBe(true);
      expect(indexExists(db, 'idx_mcp_invocations_time')).toBe(true);
    });

    it('records schema version 32 in schema_versions', () => {
      new MigrationRunner(db).runAllMigrations();

      const row = db
        .prepare('SELECT version FROM schema_versions WHERE version = 32')
        .get() as { version: number } | undefined;
      expect(row?.version).toBe(32);
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

    it('creates mcp_invocations with correct columns', () => {
      const db = store.db;

      expect(tableExists(db, 'mcp_invocations')).toBe(true);
      const cols = columnNames(db, 'mcp_invocations');
      for (const expected of EXPECTED_COLUMNS) {
        expect(cols).toContain(expected);
      }
    });

    it('creates both indexes', () => {
      const db = store.db;

      expect(indexExists(db, 'idx_mcp_invocations_tool_time')).toBe(true);
      expect(indexExists(db, 'idx_mcp_invocations_time')).toBe(true);
    });

    it('inserts and selects a row with correct shape', () => {
      const db = store.db;
      const now = Date.now();

      db.prepare(`
        INSERT INTO mcp_invocations (tool_name, args_summary, result_status, error_message, duration_ms, invoked_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('search', JSON.stringify({ query_length: 5 }), 'ok', null, 42, now);

      const row = db
        .prepare('SELECT * FROM mcp_invocations WHERE tool_name = ?')
        .get('search') as {
          id: number;
          tool_name: string;
          args_summary: string;
          result_status: string;
          error_message: string | null;
          duration_ms: number;
          invoked_at_epoch: number;
        } | undefined;

      expect(row).toBeDefined();
      expect(row!.id).toBeGreaterThan(0);
      expect(row!.tool_name).toBe('search');
      expect(JSON.parse(row!.args_summary)).toEqual({ query_length: 5 });
      expect(row!.result_status).toBe('ok');
      expect(row!.error_message).toBeNull();
      expect(row!.duration_ms).toBe(42);
      expect(row!.invoked_at_epoch).toBe(now);
    });
  });
});
