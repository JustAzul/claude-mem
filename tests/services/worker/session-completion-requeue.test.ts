/**
 * Regression test for: routine worker restart silently drops in-flight messages.
 *
 * Empirical evidence (2026-04-18): ~44 pending_messages went status='failed'
 * (retry_count=0, started_processing_at_epoch=NULL) across a worker restart
 * because SessionCompletionHandler called markAllSessionMessagesAbandoned even
 * when the Claude Code parent session was still active.
 *
 * The preventive fix replaces that call with a new method,
 * requeueInFlightForSession, which resets in-flight rows back to 'pending' so
 * the next generator claims them. True-abandonment paths (no-fallback drain,
 * user cancel via wall-clock guard, idle/unrecoverable termination) still call
 * markAllSessionMessagesAbandoned.
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
    pendingStore = new PendingMessageStore(db, 3);
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

    // All three rows were touched by the UPDATE (same status, but the WHERE
    // clause matched them), producing changes === 3 under SQLite semantics.
    expect(changed).toBe(3);
    expect(rowStatuses(sid)).toEqual(['pending', 'pending', 'pending']);
    expect(pendingStore.getPendingCount(sid)).toBe(3);
    expect(pendingStore.hasAnyPendingWork()).toBe(true);
  });

  test('requeueInFlightForSession resets processing message back to pending and clears started_processing_at_epoch', () => {
    const sid = seedSession('content-graceful-processing');
    enqueueMessage(sid, 'content-graceful-processing');
    enqueueMessage(sid, 'content-graceful-processing');

    // Claim one -> becomes 'processing' with started_processing_at_epoch set
    const claimed = pendingStore.claimNextMessage(sid);
    expect(claimed).not.toBeNull();

    const beforeRow = db
      .prepare('SELECT status, started_processing_at_epoch FROM pending_messages WHERE id = ?')
      .get(claimed!.id) as { status: string; started_processing_at_epoch: number | null };
    expect(beforeRow.status).toBe('processing');
    expect(beforeRow.started_processing_at_epoch).not.toBeNull();

    const changed = pendingStore.requeueInFlightForSession(sid);
    expect(changed).toBe(2);

    const afterRow = db
      .prepare('SELECT status, started_processing_at_epoch FROM pending_messages WHERE id = ?')
      .get(claimed!.id) as { status: string; started_processing_at_epoch: number | null };
    expect(afterRow.status).toBe('pending');
    expect(afterRow.started_processing_at_epoch).toBeNull();
    expect(pendingStore.hasAnyPendingWork()).toBe(true);
  });

  test('requeueInFlightForSession does NOT touch processed or failed rows', () => {
    const sid = seedSession('content-graceful-terminal');
    const msgA = enqueueMessage(sid, 'content-graceful-terminal', 'ToolA');
    const msgB = enqueueMessage(sid, 'content-graceful-terminal', 'ToolB');
    const msgC = enqueueMessage(sid, 'content-graceful-terminal', 'ToolC');

    // A claimed then marked processed (confirmProcessed deletes the row)
    pendingStore.claimNextMessage(sid);
    pendingStore.confirmProcessed(msgA);
    const aRow = db.prepare(`SELECT id FROM pending_messages WHERE id = ?`).get(msgA);
    expect(aRow).toBeNull();

    // B claimed then failed terminally (simulate retry cap reached)
    pendingStore.claimNextMessage(sid);
    // Force to failed directly
    db.prepare(
      `UPDATE pending_messages SET status = 'failed', failed_at_epoch = ? WHERE id = ?`
    ).run(Date.now(), msgB);

    // C is left pending
    expect(
      (db.prepare(`SELECT status FROM pending_messages WHERE id = ?`).get(msgC) as { status: string }).status
    ).toBe('pending');

    const changed = pendingStore.requeueInFlightForSession(sid);
    expect(changed).toBe(1); // only C matched WHERE status IN ('pending','processing')

    // A is gone (deleted on confirmProcessed), B stays failed, C stays pending
    const finalA = db.prepare(`SELECT status FROM pending_messages WHERE id = ?`).get(msgA);
    const finalB = db.prepare(`SELECT status FROM pending_messages WHERE id = ?`).get(msgB) as { status: string };
    const finalC = db.prepare(`SELECT status FROM pending_messages WHERE id = ?`).get(msgC) as { status: string };
    expect(finalA).toBeNull();
    expect(finalB.status).toBe('failed');
    expect(finalC.status).toBe('pending');
  });

  // -----------------------------------------------------------------
  // True-abandonment path — markAllSessionMessagesAbandoned
  // -----------------------------------------------------------------

  test('user-cancel / wall-clock path (markAllSessionMessagesAbandoned) still marks pending as failed', () => {
    const sid = seedSession('content-abandon');
    enqueueMessage(sid, 'content-abandon');
    enqueueMessage(sid, 'content-abandon');

    const abandoned = pendingStore.markAllSessionMessagesAbandoned(sid);
    expect(abandoned).toBe(2);
    expect(rowStatuses(sid)).toEqual(['failed', 'failed']);
    expect(pendingStore.hasAnyPendingWork()).toBe(false);
  });

  test('markAllSessionMessagesAbandoned and requeueInFlightForSession are mutually exclusive on terminal rows', () => {
    const sid = seedSession('content-exclusive');
    enqueueMessage(sid, 'content-exclusive');

    // Abandon first
    expect(pendingStore.markAllSessionMessagesAbandoned(sid)).toBe(1);
    expect(rowStatuses(sid)).toEqual(['failed']);

    // A subsequent requeue must NOT resurrect a legitimately-failed message.
    // (That's what the separate recovery script is for — and it gates on
    // retry_count/started_processing_at_epoch.)
    const changed = pendingStore.requeueInFlightForSession(sid);
    expect(changed).toBe(0);
    expect(rowStatuses(sid)).toEqual(['failed']);
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
