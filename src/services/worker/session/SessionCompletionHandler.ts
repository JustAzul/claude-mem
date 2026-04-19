/**
 * Session Completion Handler
 *
 * Consolidates session completion logic for manual session deletion/completion.
 * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete endpoints.
 *
 * Completion flow:
 * 1. Delete session from SessionManager (aborts SDK agent, cleans up in-memory state)
 * 2. Broadcast session completed event (updates UI spinner)
 */

import { SessionManager } from '../SessionManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { DatabaseManager } from '../DatabaseManager.js';
import { logger } from '../../../utils/logger.js';

export class SessionCompletionHandler {
  constructor(
    private sessionManager: SessionManager,
    private eventBroadcaster: SessionEventBroadcaster,
    private dbManager: DatabaseManager
  ) {}

  /**
   * Complete session by database ID
   * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete
   */
  async completeByDbId(sessionDbId: number): Promise<void> {
    // Persist completion to database before in-memory cleanup (fix for #1532)
    this.dbManager.getSessionStore().markSessionCompleted(sessionDbId);

    // Delete from session manager (aborts SDK agent via SIGTERM)
    await this.sessionManager.deleteSession(sessionDbId);

    // Requeue in-flight pending messages rather than failing them.
    // When deleteSession() aborts the generator, messages may be left as
    // 'pending' (never picked up) or 'processing' (generator aborted mid-flight).
    // These callers include worker-restart paths where the Claude Code parent
    // session is still active — a silent `markAllSessionMessagesAbandoned` here
    // drops work that the next generator could have completed.
    //
    // Requeue semantics:
    //   - 'pending'    → stays 'pending' (no-op)
    //   - 'processing' → reset to 'pending' with started_processing_at_epoch = NULL
    //   - 'processed'/'failed' → untouched (terminal states)
    //
    // True abandonment (stale session cleanup, no-fallback drain, wall-clock
    // guard, idle/unrecoverable termination, user cancel) still uses
    // markAllSessionMessagesAbandoned at their own call sites.
    try {
      const pendingStore = this.sessionManager.getPendingMessageStore();
      const requeuedCount = pendingStore.requeueInFlightForSession(sessionDbId);
      if (requeuedCount > 0) {
        logger.warn('SESSION', `Requeued ${requeuedCount} in-flight pending messages on session completion`, {
          sessionId: sessionDbId, requeuedCount
        });
      }
    } catch (e) {
      logger.debug('SESSION', 'Failed to requeue pending messages on session completion', {
        sessionId: sessionDbId, error: e instanceof Error ? e.message : String(e)
      });
    }

    // Broadcast session completed event
    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
  }
}
