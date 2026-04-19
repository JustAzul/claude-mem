/**
 * Tests for getObservationsByFilePath — including 1-hop cross-ref expansion
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' — tests actual SQL and hop logic
 * - Validates direct retrieval, cross-ref expansion, budget, dedup, project scope, via field
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';

// Insert a session row (required FK for observations)
function insertSession(db: Database, memorySessionId: string, project = 'test-project'): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(memorySessionId, memorySessionId, project, now, Date.now(), 'active');
}

interface InsertObsOpts {
  memorySessionId: string;
  project?: string;
  filesRead?: string[];
  filesModified?: string[];
  relatedObservationIds?: number[] | null;
  title?: string;
  createdAtEpoch?: number;
}

// Insert an observation and return its auto-assigned id
function insertObservation(db: Database, opts: InsertObsOpts): number {
  const now = new Date().toISOString();
  const project = opts.project ?? 'test-project';
  const filesRead = opts.filesRead ? JSON.stringify(opts.filesRead) : null;
  const filesModified = opts.filesModified ? JSON.stringify(opts.filesModified) : null;
  const relatedIds = opts.relatedObservationIds != null
    ? JSON.stringify(opts.relatedObservationIds)
    : null;
  const epoch = opts.createdAtEpoch ?? Date.now();
  const result = db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, type, title, files_read, files_modified,
       related_observation_ids, created_at, created_at_epoch)
    VALUES (?, ?, 'discovery', ?, ?, ?, ?, ?, ?)
  `).run(
    opts.memorySessionId,
    project,
    opts.title ?? 'test observation',
    filesRead,
    filesModified,
    relatedIds,
    now,
    epoch
  );
  return result.lastInsertRowid as number;
}

describe('getObservationsByFilePath — cross-ref hop expansion', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    insertSession(db, 'sess-A', 'test-project');
    insertSession(db, 'sess-B', 'test-project');
    insertSession(db, 'sess-C', 'other-project');
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: direct match — no cross-ref — still works
  it('returns direct results with via=direct when no related_observation_ids present', () => {
    insertObservation(db, {
      memorySessionId: 'sess-A',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Direct observation',
    });

    const results = getObservationsByFilePath(db, 'src/foo.ts');
    expect(results.length).toBe(1);
    expect(results[0].via).toBe('direct');
    expect(results[0].title).toBe('Direct observation');
  });

  // Test 2: cross-ref hop returns linked observation
  it('returns hop observation (via=cross_ref) when direct row links to another', () => {
    // obsB is indexed against a different file — won't match direct query
    const idB = insertObservation(db, {
      memorySessionId: 'sess-B',
      filesModified: ['/repo/src/other-file.ts'],
      title: 'Cross-cutting lesson',
    });

    // obsA matches the query file and links to idB
    insertObservation(db, {
      memorySessionId: 'sess-A',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Direct with cross-ref',
      relatedObservationIds: [idB],
    });

    const results = getObservationsByFilePath(db, 'src/foo.ts');
    expect(results.length).toBe(2);

    const direct = results.find(r => r.via === 'direct');
    const hopped = results.find(r => r.via === 'cross_ref');

    expect(direct).toBeDefined();
    expect(direct!.title).toBe('Direct with cross-ref');

    expect(hopped).toBeDefined();
    expect(hopped!.id).toBe(idB);
    expect(hopped!.title).toBe('Cross-cutting lesson');
  });

  // Test 3: dedup — if related ID is also a direct result, not duplicated
  it('does not duplicate an observation that appears as both direct and cross-ref', () => {
    const idA = insertObservation(db, {
      memorySessionId: 'sess-A',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Obs A — direct',
    });

    // obsB is also a direct match AND linked from obsA
    const idB = insertObservation(db, {
      memorySessionId: 'sess-B',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Obs B — direct and linked',
      relatedObservationIds: [idA],
    });

    // obsA also links to obsB (mutual), but obsB is a direct match
    db.prepare('UPDATE observations SET related_observation_ids = ? WHERE id = ?')
      .run(JSON.stringify([idB]), idA);

    const results = getObservationsByFilePath(db, 'src/foo.ts');
    const ids = results.map(r => r.id);

    // Both should appear exactly once
    expect(ids.filter(id => id === idA).length).toBe(1);
    expect(ids.filter(id => id === idB).length).toBe(1);
    // Both should be via=direct (they both match the file path)
    expect(results.every(r => r.via === 'direct')).toBe(true);
  });

  // Test 4: budget — if primary fills limit, hop rows are not added
  it('skips cross-ref hop when direct results fill the limit', () => {
    // obsB is the potential hop target — different file
    const idB = insertObservation(db, {
      memorySessionId: 'sess-B',
      filesModified: ['/repo/src/other.ts'],
      title: 'Cross-cutting lesson',
    });

    // Insert 3 direct observations, each linking to idB; set limit=3
    for (let i = 0; i < 3; i++) {
      insertObservation(db, {
        memorySessionId: 'sess-A',
        filesModified: ['/repo/src/foo.ts'],
        title: `Direct obs ${i}`,
        relatedObservationIds: [idB],
      });
    }

    const results = getObservationsByFilePath(db, 'src/foo.ts', { limit: 3 });
    expect(results.length).toBe(3);
    expect(results.every(r => r.via === 'direct')).toBe(true);
    // idB should NOT appear since budget is full
    expect(results.some(r => r.id === idB)).toBe(false);
  });

  // Test 5: invalid JSON in related_observation_ids — doesn't crash, returns direct only
  it('gracefully handles malformed related_observation_ids JSON', () => {
    const id = insertObservation(db, {
      memorySessionId: 'sess-A',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Obs with bad JSON',
    });

    // Manually corrupt the field
    db.prepare('UPDATE observations SET related_observation_ids = ? WHERE id = ?')
      .run('NOT_VALID_JSON', id);

    const results = getObservationsByFilePath(db, 'src/foo.ts');
    expect(results.length).toBe(1);
    expect(results[0].via).toBe('direct');
  });

  // Test 6: project scope — hop respects the projects filter
  it('hop results respect the projects filter', () => {
    insertSession(db, 'sess-other', 'other-project');

    // obsB belongs to 'other-project', different file
    const idB = insertObservation(db, {
      memorySessionId: 'sess-other',
      project: 'other-project',
      filesModified: ['/repo/src/other.ts'],
      title: 'Lesson from other project',
    });

    // obsA belongs to 'test-project', links to idB
    insertObservation(db, {
      memorySessionId: 'sess-A',
      project: 'test-project',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Direct in test-project',
      relatedObservationIds: [idB],
    });

    // When querying with project scope, the hop target from other-project should NOT appear
    const results = getObservationsByFilePath(db, 'src/foo.ts', { projects: ['test-project'] });
    expect(results.some(r => r.id === idB)).toBe(false);
    expect(results.length).toBe(1);
    expect(results[0].via).toBe('direct');
  });

  // Test 7: via field correctness — direct rows have via=direct, hop rows have via=cross_ref
  it('via field is correct for both direct and cross-ref rows', () => {
    const idB = insertObservation(db, {
      memorySessionId: 'sess-B',
      filesModified: ['/repo/src/unrelated.ts'],
      title: 'Hop target',
    });

    const idA = insertObservation(db, {
      memorySessionId: 'sess-A',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Direct source',
      relatedObservationIds: [idB],
    });

    const results = getObservationsByFilePath(db, 'src/foo.ts');

    const rowA = results.find(r => r.id === idA);
    const rowB = results.find(r => r.id === idB);

    expect(rowA?.via).toBe('direct');
    expect(rowB?.via).toBe('cross_ref');
  });

  // Test 8: non-array JSON in related_observation_ids is skipped gracefully
  it('skips related_observation_ids when JSON parses to non-array', () => {
    const id = insertObservation(db, {
      memorySessionId: 'sess-A',
      filesModified: ['/repo/src/foo.ts'],
      title: 'Obs with object JSON',
    });

    db.prepare('UPDATE observations SET related_observation_ids = ? WHERE id = ?')
      .run('{"key": 123}', id);

    const results = getObservationsByFilePath(db, 'src/foo.ts');
    expect(results.length).toBe(1);
    expect(results[0].via).toBe('direct');
  });
});
