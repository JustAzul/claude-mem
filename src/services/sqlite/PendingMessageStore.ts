import { Database } from 'bun:sqlite';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/**
 * Persistent pending message record from database.
 *
 * Matches the final upstream schema (rebuildPendingMessagesForFinalQueueSchema):
 * - Dropped: retry_count, started_processing_at_epoch, failed_at_epoch, completed_at_epoch
 * - Added: tool_use_id, last_user_message
 * - Status: 'pending' | 'processing' only (processed rows are deleted; failures re-queue)
 */
export interface PersistentPendingMessage {
  id: number;
  session_db_id: number;
  content_session_id: string;
  tool_use_id: string | null;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_user_message: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: 'pending' | 'processing';
  created_at_epoch: number;
  agent_type: string | null;
  agent_id: string | null;
}

/**
 * PendingMessageStore - Persistent work queue for SDK messages.
 *
 * Lifecycle:
 * 1. enqueue()           — Persist with status 'pending'; returns 0 on tool_use_id duplicate.
 * 2. claimNextMessage()  — Atomically claims next pending message (pending → processing).
 * 3. confirmProcessed()  — Deletes message after successful processing.
 *
 * Recovery:
 * - markFailed()                    — Resets a processing row back to 'pending'.
 * - markSessionMessagesFailed()     — Deletes processing rows for a session.
 * - markAllSessionMessagesAbandoned()— Deletes all rows for a session.
 * - resetProcessingToPending()      — Resets processing → pending for graceful handoff.
 * - getSessionsWithPendingMessages()— Finds sessions needing recovery on startup.
 */
export class PendingMessageStore {
  private db: Database;
  /** Optional callback invoked after a successful enqueue (used by SqliteObservationQueueEngine). */
  private onEnqueue: (() => void) | undefined;

  constructor(db: Database, onEnqueue?: () => void) {
    this.db = db;
    this.onEnqueue = onEnqueue;
  }

  // ---------------------------------------------------------------------------
  // Enqueue
  // ---------------------------------------------------------------------------

