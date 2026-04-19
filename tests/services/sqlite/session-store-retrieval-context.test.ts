/**
 * Unit tests for SessionStore.getObservationRetrievalContext (Phase 4)
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' — tests actual SQL and schema
 * - Covers snapshot table (V30) retrieval via observation_capture_snapshots
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import {
  insertCaptureSnapshot,
  emptyCaptureSnapshotSource,
  capturedFromObservation,
} from '../../../src/services/sqlite/observations/capture-snapshot.js';

function makeStore(): SessionStore {
  return new SessionStore(':memory:');
}

/** Helper: create a minimal observation and return its auto-incremented id */
function insertObs(store: SessionStore, memorySessionId: string): number {
  const now = Date.now();
  store.db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(memorySessionId, 'test-project', 'observation text', 'learning', new Date().toISOString(), now);
  return (store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
}

const EMPTY_CAPTURED = capturedFromObservation({
  type: 'learning', title: 'T', subtitle: null, narrative: null,
  facts: [], concepts: [], why: null, alternatives_rejected: null,
  related_observation_ids: [],
});

/** Helper: create a minimal sdk_session so the FK constraint is satisfied */
function insertSession(store: SessionStore, memSessionId: string): void {
  const now = Date.now();
  store.db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('content-' + memSessionId, memSessionId, 'test-project', 'claude', new Date().toISOString(), now, 'active');
}

describe('SessionStore.getObservationRetrievalContext', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = makeStore();
    insertSession(store, 'mem-a');
    insertSession(store, 'mem-b');
  });

  afterEach(() => {
    store.close();
  });

  it('returns an empty Map for an empty ids array', () => {
    const result = store.getObservationRetrievalContext([]);
    expect(result.size).toBe(0);
  });

  it('returns keys absent for IDs with no snapshot', () => {
    const obsId = insertObs(store, 'mem-a');
    // No snapshot inserted
    const result = store.getObservationRetrievalContext([obsId]);
    expect(result.has(obsId)).toBe(false);
  });

  it('returns correct context for an ID that has a snapshot', () => {
    const obsId = insertObs(store, 'mem-a');
    const source = {
      ...emptyCaptureSnapshotSource('mem-a', 'content-mem-a', 3),
      userPrompt: 'what is the issue?',
      priorAssistantMessage: 'I was exploring the file.',
    };
    insertCaptureSnapshot(store.db, obsId, source, EMPTY_CAPTURED, Date.now());

    const result = store.getObservationRetrievalContext([obsId]);
    expect(result.has(obsId)).toBe(true);
    const ctx = result.get(obsId)!;
    expect(ctx.user_prompt).toBe('what is the issue?');
    expect(ctx.prior_assistant_message).toBe('I was exploring the file.');
    expect(ctx.content_session_id).toBe('content-mem-a');
    expect(ctx.prompt_number).toBe(3);
  });

  it('handles mixed IDs — some with snapshots, some without', () => {
    const obsWithSnap = insertObs(store, 'mem-a');
    const obsNoSnap = insertObs(store, 'mem-b');

    insertCaptureSnapshot(store.db, obsWithSnap, {
      ...emptyCaptureSnapshotSource('mem-a', 'content-mem-a', 1),
      userPrompt: 'hello',
      priorAssistantMessage: null,
    }, EMPTY_CAPTURED, Date.now());

    const result = store.getObservationRetrievalContext([obsWithSnap, obsNoSnap]);
    expect(result.has(obsWithSnap)).toBe(true);
    expect(result.has(obsNoSnap)).toBe(false);
    expect(result.get(obsWithSnap)!.user_prompt).toBe('hello');
  });

  it('returns the latest snapshot when duplicates exist for the same observation_id', () => {
    const obsId = insertObs(store, 'mem-a');
    const epochOld = 1000000;
    const epochNew = 9000000;

    // Insert older snapshot first
    insertCaptureSnapshot(store.db, obsId, {
      ...emptyCaptureSnapshotSource('mem-a', 'content-mem-a', 2),
      userPrompt: 'older prompt',
      priorAssistantMessage: 'older assistant',
    }, EMPTY_CAPTURED, epochOld);

    // Insert newer snapshot second
    insertCaptureSnapshot(store.db, obsId, {
      ...emptyCaptureSnapshotSource('mem-a', 'content-mem-a', 2),
      userPrompt: 'newer prompt',
      priorAssistantMessage: 'newer assistant',
    }, EMPTY_CAPTURED, epochNew);

    const result = store.getObservationRetrievalContext([obsId]);
    expect(result.has(obsId)).toBe(true);
    const ctx = result.get(obsId)!;
    expect(ctx.user_prompt).toBe('newer prompt');
    expect(ctx.prior_assistant_message).toBe('newer assistant');
  });
});
