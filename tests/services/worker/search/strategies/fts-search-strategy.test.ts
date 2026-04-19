/**
 * Tests for FTSSearchStrategy — BM25 keyword search via observations_fts (migration 28)
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' — tests actual FTS5 SQL and BM25 ranking
 * - MigrationRunner runs all migrations including migration 28 (FTS5 table creation)
 * - FTSSearchStrategy instantiated against the real in-memory database
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../../../src/services/sqlite/SessionSearch.js';
import {
  FTSSearchStrategy,
  sanitizeFTSQuery
} from '../../../../../src/services/worker/search/strategies/FTSSearchStrategy.js';

// ---------------------------------------------------------------------------
// Minimal SessionStore/SessionSearch shims backed by an in-memory Database
// ---------------------------------------------------------------------------

/**
 * Build a SessionStore whose internal `db` field is replaced by the in-memory
 * DB that already has migrations applied.
 *
 * SessionStore constructor opens its own DB file; to avoid touching disk we
 * construct it normally (pointing at ':memory:') and swap `db` afterwards.
 *
 * Important: we must pass ':memory:' so the constructor uses the Bun in-memory
 * driver (which does NOT persist to disk and will not collide between tests).
 */
function buildStore(db: Database): SessionStore {
  // SessionStore opens its own connection; we override `db` after construction.
  // ':memory:' is passed to avoid file I/O, but we immediately replace with the
  // already-migrated in-memory database shared with the test.
  const store = new SessionStore(':memory:');
  // The `db` field is declared `public` in SessionStore — safe to override.
  (store as unknown as { db: Database }).db = db;
  return store;
}

function buildSearch(db: Database): SessionSearch {
  const search = new SessionSearch(':memory:');
  (search as unknown as { db: Database }).db = db;
  return search;
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function insertSession(db: Database, memorySessionId: string, project = 'test-project'): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(memorySessionId, memorySessionId, project, now, Date.now(), 'active');
}

