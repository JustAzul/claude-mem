import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { computeImplicitSignals } from '../../../src/services/memory/implicit-signal-computer.js';

function setupSchema(db: Database): void {
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      title TEXT,
      narrative TEXT,
      facts TEXT,
      files_read TEXT,
      files_modified TEXT
    )
  `);
  db.run(`
    CREATE TABLE observation_capture_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER,
      content_session_id TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      prior_assistant_message TEXT,
      created_at_epoch INTEGER NOT NULL
    )
  `);
}

function seedObs(
  db: Database,
  id: number,
  opts: {
    title?: string;
    narrative?: string;
    facts?: string[];
    filesRead?: string[];
    filesModified?: string[];
  } = {}
): void {
  db.prepare(
    'INSERT INTO observations (id, title, narrative, facts, files_read, files_modified) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    opts.title ?? null,
    opts.narrative ?? null,
    opts.facts ? JSON.stringify(opts.facts) : null,
    opts.filesRead ? JSON.stringify(opts.filesRead) : null,
    opts.filesModified ? JSON.stringify(opts.filesModified) : null
  );
}

function seedToolCall(
  db: Database,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  createdAtEpoch: number,
  lastAssistant?: string
): void {
  db.prepare(
    'INSERT INTO observation_capture_snapshots (content_session_id, tool_name, tool_input, prior_assistant_message, created_at_epoch) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, toolName, JSON.stringify(toolInput), lastAssistant ?? null, createdAtEpoch);
}

describe('computeImplicitSignals', () => {
  let db: Database;
  const SESSION = 'sess-1';
  const BASE = 1_700_000_000_000;

  beforeEach(() => {
    db = new Database(':memory:');
    setupSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty when injectedObservationIds empty', () => {
    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [],
    });
    expect(out).toEqual([]);
  });

  it('emits file_reuse (confidence 1.0) when tool call matches obs file exactly', () => {
    seedObs(db, 100, { filesRead: ['src/foo.ts'] });
    seedToolCall(db, SESSION, 'Read', { file_path: 'src/foo.ts' }, BASE + 1000);

    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [100],
    });
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      observation_id: 100,
      signal_kind: 'file_reuse',
      confidence: 1.0,
    });
    expect(out[0].evidence).toBe('src/foo.ts');
  });

  it('emits file_reuse (confidence 0.7) via basename fallback', () => {
    seedObs(db, 100, { filesRead: ['src/foo.ts'] });
    // Different directory, same basename
    seedToolCall(db, SESSION, 'Read', { file_path: '/other/dir/foo.ts' }, BASE + 1000);

    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [100],
    });
    expect(out.length).toBe(1);
    expect(out[0].signal_kind).toBe('file_reuse');
    expect(out[0].confidence).toBe(0.7);
  });

  it('emits content_cited when identifier appears in next assistant message', () => {
    seedObs(db, 100, {
      title: 'ResponseProcessor refactor',
      narrative: 'Moved logic into `applyObservationGates`.',
    });
    // Tool call has the citation in its last_assistant_message
    seedToolCall(
      db,
      SESSION,
      'Bash',
      { command: 'echo hello' },
      BASE + 1000,
      'I updated the ResponseProcessor to delegate to the new helper.'
    );

    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [100],
    });
    expect(out.length).toBe(1);
    expect(out[0].signal_kind).toBe('content_cited');
    expect(out[0].confidence).toBe(0.7);
  });

  it('emits no_overlap when neither file nor content matches', () => {
    seedObs(db, 100, {
      title: 'Some unrelated thing',
      narrative: 'Touched `alpha_beta_gamma_delta`.',
      filesRead: ['src/nowhere.ts'],
    });
    seedToolCall(
      db,
      SESSION,
      'Read',
      { file_path: 'src/elsewhere.py' },
      BASE + 1000,
      'Did completely different work.'
    );

    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [100],
    });
    expect(out.length).toBe(1);
    expect(out[0].signal_kind).toBe('no_overlap');
    expect(out[0].evidence).toBeNull();
  });

  it('respects window boundary (tool call after window is ignored)', () => {
    seedObs(db, 100, { filesRead: ['src/foo.ts'] });
    // Tool call fires AFTER the window ends
    seedToolCall(db, SESSION, 'Read', { file_path: 'src/foo.ts' }, BASE + 60 * 60 * 1000);

    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [100],
      windowMs: 30 * 60 * 1000,
    });
    expect(out[0].signal_kind).toBe('no_overlap');
  });

  it('returns one row per injected observation', () => {
    seedObs(db, 100, { filesRead: ['src/foo.ts'] });
    seedObs(db, 101, { narrative: 'Something about `BarBazClass`.' });
    seedObs(db, 102, { filesRead: ['src/nothing.ts'] });
    seedToolCall(db, SESSION, 'Read', { file_path: 'src/foo.ts' }, BASE + 1000, 'Touched BarBazClass here.');

    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [100, 101, 102],
    });
    expect(out.length).toBe(3);
    const byObs = Object.fromEntries(out.map((r) => [r.observation_id, r.signal_kind]));
    expect(byObs[100]).toBe('file_reuse');
    expect(byObs[101]).toBe('content_cited');
    expect(byObs[102]).toBe('no_overlap');
  });

  it('skips missing observations gracefully', () => {
    // No obs row for id 999
    const out = computeImplicitSignals(db, {
      decisionId: 1,
      contentSessionId: SESSION,
      injectedAtEpoch: BASE,
      injectedObservationIds: [999],
    });
    expect(out).toEqual([]);
  });
});
