import express, { Request, Response } from 'express';
import type {
  MemoryAssistFeedbackLabel,
  MemoryAssistOutcomeSignal,
  MemoryAssistReport,
} from '../../../../shared/memory-assist.js';
import { logger } from '../../../../utils/logger.js';
import { MemoryAssistTracker } from '../../MemoryAssistTracker.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class MemoryAssistRoutes extends BaseRouteHandler {
  constructor(
    private readonly tracker: MemoryAssistTracker,
    private readonly dbManager: DatabaseManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/memory-assist', this.handleGetRecent.bind(this));
    app.get('/api/memory-assist/stats', this.handleGetStats.bind(this));
    app.get('/api/memory-assist/dashboard', this.handleGetStats.bind(this));
    app.get('/api/memory-assist/decisions', this.handleGetDecisions.bind(this));
    app.get('/api/memory-assist/calibration', this.handleGetCalibration.bind(this));
    app.post('/api/memory-assist/report', this.handleReport.bind(this));
    app.post('/api/memory-assist/outcome', this.handleOutcome.bind(this));
    app.post('/api/memory-assist/feedback', this.handleFeedback.bind(this));
  }

  private handleGetRecent = this.wrapHandler((req: Request, res: Response): void => {
    const parsedLimit = parseInt(String(req.query.limit ?? '10'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 10;
    res.json({ events: this.tracker.getRecent(limit) });
  });

  private handleReport = this.wrapHandler((req: Request, res: Response): void => {
    const report = req.body as MemoryAssistReport | undefined;
    if (!report?.source || !report?.status || !report?.reason) {
      this.badRequest(res, 'source, status, and reason are required');
      return;
    }

    const event = this.dbManager.getSessionStore().recordMemoryAssistDecision(report);
    this.tracker.record(event);
    logger.debug(`[MemoryAssistRoutes] recorded memory assist decision ${event.id ?? 'unknown'} (${event.source}/${event.status})`);
    res.json({ ok: true, event });
  });

  private handleGetStats = this.wrapHandler((req: Request, res: Response): void => {
    const parsedWindowDays = parseInt(String(req.query.days ?? '30'), 10);
    const windowDays = Number.isFinite(parsedWindowDays)
      ? Math.min(Math.max(parsedWindowDays, 1), 365)
      : 30;
    logger.debug(`[MemoryAssistRoutes] loading dashboard stats for ${windowDays}d window`);
    res.json(this.dbManager.getSessionStore().getMemoryAssistDashboard(windowDays));
  });

  private handleGetDecisions = this.wrapHandler((req: Request, res: Response): void => {
    const parsedLimit = parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 20;
    const parsedWindowDays = parseInt(String(req.query.days ?? '30'), 10);
    const windowDays = Number.isFinite(parsedWindowDays)
      ? Math.min(Math.max(parsedWindowDays, 1), 365)
      : 30;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    const contentSessionId = typeof req.query.contentSessionId === 'string'
      ? req.query.contentSessionId
      : undefined;

    const decisions = this.dbManager.getSessionStore().getRecentMemoryAssistDecisions({
      limit,
      windowDays,
      source: source as any,
      project,
      contentSessionId,
    });

    logger.debug(`[MemoryAssistRoutes] returning ${decisions.length} decisions (limit=${limit}, windowDays=${windowDays})`);
    res.json({ decisions });
  });

  private handleGetCalibration = this.wrapHandler((req: Request, res: Response): void => {
    logger.debug('[MemoryAssistRoutes] loading memory assist calibration snapshot');
    res.json(this.dbManager.getSessionStore().getMemoryAssistCalibrationSnapshot());
  });

  private handleOutcome = this.wrapHandler((req: Request, res: Response): void => {
    const signal = req.body as MemoryAssistOutcomeSignal | undefined;
    if (!signal?.signalType || !signal.toolName || !signal.action) {
      this.badRequest(res, 'signalType, toolName, and action are required');
      return;
    }

    const storedSignal = this.dbManager.getSessionStore().recordMemoryAssistOutcomeSignal(signal);
    logger.debug(`[MemoryAssistRoutes] recorded outcome signal ${storedSignal.id ?? 'unknown'} for ${storedSignal.source ?? 'unknown source'}`);
    res.json({ ok: true, signal: storedSignal });
  });

  private handleFeedback = this.wrapHandler((req: Request, res: Response): void => {
    const {
      observationIds,
      label,
      sessionDbId,
      decisionId,
      metadata,
    } = req.body as {
      observationIds?: number[];
      label?: MemoryAssistFeedbackLabel;
      sessionDbId?: number;
      decisionId?: number;
      metadata?: Record<string, unknown>;
    };

    if (!Array.isArray(observationIds) || observationIds.length === 0) {
      this.badRequest(res, 'observationIds must be a non-empty array');
      return;
    }
    if (!observationIds.every((value) => Number.isInteger(value))) {
      this.badRequest(res, 'observationIds must contain only integers');
      return;
    }
    if (label !== 'helpful' && label !== 'not_helpful') {
      this.badRequest(res, 'label must be "helpful" or "not_helpful"');
      return;
    }

    const signalType = label === 'helpful'
      ? 'memory_assist_helpful'
      : 'memory_assist_not_helpful';
    this.dbManager.getSessionStore().recordObservationFeedback(
      observationIds,
      signalType,
      sessionDbId,
      metadata
    );
    if (Number.isInteger(decisionId)) {
      this.dbManager.getSessionStore().attachMemoryAssistDecisionFeedback(decisionId, label);
    }

    logger.debug(`[MemoryAssistRoutes] recorded ${label} feedback for ${observationIds.length} observations`);
    res.json({ ok: true });
  });
}
