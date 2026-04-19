/**
 * Memory Routes
 *
 * Handles manual memory/observation saving and implicit signal computation.
 * POST /api/memory/save           - Save a manual memory observation
 * POST /api/memory/compute-signals - Compute implicit use signals for a session
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import type { MemoryAssistTraceItem } from '../../../../shared/memory-assist.js';
import { computeImplicitSignals, persistImplicitSignals } from '../../../memory/implicit-signal-computer.js';

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', this.handleSaveMemory.bind(this));
    app.post('/api/memory/compute-signals', this.handleComputeSignals.bind(this));
    app.get('/api/memory/audit', this.handleAudit.bind(this));
  }

  /**
   * POST /api/memory/save - Save a manual memory/observation
   * Body: { text: string, title?: string, project?: string }
   */
  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { text, title, project } = req.body;
    const targetProject = project || this.defaultProject;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      this.badRequest(res, 'text is required and must be non-empty');
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    // 1. Get or create manual session for project
    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    // 2. Build observation
    const observation = {
      type: 'discovery',  // Use existing valid type
      title: title || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
      subtitle: 'Manual memory',
      facts: [] as string[],
      narrative: text,
      concepts: [] as string[],
      files_read: [] as string[],
      files_modified: [] as string[],
      why: null,
      alternatives_rejected: null,
      related_observation_ids: [] as number[]
    };

    // 3. Store to SQLite
    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0   // discoveryTokens
    );

    logger.info('HTTP', 'Manual observation saved', {
      id: result.id,
      project: targetProject,
      title: observation.title
    });

    // 4. Sync to ChromaDB (async, fire-and-forget)
    chromaSync.syncObservation(
      result.id,
      memorySessionId,
      targetProject,
      observation,
      0,
      result.createdAtEpoch,
      0
    ).catch(err => {
      logger.error('CHROMA', 'ChromaDB sync failed', { id: result.id }, err as Error);
    });

    // 5. Return success
    res.json({
      success: true,
      id: result.id,
      title: observation.title,
      project: targetProject,
      message: `Memory saved as observation #${result.id}`
    });
  });

  /**
   * POST /api/memory/compute-signals
   * Body: { contentSessionId: string, windowMs?: number, maxToolCalls?: number }
   *
   * Computes file_reuse and content_cited signals for all uncomputed injected
   * decisions in the given session. Best-effort — skips decisions where
   * observation IDs cannot be parsed.
   */
  private handleComputeSignals = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { contentSessionId, windowMs, maxToolCalls } = req.body as {
      contentSessionId?: string;
      windowMs?: number;
      maxToolCalls?: number;
    };

    if (!contentSessionId || typeof contentSessionId !== 'string') {
      this.badRequest(res, 'contentSessionId is required');
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const db = sessionStore.db;

    const uncomputed = sessionStore.getUncomputedDecisionsForSession(contentSessionId);

    let processed = 0;
    let signalsWritten = 0;
    let skipped = 0;

    for (const decision of uncomputed) {
      // Extract observation IDs from trace_items_json
      let observationIds: number[];
      try {
        const traceItems = decision.trace_items_json
          ? (JSON.parse(decision.trace_items_json) as MemoryAssistTraceItem[])
          : [];
        observationIds = traceItems
          .map((item) => item.observationId)
          .filter((id): id is number => typeof id === 'number' && id > 0);
      } catch {
        logger.debug('HTTP', `compute-signals: skipping decision ${decision.decision_id} — trace_items_json parse failed`);
        skipped++;
        continue;
      }

      if (observationIds.length === 0) {
        skipped++;
        continue;
      }

      const signals = computeImplicitSignals(db, {
        decisionId: decision.decision_id,
        contentSessionId,
        injectedAtEpoch: decision.created_at_epoch,
        injectedObservationIds: observationIds,
        ...(typeof windowMs === 'number' ? { windowMs } : {}),
        ...(typeof maxToolCalls === 'number' ? { maxToolCalls } : {}),
      });

      persistImplicitSignals(db, decision.decision_id, signals);
      processed++;
      signalsWritten += signals.length;
    }

    logger.debug('HTTP', 'compute-signals complete', { contentSessionId, processed, signalsWritten, skipped });

    res.json({ processed, signals_written: signalsWritten, skipped });
  });

  /**
   * GET /api/memory/audit?contentSessionId=X&windowMinutes=N
   *
   * Self-audit tool for Claude: returns each injection in the window with the
   * implicit-use verdict per observation. Lets Claude check if it actually
   * applied memory that was offered, not just whether memory was delivered.
   */
  private handleAudit = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const contentSessionId = typeof req.query.contentSessionId === 'string' ? req.query.contentSessionId : null;
    if (!contentSessionId) {
      this.badRequest(res, 'contentSessionId query param is required');
      return;
    }
    const windowMinutes = Number.isFinite(Number(req.query.windowMinutes))
      ? Math.max(1, Math.min(1440, Number(req.query.windowMinutes)))
      : 60;
    const windowEnd = Date.now();
    const windowStart = windowEnd - windowMinutes * 60 * 1000;

    const sessionStore = this.dbManager.getSessionStore();
    const db = sessionStore.db;

    const decisions = db.prepare(`
      SELECT id, created_at_epoch, status, source, trace_items_json
      FROM memory_assist_decisions
      WHERE content_session_id = ?
        AND status = 'injected'
        AND created_at_epoch >= ?
        AND created_at_epoch <= ?
      ORDER BY created_at_epoch DESC
    `).all(contentSessionId, windowStart, windowEnd) as Array<{
      id: number;
      created_at_epoch: number;
      status: string;
      source: string;
      trace_items_json: string | null;
    }>;

    const injections = decisions.map((d) => {
      let traceItems: MemoryAssistTraceItem[] = [];
      try {
        traceItems = d.trace_items_json ? JSON.parse(d.trace_items_json) : [];
      } catch {
        // leave empty
      }
      const observationIds = traceItems
        .map((item) => item.observationId)
        .filter((id): id is number => typeof id === 'number' && id > 0);

      // Fetch obs meta
      const observations = observationIds.length > 0
        ? db.prepare(`
            SELECT id, type, title, files_read, files_modified
            FROM observations
            WHERE id IN (${observationIds.map(() => '?').join(',')})
          `).all(...observationIds) as Array<{ id: number; type: string; title: string | null; files_read: string | null; files_modified: string | null }>
        : [];

      // Fetch signals per obs
      const signals = observationIds.length > 0
        ? db.prepare(`
            SELECT observation_id, signal_kind, evidence, confidence
            FROM memory_implicit_signals
            WHERE decision_id = ?
          `).all(d.id) as Array<{ observation_id: number; signal_kind: 'file_reuse' | 'content_cited' | 'no_overlap'; evidence: string | null; confidence: number }>
        : [];

      const signalsByObs = new Map<number, { kind: string; evidence: string | null; confidence: number }>();
      for (const s of signals) {
        signalsByObs.set(s.observation_id, { kind: s.signal_kind, evidence: s.evidence, confidence: s.confidence });
      }

      const obsDetails = observations.map((o) => ({
        id: o.id,
        type: o.type,
        title: o.title,
        files_read: o.files_read ? JSON.parse(o.files_read) : [],
        files_modified: o.files_modified ? JSON.parse(o.files_modified) : [],
        signal: signalsByObs.get(o.id) ?? null,
      }));

      const anyUsed = obsDetails.some((o) => o.signal && (o.signal.kind === 'file_reuse' || o.signal.kind === 'content_cited'));
      const anyPending = obsDetails.some((o) => !o.signal);
      const verdict = anyUsed ? 'used' : anyPending ? 'pending' : 'unused';

      return {
        decisionId: d.id,
        source: d.source,
        injectedAtEpoch: d.created_at_epoch,
        observations: obsDetails,
        verdict,
      };
    });

    const used = injections.filter((i) => i.verdict === 'used').length;
    const unused = injections.filter((i) => i.verdict === 'unused').length;
    const pending = injections.filter((i) => i.verdict === 'pending').length;

    res.json({
      session: {
        contentSessionId,
        windowStart,
        windowEnd,
        windowMinutes,
      },
      injections,
      summary: {
        total: injections.length,
        used,
        unused,
        pending,
        useRate: injections.length > 0 ? Math.round((used / injections.length) * 100) : null,
      },
    });
  });
}