function insertObservation(
  db: Database,
  opts: {
    memorySessionId: string;
    project?: string;
    type?: string;
    title?: string;
    subtitle?: string;
    narrative?: string;
    text?: string;
    facts?: string;
    concepts?: string;
    createdAtEpoch?: number;
  }
): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, narrative, text, facts, concepts,
       created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.memorySessionId,
    opts.project ?? 'test-project',
    opts.type ?? 'discovery',
    opts.title ?? null,
    opts.subtitle ?? null,
    opts.narrative ?? null,
    opts.text ?? null,
    opts.facts ?? null,
    opts.concepts ?? null,
    now,
    opts.createdAtEpoch ?? Date.now()
  );
  return result.lastInsertRowid as number;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('FTSSearchStrategy', () => {
  let db: Database;
  let strategy: FTSSearchStrategy;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');

    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const store = buildStore(db);
    const search = buildSearch(db);
    strategy = new FTSSearchStrategy(store, search);

    // Seed a shared session for FK satisfaction
    insertSession(db, 'sess-a', 'test-project');
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // sanitizeFTSQuery unit tests
  // -------------------------------------------------------------------------

  describe('sanitizeFTSQuery', () => {
    it('wraps plain tokens in double-quotes and joins with OR', () => {
      // OR semantics (not FTS5's default AND) — a 178x recall boost was
      // measured in live data; BM25 still ranks multi-term matches higher.
      expect(sanitizeFTSQuery('foo bar')).toBe('"foo" OR "bar"');
    });

    it('strips quotes, parens, and colons', () => {
      const result = sanitizeFTSQuery('foo():bar');
      expect(result).not.toMatch(/[():]/);
      expect(result.length).toBeGreaterThan(0);
    });

    it('strips hyphens and asterisks', () => {
      const result = sanitizeFTSQuery('foo-bar *baz*');
      expect(result).not.toMatch(/[-*]/);
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns empty string for all-special input', () => {
      expect(sanitizeFTSQuery('():*-^"')).toBe('');
    });

    it('handles multi-word query correctly', () => {
      const result = sanitizeFTSQuery('typescript bun sqlite');
      expect(result).toBe('"typescript" OR "bun" OR "sqlite"');
    });
  });

  // -------------------------------------------------------------------------
  // canHandle
  // -------------------------------------------------------------------------

  describe('canHandle', () => {
    it('returns true when query is long enough and FTS table exists', () => {
      expect(strategy.canHandle({ query: 'typescript' })).toBe(true);
    });

    it('returns false when query is absent', () => {
      expect(strategy.canHandle({})).toBe(false);
    });

    it('returns false when query is exactly 1 character', () => {
      expect(strategy.canHandle({ query: 'x' })).toBe(false);
    });

    it('returns false when query is empty string', () => {
      expect(strategy.canHandle({ query: '' })).toBe(false);
    });

    it('returns true when query is exactly 2 characters', () => {
      expect(strategy.canHandle({ query: 'ab' })).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Basic BM25 ranking — exact term match
  // -------------------------------------------------------------------------

  it('finds an observation by exact term match', async () => {
    insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'Turbine calibration',
      narrative: 'Calibrated the turbine pressure sensor',
    });

    const result = await strategy.search({ query: 'turbine', project: 'test-project' });

    expect(result.strategy).toBe('fts');
    expect(result.usedFTS).toBe(true);
    expect(result.usedChroma).toBe(false);
    expect(result.results.observations.length).toBeGreaterThan(0);
    const titles = result.results.observations.map(o => o.title ?? '');
    expect(titles.some(t => t.includes('Turbine'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // BM25 ranking — denser mentions rank first
  // -------------------------------------------------------------------------

  it('ranks more relevant observations first (BM25)', async () => {
    // Row A: dense mentions of 'authentication'
    const idA = insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'Authentication overview',
      subtitle: 'Auth system',
      narrative: 'authentication authentication authentication token validation',
      facts: 'authentication is central',
      concepts: '["authentication", "oauth"]',
    });

    // Row B: single mention
    const idB = insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'Logging setup',
      narrative: 'Set up logging, briefly touches authentication',
    });

    const result = await strategy.search({ query: 'authentication', project: 'test-project' });

    expect(result.results.observations.length).toBe(2);
    // Row A (dense) should come before Row B (sparse) — BM25 rank ORDER BY ASC
    expect(result.results.observations[0].id).toBe(idA);
    expect(result.results.observations[1].id).toBe(idB);
  });

  // -------------------------------------------------------------------------
  // Project filter — only returns rows matching the project
  // -------------------------------------------------------------------------

  it('respects project filter', async () => {
    insertSession(db, 'sess-b', 'other-project');

    insertObservation(db, {
      memorySessionId: 'sess-a',
      project: 'test-project',
      title: 'Widget factory test-project',
    });

    insertObservation(db, {
      memorySessionId: 'sess-b',
      project: 'other-project',
      title: 'Widget factory other-project',
    });

    const result = await strategy.search({ query: 'Widget', project: 'test-project' });

    expect(result.results.observations.length).toBe(1);
    expect(result.results.observations[0].project).toBe('test-project');
  });

  // -------------------------------------------------------------------------
  // Query length < 2 — returns empty result, no throw
  // -------------------------------------------------------------------------

  it('returns empty result for query length 0 without throwing', async () => {
    const result = await strategy.search({ query: '' });
    expect(result.results.observations).toHaveLength(0);
    expect(result.results.sessions).toHaveLength(0);
    // Short-circuit before FTS is attempted — usedFTS must be false
    expect(result.usedFTS).toBe(false);
  });

  it('returns empty result for query length 1 without throwing', async () => {
    const result = await strategy.search({ query: 'x' });
    expect(result.results.observations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Query with special chars — sanitized, no throw
  // -------------------------------------------------------------------------

  it('handles query with special FTS5 characters without throwing', async () => {
    insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'Sanitization test',
      narrative: 'foo bar baz',
    });

    // Should sanitize and still return results (or empty) — must not throw
    const result = await strategy.search({ query: 'foo():bar', project: 'test-project' });
    expect(result.strategy).toBe('fts');
    // Result may be empty (sanitized query might not match) or non-empty — key is no throw
    expect(Array.isArray(result.results.observations)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multi-term query — results non-empty
  // -------------------------------------------------------------------------

  it('returns results for a multi-term query', async () => {
    insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'GraphQL schema design',
      narrative: 'Designed the GraphQL schema for the API',
    });

    insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'REST API migration',
      narrative: 'Migrated endpoints from REST to GraphQL',
    });

    const result = await strategy.search({ query: 'GraphQL schema', project: 'test-project' });

    expect(result.results.observations.length).toBeGreaterThan(0);
    // Both contain 'GraphQL'; the one with both terms should rank higher
    expect(result.results.observations[0].title).toContain('GraphQL schema');
  });

  // -------------------------------------------------------------------------
  // obsType filter — only matching type returned
  // -------------------------------------------------------------------------

  it('respects obsType filter', async () => {
    insertObservation(db, {
      memorySessionId: 'sess-a',
      type: 'bugfix',
      title: 'Cache invalidation bugfix',
      narrative: 'Fixed cache invalidation race condition',
    });

    insertObservation(db, {
      memorySessionId: 'sess-a',
      type: 'feature',
      title: 'Cache warming feature',
      narrative: 'Added cache warming on startup',
    });

    const result = await strategy.search({
      query: 'cache',
      project: 'test-project',
      obsType: 'bugfix'
    });

    expect(result.results.observations.length).toBe(1);
    expect(result.results.observations[0].type).toBe('bugfix');
  });

  // -------------------------------------------------------------------------
  // Limit respected
  // -------------------------------------------------------------------------

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      insertObservation(db, {
        memorySessionId: 'sess-a',
        title: `Pagination item ${i}`,
        narrative: 'paginate this row please',
      });
    }

    const result = await strategy.search({
      query: 'paginate',
      project: 'test-project',
      limit: 3
    });

    expect(result.results.observations.length).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // dateRange filter respected
  // -------------------------------------------------------------------------

  it('respects dateRange filter', async () => {
    const now = Date.now();
    const old = now - 60 * 24 * 60 * 60 * 1000; // 60 days ago

    insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'Recent timeline event',
      narrative: 'timeline filter test',
      createdAtEpoch: now,
    });

    insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'Old timeline event',
      narrative: 'timeline filter test',
      createdAtEpoch: old,
    });

    const result = await strategy.search({
      query: 'timeline',
      project: 'test-project',
      dateRange: { start: now - 1000 } // only last second
    });

    expect(result.results.observations.length).toBe(1);
    expect(result.results.observations[0].title).toContain('Recent');
  });

  // -------------------------------------------------------------------------
  // Missing FTS table — canHandle false, search returns empty with warn
  // -------------------------------------------------------------------------

  it('returns empty and canHandle=false when observations_fts table is absent', () => {
    // Build a fresh in-memory DB WITHOUT running migrations
    const bareDb = new Database(':memory:');
    bareDb.run('PRAGMA foreign_keys = ON');

    // Minimal schema: sdk_sessions + observations tables only (no FTS)
    bareDb.run(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    bareDb.run(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT,
        project TEXT,
        started_at TEXT,
        started_at_epoch INTEGER,
        status TEXT
      )
    `);
    bareDb.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT,
        type TEXT NOT NULL DEFAULT 'discovery',
        title TEXT,
        subtitle TEXT,
        narrative TEXT,
        text TEXT,
        facts TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    const bareStore = buildStore(bareDb);
    const bareSearch = buildSearch(bareDb);
    const bareStrategy = new FTSSearchStrategy(bareStore, bareSearch);

    // canHandle must return false
    expect(bareStrategy.canHandle({ query: 'something' })).toBe(false);

    // search must return empty without throwing
    return bareStrategy.search({ query: 'something' }).then(result => {
      expect(result.results.observations).toHaveLength(0);
      expect(result.strategy).toBe('fts');
      expect(result.usedFTS).toBe(false);
      bareDb.close();
    });
  });

  // -------------------------------------------------------------------------
  // sessions and prompts arrays are always empty
  // -------------------------------------------------------------------------

  it('always returns empty sessions and prompts arrays', async () => {
    insertObservation(db, {
      memorySessionId: 'sess-a',
      title: 'FTS only handles observations',
    });

    const result = await strategy.search({ query: 'observations', project: 'test-project' });

    expect(result.results.sessions).toHaveLength(0);
    expect(result.results.prompts).toHaveLength(0);
  });
});
