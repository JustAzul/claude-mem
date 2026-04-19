import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('Migration V33 — memory_implicit_signals', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates memory_implicit_signals table on fresh DB', () => {
    const db = (store as unknown as { db: { prepare: Function } }).db;
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_implicit_signals'").get();
    expect(row).not.toBeNull();
  });

  it('creates all three expected indexes', () => {
    const db = (store as unknown as { db: { prepare: Function } }).db;
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_implicit_signals'").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_mis_decision');
    expect(names).toContain('idx_mis_obs');
    expect(names).toContain('idx_mis_kind_time');
  });

  it('records schema_versions row 33', () => {
    const db = (store as unknown as { db: { prepare: Function } }).db;
    const row = db.prepare('SELECT version FROM schema_versions WHERE version = 33').get();
    expect(row).toEqual({ version: 33 });
  });

  it('can insert a signal row (FKs bypassed for isolation)', () => {
    const db = (store as unknown as { db: { prepare: Function; run: Function } }).db;
    db.run('PRAGMA foreign_keys = OFF');
    db.prepare(`
      INSERT INTO memory_implicit_signals (decision_id, observation_id, signal_kind, evidence, confidence, computed_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, 100, 'file_reuse', 'src/foo.ts', 1.0, Date.now());
    const count = (db.prepare('SELECT COUNT(*) as n FROM memory_implicit_signals').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('CHECK constraint rejects unknown signal_kind', () => {
    const db = (store as unknown as { db: { prepare: Function; run: Function } }).db;
    db.run('PRAGMA foreign_keys = OFF');
    expect(() => {
      db.prepare(`
        INSERT INTO memory_implicit_signals (decision_id, observation_id, signal_kind, evidence, confidence, computed_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 100, 'invalid_kind', 'x', 1.0, Date.now());
    }).toThrow();
  });
});
