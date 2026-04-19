import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export type ObservationFeedbackSignal =
  | 'memory_assist_helpful'
  | 'memory_assist_not_helpful';

export interface ObservationFeedbackStats {
  windowDays: number;
  helpful: number;
  notHelpful: number;
  bySource: Record<string, { helpful: number; notHelpful: number }>;
}

export function recordObservationFeedback(
  db: Database,
  observationIds: number[],
  signalType: ObservationFeedbackSignal,
  sessionDbId?: number | null,
  metadata?: Record<string, unknown>
): void {
  if (observationIds.length === 0) return;
  logger.debug(`[observation-feedback] recording ${signalType} for ${observationIds.length} observations`);

  const insertStmt = db.prepare(`
    INSERT INTO observation_feedback (
      observation_id,
      signal_type,
      session_db_id,
      created_at_epoch,
      metadata
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const incrementStmt = db.prepare(`
    UPDATE observations
    SET relevance_count = COALESCE(relevance_count, 0) + 1
    WHERE id = ?
  `);
  const now = Date.now();
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  const tx = db.transaction((ids: number[]) => {
    for (const observationId of ids) {
      insertStmt.run(
        observationId,
        signalType,
        sessionDbId ?? null,
        now,
        metadataJson
      );

      if (signalType === 'memory_assist_helpful') {
        incrementStmt.run(observationId);
      }
    }
  });

  tx(observationIds);
}

export function getObservationFeedbackStats(
  db: Database,
  windowDays = 30
): ObservationFeedbackStats {
  const stats: ObservationFeedbackStats = {
    windowDays,
    helpful: 0,
    notHelpful: 0,
    bySource: {},
  };
  const sinceEpoch = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT signal_type, metadata
    FROM observation_feedback
    WHERE created_at_epoch >= ?
      AND signal_type IN ('memory_assist_helpful', 'memory_assist_not_helpful')
  `).all(sinceEpoch) as Array<{
    signal_type: ObservationFeedbackSignal;
    metadata: string | null;
  }>;

  for (const row of rows) {
    let source = 'unknown';
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as { source?: string };
        source = parsed.source || source;
      } catch {
        // Best-effort only.
      }
    }

    if (!stats.bySource[source]) {
      stats.bySource[source] = { helpful: 0, notHelpful: 0 };
    }

    if (row.signal_type === 'memory_assist_helpful') {
      stats.helpful += 1;
      stats.bySource[source].helpful += 1;
    } else {
      stats.notHelpful += 1;
      stats.bySource[source].notHelpful += 1;
    }
  }

  logger.debug(`[observation-feedback] loaded feedback stats for ${windowDays}d window (${rows.length} rows)`);
  return stats;
}