  /**
   * Persist a message with status 'pending'.
   * @returns The new row's id (>0), or 0 when tool_use_id dedup rejects the insert.
   */
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): number {
    const now = Date.now();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO pending_messages (
          session_db_id, content_session_id, tool_use_id, message_type,
          tool_name, tool_input, tool_response, cwd,
          last_user_message, last_assistant_message,
          prompt_number, status, created_at_epoch,
          agent_type, agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `);

      const result = stmt.run(
        sessionDbId,
        contentSessionId,
        message.toolUseId ?? null,
        message.type,
        message.tool_name ?? null,
        message.tool_input ? JSON.stringify(message.tool_input) : null,
        message.tool_response ? JSON.stringify(message.tool_response) : null,
        message.cwd ?? null,
        null, // last_user_message — not in PendingMessage type; populated by upstream at enqueue time
        message.last_assistant_message ?? null,
        message.prompt_number ?? null,
        now,
        message.agentType ?? null,
        message.agentId ?? null
      );

      const id = result.lastInsertRowid as number;
      this.onEnqueue?.();
      return id;
    } catch (err: unknown) {
      // Unique index ux_pending_session_tool fires when tool_use_id is non-null and duplicate.
      if (
        err instanceof Error &&
        err.message.includes('UNIQUE constraint failed')
      ) {
        logger.debug('QUEUE', `DEDUP | contentSessionId=${contentSessionId} | toolUseId=${message.toolUseId}`);
        return 0;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------------

  /**
   * Atomically claim the next pending message (pending → processing).
   * No self-healing via timestamps — the schema no longer has started_processing_at_epoch.
   */
  claimNextMessage(sessionDbId: number): PersistentPendingMessage | null {
    const claimTx = this.db.transaction((sessionId: number) => {
      const peekStmt = this.db.prepare(`
        SELECT * FROM pending_messages
        WHERE session_db_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `);
      let msg = peekStmt.get(sessionId) as PersistentPendingMessage | null;

      if (msg) {
        this.db.prepare(`
          UPDATE pending_messages SET status = 'processing' WHERE id = ?
        `).run(msg.id);

        logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionId} | messageId=${msg.id} | type=${msg.message_type}`, {
          sessionId
        });

        // Return row with updated status so callers see 'processing' immediately.
        msg = { ...msg, status: 'processing' };
      }

      return msg;
    });

    return claimTx(sessionDbId) as PersistentPendingMessage | null;
  }

  /**
   * Claim a consecutive run of observation messages for batching.
   * Stops at the first non-observation or when maxItems is reached.
   * A non-observation that interrupts a partial batch is reset to pending.
   */
  claimObservationBatch(sessionDbId: number, maxItems: number): PersistentPendingMessage[] {
    const results: PersistentPendingMessage[] = [];

    for (let i = 0; i < maxItems; i++) {
      const msg = this.claimNextMessage(sessionDbId);
      if (!msg) break;

      if (msg.message_type !== 'observation') {
        this.db.prepare(
          `UPDATE pending_messages SET status = 'pending' WHERE id = ?`
        ).run(msg.id);
        break;
      }

      results.push(msg);
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Confirm / Delete
  // ---------------------------------------------------------------------------

  /**
   * Confirm a message was successfully processed — DELETE it from the queue.
   * Only call this AFTER the observation/summary has been stored to DB.
   */
  confirmProcessed(messageId: number): void {
    const result = this.db.prepare('DELETE FROM pending_messages WHERE id = ?').run(messageId);
    if (result.changes > 0) {
      logger.debug('QUEUE', `CONFIRMED | messageId=${messageId} | deleted from queue`);
    }
  }

  /**
   * Delete all processing messages for a session (replaces "mark failed").
   * The 'failed' status was dropped; abandonment equals deletion.
   * @returns Number of messages deleted
   */
  markSessionMessagesFailed(sessionDbId: number): number {
    return this.db.prepare(`
      DELETE FROM pending_messages WHERE session_db_id = ? AND status = 'processing'
    `).run(sessionDbId).changes;
  }

  /**
   * Delete all pending and processing messages for a session.
   * @returns Number of messages deleted
   */
  markAllSessionMessagesAbandoned(sessionDbId: number): number {
    return this.db.prepare(`
      DELETE FROM pending_messages WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `).run(sessionDbId).changes;
  }

  /**
   * Clear all pending and processing messages for a session.
   * Used by SqliteObservationQueueEngine and tests.
   * @returns Number of messages deleted
   */
  clearPendingForSession(sessionDbId: number): number {
    return this.db.prepare(`
      DELETE FROM pending_messages WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `).run(sessionDbId).changes;
  }

  /**
   * Clear ALL pending and processing messages across all sessions.
   * @returns Number of messages deleted
   */
  clearAll(): number {
    return this.db.prepare(`
      DELETE FROM pending_messages WHERE status IN ('pending', 'processing')
    `).run().changes;
  }

  /**
   * Delete a single message by id.
   */
  abortMessage(messageId: number): boolean {
    return this.db.prepare('DELETE FROM pending_messages WHERE id = ?').run(messageId).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Reset / Re-queue
  // ---------------------------------------------------------------------------

  /**
   * Reset a processing message back to 'pending'.
   * Upstream dropped retry tracking; a failure simply re-queues the message.
   */
  markFailed(messageId: number): void {
    this.db.prepare(`
      UPDATE pending_messages SET status = 'pending' WHERE id = ? AND status = 'processing'
    `).run(messageId);
  }

  /**
   * Reset all processing messages for a session back to 'pending'.
   * Used for graceful handoff to a new generator (preserves created_at_epoch).
   * @returns Number of rows reset
   */
  resetProcessingToPending(sessionDbId: number): number {
    return this.db.prepare(`
      UPDATE pending_messages SET status = 'pending'
      WHERE session_db_id = ? AND status = 'processing'
    `).run(sessionDbId).changes;
  }

  /**
   * Alias for resetProcessingToPending — graceful handoff on generator completion.
   * @returns Number of rows reset
   */
  requeueInFlightForSession(sessionDbId: number): number {
    return this.resetProcessingToPending(sessionDbId);
  }

  /**
   * Reset a specific message to 'pending'.
   * Works for pending (re-queue) and processing (reset stuck).
   */
  retryMessage(messageId: number): boolean {
    return this.db.prepare(`
      UPDATE pending_messages SET status = 'pending'
      WHERE id = ? AND status IN ('pending', 'processing')
    `).run(messageId).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Counts / Queries
  // ---------------------------------------------------------------------------

  /**
   * Count pending and processing messages for a session.
   */
  getPendingCount(sessionDbId: number): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `).get(sessionDbId) as { count: number };
    return result.count;
  }

  /**
   * Count all pending and processing messages across all sessions.
   */
  getTotalQueueDepth(): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages WHERE status IN ('pending', 'processing')
    `).get() as { count: number };
    return result.count;
  }

  /**
   * Check if any session has pending or processing work.
   */
  hasAnyPendingWork(): boolean {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages WHERE status IN ('pending', 'processing')
    `).get() as { count: number };
    return result.count > 0;
  }

  /**
   * Get all pending messages for a session (ordered by creation time).
   */
  getAllPending(sessionDbId: number): PersistentPendingMessage[] {
    return this.db.prepare(`
      SELECT * FROM pending_messages WHERE session_db_id = ? AND status = 'pending' ORDER BY id ASC
    `).all(sessionDbId) as PersistentPendingMessage[];
  }

  /**
   * Get all queue messages for UI display (pending + processing, with project name).
   */
  getQueueMessages(): (PersistentPendingMessage & { project: string | null })[] {
    return this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status IN ('pending', 'processing')
      ORDER BY
        CASE pm.status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 END,
        pm.created_at_epoch ASC
    `).all() as (PersistentPendingMessage & { project: string | null })[];
  }

  /**
   * Peek at pending message types for a session (for tier routing), without claiming.
   */
  peekPendingTypes(sessionDbId: number): Array<{ message_type: string; tool_name: string | null }> {
    return this.db.prepare(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `).all(sessionDbId) as Array<{ message_type: string; tool_name: string | null }>;
  }

  /**
   * Get all session db ids that have pending or processing messages (for startup recovery).
   */
  getSessionsWithPendingMessages(): number[] {
    const results = this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
      ORDER BY session_db_id ASC
    `).all() as { session_db_id: number }[];
    return results.map(r => r.session_db_id);
  }

  /**
   * Get session info for a pending message (for recovery).
   */
  getSessionInfoForMessage(messageId: number): { sessionDbId: number; contentSessionId: string } | null {
    const result = this.db.prepare(`
      SELECT session_db_id, content_session_id FROM pending_messages WHERE id = ?
    `).get(messageId) as { session_db_id: number; content_session_id: string } | undefined;
    return result ? { sessionDbId: result.session_db_id, contentSessionId: result.content_session_id } : null;
  }

  // ---------------------------------------------------------------------------
  // Conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert a PersistentPendingMessage back to PendingMessage format.
   */
  toPendingMessage(persistent: PersistentPendingMessage): PendingMessage {
    return {
      type: persistent.message_type,
      tool_name: persistent.tool_name ?? undefined,
      tool_input: persistent.tool_input ? JSON.parse(persistent.tool_input) : undefined,
      tool_response: persistent.tool_response ? JSON.parse(persistent.tool_response) : undefined,
      prompt_number: persistent.prompt_number ?? undefined,
      cwd: persistent.cwd ?? undefined,
      last_assistant_message: persistent.last_assistant_message ?? undefined,
      agentId: persistent.agent_id ?? undefined,
      agentType: persistent.agent_type ?? undefined,
      toolUseId: persistent.tool_use_id ?? undefined,
    };
  }
}
