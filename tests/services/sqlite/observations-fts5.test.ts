/**
 * Tests for observations FTS5 virtual table — migration 28
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' — tests actual FTS5 SQL
 * - Validates triggers, backfill, BM25 ranking, and idempotency
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';

interface TableNameRow {
  name: string;
}

interface SchemaVersion {
  version: number;
}

interface FTSRow {
  rowid: number;
}

interface CountRow {
  count: number;
}

// Insert a session row (required FK for observations)
function insertSession(db: Database, memorySessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(memorySessionId, memorySessionId, 'test-project', now, Date.now(), 'active');
}

// Insert an observation and return its rowid
function insertObservation(db: Database, opts: {
  memorySessionId: string;
  title: string;
  subtitle?: string;
  narrative?: string;
  text?: string;
  facts?: string;
  concepts?: string;
}): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, narrative, text, facts, concepts,
       created_at, created_at_epoch)
    VALUES (?, 'test-project', 'discovery', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.memorySessionId,
    opts.title,
    opts.subtitle ?? null,
    opts.narrative ?? null,
    opts.text ?? null,
    opts.facts ?? null,
    opts.concepts ?? null,
    now,
    Date.now()
  );
  return result.lastInsertRowid as number;
}

describe('observations FTS5 index (migration 28)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    // Insert a shared session for FK satisfaction
    insertSession(db, 'sess-fts-1');
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: FTS virtual table exists after migrations
  it('should create the observations_fts virtual table', () => {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all() as TableNameRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('observations_fts');
  });

  // Test 2: INSERT trigger fires and FTS indexes the new row
  it('should index a row in observations_fts when an observation is inserted', () => {
    const id = insertObservation(db, {
      memorySessionId: 'sess-fts-1',
      title: 'CustomOpenAI provider integration',
      narrative: 'Implemented the CustomOpenAI backend connector',
    });

    const rows = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'CustomOpenAI'"
    ).all() as FTSRow[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.rowid === id)).toBe(true);
  });

  // Test 3: UPDATE trigger fires and FTS reflects the updated content
  it('should reflect updated content in observations_fts after an update', () => {
    const id = insertObservation(db, {
      memorySessionId: 'sess-fts-1',
      title: 'Old title about widgets',
      narrative: 'Original narrative text',
    });

    // Confirm old term is indexed
    const before = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'widgets'"
    ).all() as FTSRow[];
    expect(before.some(r => r.rowid === id)).toBe(true);

    // Update the row
    db.prepare(
      "UPDATE observations SET title = 'New title about gadgets', narrative = 'Updated narrative' WHERE id = ?"
    ).run(id);

    // Old term should no longer match
    const afterOld = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'widgets'"
    ).all() as FTSRow[];
    expect(afterOld.some(r => r.rowid === id)).toBe(false);

    // New term should match
    const afterNew = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'gadgets'"
    ).all() as FTSRow[];
    expect(afterNew.some(r => r.rowid === id)).toBe(true);
  });

  // Test 4: DELETE trigger fires and FTS no longer has the row
  it('should remove a row from observations_fts when an observation is deleted', () => {
    const id = insertObservation(db, {
      memorySessionId: 'sess-fts-1',
      title: 'Temporary observation about sockets',
    });

    const before = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'sockets'"
    ).all() as FTSRow[];
    expect(before.some(r => r.rowid === id)).toBe(true);

    db.prepare('DELETE FROM observations WHERE id = ?').run(id);

    const after = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'sockets'"
    ).all() as FTSRow[];
    expect(after.some(r => r.rowid === id)).toBe(false);
  });

  // Test 5: Schema version 28 is recorded
  it('should record schema version 28', () => {
    const row = db.prepare(
      'SELECT version FROM schema_versions WHERE version = 28'
    ).get() as SchemaVersion | undefined;
    expect(row).toBeDefined();
    expect(row!.version).toBe(28);
  });

  // Test 6: Idempotency — running migrations twice produces no errors, no duplicate FTS rows
  it('should be idempotent when migrations are run twice', () => {
    // Insert one observation before second run
    insertObservation(db, {
      memorySessionId: 'sess-fts-1',
      title: 'Idempotency check observation',
    });

    const runner = new MigrationRunner(db);
    expect(() => runner.runAllMigrations()).not.toThrow();

    // Should still be exactly one matching FTS row
    const rows = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'idempotency'"
    ).all() as FTSRow[];
    expect(rows.length).toBe(1);

    // Version 28 should appear exactly once
    const versionRows = db.prepare(
      'SELECT COUNT(*) as count FROM schema_versions WHERE version = 28'
    ).get() as CountRow;
    expect(versionRows.count).toBe(1);
  });

  // Test 7: BM25 ranking — most relevant row comes first
  it('should rank more relevant observations higher via BM25', () => {
    insertSession(db, 'sess-fts-2');

    // Row A: mentions 'authentication' many times — highest relevance
    const idA = insertObservation(db, {
      memorySessionId: 'sess-fts-1',
      title: 'Authentication overview',
      subtitle: 'Auth system',
      narrative: 'authentication authentication authentication token validation',
      facts: 'authentication is central',
      concepts: 'authentication oauth',
    });

    // Row B: mentions 'authentication' once
    const idB = insertObservation(db, {
      memorySessionId: 'sess-fts-1',
      title: 'Logging setup',
      narrative: 'Set up logging, briefly touches authentication',
    });

    // Row C: doesn't mention authentication at all
    insertObservation(db, {
      memorySessionId: 'sess-fts-2',
      title: 'Database migration guide',
      narrative: 'Migration runner and schema versioning',
    });

    // FTS5 rank is negative — lower (more negative) = more relevant
    // ORDER BY rank ASC puts the most relevant first
    const results = db.prepare(`
      SELECT rowid FROM observations_fts
      WHERE observations_fts MATCH 'authentication'
      ORDER BY rank
    `).all() as FTSRow[];

    expect(results.length).toBe(2);
    // Row A (dense mentions) should rank above Row B (single mention)
    expect(results[0].rowid).toBe(idA);
    expect(results[1].rowid).toBe(idB);
  });

  // Test 8: Backfill — rows inserted before FTS was created are indexed
  it('should backfill pre-existing observations on migration run', () => {
    // Simulate pre-existing data by bypassing triggers:
    // drop FTS + triggers, insert a raw row, then re-run migrations to trigger backfill
    db.run('DROP TRIGGER IF EXISTS observations_ai');
    db.run('DROP TRIGGER IF EXISTS observations_ad');
    db.run('DROP TRIGGER IF EXISTS observations_au');
    db.run('DROP TABLE IF EXISTS observations_fts');
    db.run('DELETE FROM schema_versions WHERE version = 28');

    // Insert without FTS in place — this row won't be in the index yet
    const id = insertObservation(db, {
      memorySessionId: 'sess-fts-1',
      title: 'Pre-existing backfill observation about tokenizer',
    });

    // Re-run migration 28 via a fresh MigrationRunner
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    // Backfill should have caught this row
    const rows = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'tokenizer'"
    ).all() as FTSRow[];
    expect(rows.some(r => r.rowid === id)).toBe(true);
  });
});
