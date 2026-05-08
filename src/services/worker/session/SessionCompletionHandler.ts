
import { SessionManager } from '../SessionManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { DatabaseManager } from '../DatabaseManager.js';
import { SqliteObservationQueueEngine } from '../../../server/queue/ObservationQueueEngine.js';
import { logger } from '../../../utils/logger.js';

export class SessionCompletionHandler {
  constructor(
    private sessionManager: SessionManager,
    private eventBroadcaster: SessionEventBroadcaster,
    private dbManager: DatabaseManager
  ) {}

  async finalizeSession(sessionDbId: number): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    const row = sessionStore.getSessionById(sessionDbId);
    if (!row) {
      logger.debug('SESSION', 'finalizeSession: session not found, skipping', { sessionId: sessionDbId });
      return;
    }
    if (row.status === 'completed') {
      logger.debug('SESSION', 'finalizeSession: already completed, skipping', { sessionId: sessionDbId });
      return;
    }

    sessionStore.markSessionCompleted(sessionDbId);

    // Requeue in-flight pending messages rather than failing them.
    // 'processing' rows from an aborted generator get reset to 'pending' so the
    // next generator can complete the work; true abandonment paths (stale GC,
    // wall-clock guard, user cancel) call markAllSessionMessagesAbandoned at
    // their own call sites.
    try {
      const pendingStore = this.sessionManager.getPendingMessageStore() as SqliteObservationQueueEngine;
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

    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);

    logger.info('SESSION', 'Session finalized', { sessionId: sessionDbId });
  }

  async completeByDbId(sessionDbId: number): Promise<void> {
    await this.finalizeSession(sessionDbId);

    await this.sessionManager.deleteSession(sessionDbId);
  }
}
