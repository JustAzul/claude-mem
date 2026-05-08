/**
 * Regression test for: routine worker restart silently drops in-flight messages.
 *
 * Post-merge (V40 schema): 'failed' status dropped, retry_count/started_processing_at_epoch
 * removed. confirmProcessed() deletes rows; markAllSessionMessagesAbandoned() deletes rows.
 * requeueInFlightForSession() resets processing → pending (UPDATE only).
 *
 * The preventive fix replaces the SessionCompletionHandler call with
 * requeueInFlightForSession, which resets in-flight rows back to 'pending' so
 * the next generator claims them. True-abandonment paths (user cancel via
 * wall-clock guard, idle/unrecoverable termination) still call
 * markAllSessionMessagesAbandoned which now DELETEs rows.
 *
 * This test locks the requeue contract at the PendingMessageStore layer and
 * proves (via a direct grep) that the SessionCompletionHandler wiring points
 * at the new method, not the old one.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';

describe('session-completion requeue vs abandon', () => {
  let db: Database;
  let pendingStore: PendingMessageStore;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    pendingStore = new PendingMessageStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSession(contentSessionId: string): number {
    return createSDKSession(db, contentSessionId, 'test-project', 'user prompt');
  }

  function enqueueMessage(sessionDbId: number, contentSessionId: string, tool = 'TestTool'): number {
    const message: PendingMessage = {
      type: 'observation',
      tool_name: tool,
      tool_input: { x: 1 },
      tool_response: { ok: true },
      prompt_number: 1,
    };
    return pendingStore.enqueue(sessionDbId, contentSessionId, message);
  }

  function rowStatuses(sessionDbId: number): string[] {
    const rows = db
      .prepare(`SELECT status FROM pending_messages WHERE session_db_id = ? ORDER BY id`)
      .all(sessionDbId) as { status: string }[];
    return rows.map((r) => r.status);
  }

  function rowCount(sessionDbId: number): number {
    const result = db
      .prepare(`SELECT COUNT(*) as count FROM pending_messages WHERE session_db_id = ?`)
      .get(sessionDbId) as { count: number };
    return result.count;
  }

  // -----------------------------------------------------------------
  // Graceful completion path — requeueInFlightForSession
  // -----------------------------------------------------------------

  test('requeueInFlightForSession keeps all three pending messages as pending', () => {
    const sid = seedSession('content-graceful-1');
    enqueueMessage(sid, 'content-graceful-1');
    enqueueMessage(sid, 'content-graceful-1');
    enqueueMessage(sid, 'content-graceful-1');

    expect(rowStatuses(sid)).toEqual(['pending', 'pending', 'pending']);

    const changed = pendingStore.requeueInFlightForSession(sid);

    // Only 'processing' rows are touched; none were claimed, so 0 changes.
    expect(changed).toBe(0);
    expect(rowStatuses(sid)).toEqual(['pending', 'pending', 'pending']);
    expect(pendingStore.getPendingCount(sid)).toBe(3);
    expect(pendingStore.hasAnyPendingWork()).toBe(true);
  });

  test('requeueInFlightForSession resets processing message back to pending', () => {
    const sid = seedSession('content-graceful-processing');
    enqueueMessage(sid, 'content-graceful-processing');
    enqueueMessage(sid, 'content-graceful-processing');

    // Claim one -> becomes 'processing'
    const claimed = pendingStore.claimNextMessage(sid);
    expect(claimed).not.toBeNull();

    const beforeRow = db
      .prepare('SELECT status FROM pending_messages WHERE id = ?')
      .get(claimed!.id) as { status: string };
    expect(beforeRow.status).toBe('processing');

    const changed = pendingStore.requeueInFlightForSession(sid);
    expect(changed).toBe(1); // only the 'processing' row is touched

    const afterRow = db
      .prepare('SELECT status FROM pending_messages WHERE id = ?')
      .get(claimed!.id) as { status: string };
    expect(afterRow.status).toBe('pending');
    expect(pendingStore.hasAnyPendingWork()).toBe(true);
  });

  test('requeueInFlightForSession does NOT touch confirmed-processed rows (deleted) or remaining pending rows', () => {
    const sid = seedSession('content-graceful-terminal');
    const msgA = enqueueMessage(sid, 'content-graceful-terminal', 'ToolA');
    const msgB = enqueueMessage(sid, 'content-graceful-terminal', 'ToolB');

    // A: claimed then confirmed processed — row is deleted
    pendingStore.claimNextMessage(sid);
    pendingStore.confirmProcessed(msgA);
    const aRow = db.prepare(`SELECT id FROM pending_messages WHERE id = ?`).get(msgA);
    expect(aRow).toBeNull();

    // B is still pending (not claimed)
    expect(
      (db.prepare(`SELECT status FROM pending_messages WHERE id = ?`).get(msgB) as { status: string }).status
    ).toBe('pending');

    const changed = pendingStore.requeueInFlightForSession(sid);
    expect(changed).toBe(0); // B is 'pending', not 'processing' — not touched

    // A is gone, B stays pending
    const finalA = db.prepare(`SELECT status FROM pending_messages WHERE id = ?`).get(msgA);
    const finalB = db.prepare(`SELECT status FROM pending_messages WHERE id = ?`).get(msgB) as { status: string };
    expect(finalA).toBeNull();
    expect(finalB.status).toBe('pending');
  });

  // -----------------------------------------------------------------
  // True-abandonment path — markAllSessionMessagesAbandoned
  // -----------------------------------------------------------------

  test('user-cancel / wall-clock path (markAllSessionMessagesAbandoned) deletes pending and processing rows', () => {
    const sid = seedSession('content-abandon');
    enqueueMessage(sid, 'content-abandon');
    enqueueMessage(sid, 'content-abandon');

    const abandoned = pendingStore.markAllSessionMessagesAbandoned(sid);
    expect(abandoned).toBe(2);
    expect(rowCount(sid)).toBe(0);
    expect(pendingStore.hasAnyPendingWork()).toBe(false);
  });

  test('markAllSessionMessagesAbandoned and requeueInFlightForSession are mutually exclusive: after abandon rows are deleted, requeue returns 0', () => {
    const sid = seedSession('content-exclusive');
    enqueueMessage(sid, 'content-exclusive');

    // Abandon first — row is deleted
    expect(pendingStore.markAllSessionMessagesAbandoned(sid)).toBe(1);
    expect(rowCount(sid)).toBe(0);

    // A subsequent requeue must return 0 because no rows exist.
    const changed = pendingStore.requeueInFlightForSession(sid);
    expect(changed).toBe(0);
    expect(rowCount(sid)).toBe(0);
  });

  // -----------------------------------------------------------------
  // Wiring assertion — SessionCompletionHandler points at the new method
  // -----------------------------------------------------------------

  test('SessionCompletionHandler uses requeueInFlightForSession, not markAllSessionMessagesAbandoned', () => {
    const handlerPath = join(
      import.meta.dir,
      '../../../src/services/worker/session/SessionCompletionHandler.ts'
    );
    const source = readFileSync(handlerPath, 'utf8');

    expect(source).toContain('requeueInFlightForSession(sessionDbId)');
    expect(source).not.toContain('markAllSessionMessagesAbandoned(sessionDbId)');
  });
});
