/**
 * Data Routes
 *
 * Handles data retrieval operations: observations, summaries, prompts, stats, processing status.
 * All endpoints use direct database access via service layer.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { homedir } from 'os';
import { getPackageRoot } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { getObservationsByFilePath } from '../../../sqlite/observations/get.js';
import { calculateTokenEconomics } from '../../../../services/context/TokenCalculator.js';
import type { Observation as ContextObservation } from '../../../../services/context/types.js';

// Inline secret-redaction — mirrors src/sdk/prompts.ts SECRET_PATTERNS + redactSecrets.
// TODO: consolidate into a shared utility when prompts.ts is refactored.
const _SECRET_PATTERNS: Array<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?([^\s"'&;]{6,})/gi,
];

function _redactSecrets(text: string): string {
  let out = text;
  for (const re of _SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      const eqIdx = match.search(/[:=]/);
      if (eqIdx > -1 && /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)/i.test(match.slice(0, eqIdx))) {
        return match.slice(0, eqIdx + 1) + '[REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return out;
}

type TokenObservation = Pick<ContextObservation, 'title' | 'subtitle' | 'narrative' | 'facts' | 'discovery_tokens'>;

export class DataRoutes extends BaseRouteHandler {
  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService,
    private startTime: number
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Pagination endpoints
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    // Fetch by ID endpoints
    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.get('/api/observations/:id/origin', this.handleGetObservationOrigin.bind(this));
    app.get('/api/observations/:id/trace', this.handleGetObservationTrace.bind(this));
    app.get('/api/observations/by-file', this.handleGetObservationsByFile.bind(this));
    app.post('/api/observations/batch', this.handleGetObservationsByIds.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));

    // Metadata endpoints
    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));

    // Processing status endpoints
    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));
    app.post('/api/processing', this.handleSetProcessing.bind(this));

    // Pending queue management endpoints
    app.get('/api/pending-queue', this.handleGetPendingQueue.bind(this));
    app.post('/api/pending-queue/process', this.handleProcessPendingQueue.bind(this));
    app.delete('/api/pending-queue/failed', this.handleClearFailedQueue.bind(this));
    app.delete('/api/pending-queue/all', this.handleClearAllQueue.bind(this));

    // Import endpoint
    app.post('/api/import', this.handleImport.bind(this));
  }

  /**
   * Get paginated observations
   */
  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, withinDays } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project, platformSource, withinDays);
    res.json(result);
  });

  /**
   * Get paginated summaries
   */
  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, withinDays } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project, platformSource, withinDays);
    res.json(result);
  });

  /**
   * Get paginated user prompts
   */
  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, withinDays } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project, platformSource, withinDays);
    res.json(result);
  });

  /**
   * Get observation by ID
   * GET /api/observation/:id
   */
  private handleGetObservationById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const observation = store.getObservationById(id);
    const origin = store.getObservationOrigin(id);

    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    res.json({
      ...observation,
      origin,
    });
  });

  /**
   * Get observation origin by observation ID
   * GET /api/observations/:id/origin
   */
  private handleGetObservationOrigin = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const origin = store.getObservationOrigin(id);

    if (!origin) {
      this.notFound(res, `Origin for observation #${id} not found`);
      return;
    }

    res.json(origin);
  });

  /**
   * Get full trace for an observation — joins all context for the debug view.
   * GET /api/observations/:id/trace
   */
  private handleGetObservationTrace = this.wrapHandler((req: Request, res: Response): void => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      this.badRequest(res, 'id must be a positive integer');
      return;
    }
    const db = this.dbManager.getSessionStore().db;

    // Section 1: core observation
    const observation = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    if (!observation) {
      res.status(404).json({ error: `observation ${id} not found` });
      return;
    }

    // Section 2: source tool call (via observation_tool_origins → pending_messages)
    let source = null;
    const origin = db.prepare('SELECT * FROM observation_tool_origins WHERE observation_id = ? ORDER BY created_at_epoch DESC LIMIT 1').get(id);
    if (origin) {
      const pendingMsg = db.prepare('SELECT * FROM pending_messages WHERE id = ?').get((origin as any).pending_message_id);
      source = { origin, pendingMessage: pendingMsg ?? null };
    }

    // Section 3: turn context — resolve content_session_id via sdk_sessions
    let turn = null;
    const obsAny = observation as any;
    if (obsAny.memory_session_id && obsAny.prompt_number != null) {
      const sdkSession = db.prepare('SELECT id, content_session_id FROM sdk_sessions WHERE memory_session_id = ? ORDER BY id DESC LIMIT 1').get(obsAny.memory_session_id) as any;
      const contentSessionId = sdkSession?.content_session_id ?? null;
      let userPrompt = null;
      if (contentSessionId) {
        userPrompt = db.prepare('SELECT prompt_text, created_at_epoch FROM user_prompts WHERE content_session_id = ? AND prompt_number = ? LIMIT 1').get(contentSessionId, obsAny.prompt_number);
      }
      // Siblings: other obs with same memory_session_id + prompt_number
      const siblings = db.prepare('SELECT id, type, title, created_at_epoch FROM observations WHERE memory_session_id = ? AND prompt_number = ? AND id != ? ORDER BY created_at_epoch ASC').all(obsAny.memory_session_id, obsAny.prompt_number, id);

      // priorAssistantMessage — from capture snapshot (V30), truncated to 500 chars end-preserved
      const store = this.dbManager.getSessionStore();
      const snapshotCtx = store.getObservationRetrievalContext([id]);
      let priorAssistantMessage: string | null = null;
      const snap = snapshotCtx.get(id);
      if (snap?.prior_assistant_message) {
        const raw = _redactSecrets(snap.prior_assistant_message);
        priorAssistantMessage = raw.length > 500 ? raw.slice(raw.length - 500) : raw;
      }

      turn = { contentSessionId, userPrompt: userPrompt ?? null, priorAssistantMessage, siblings };
    }

    // Section 4: memory-assist refs
    // a) decisions where this obs was injected (trace_items_json mentions the ID)
    const injectedIn = db.prepare(`
      SELECT id, source, status, system_verdict, system_confidence, file_path, prompt_number, created_at_epoch
      FROM memory_assist_decisions
      WHERE trace_items_json LIKE ?
      ORDER BY created_at_epoch DESC
      LIMIT 20
    `).all(`%"observationId":${id}%`);

    // b) outcome_signals where this obs was generated by a tool action
    const generatedBy = db.prepare(`
      SELECT id, decision_id, signal_type, action, tool_name, file_path, created_at_epoch
      FROM memory_assist_outcome_signals
      WHERE EXISTS (
        SELECT 1 FROM json_each(generated_observation_ids_json)
        WHERE CAST(json_each.value AS INTEGER) = ?
      )
      ORDER BY created_at_epoch DESC
      LIMIT 20
    `).all(id);

    const memoryAssist = { injectedIn, generatedBy };

    res.json({ observation, source, turn, memoryAssist });
  });

  /**
   * Get observations associated with a file path, scoped to projects
   * GET /api/observations/by-file?path=<file_path>&projects=<comma,separated>&limit=15
   */
  private handleGetObservationsByFile = this.wrapHandler((req: Request, res: Response): void => {
    const filePath = req.query.path as string | undefined;
    if (!filePath) {
      this.badRequest(res, 'path query parameter is required');
      return;
    }

    const projectsParam = req.query.projects as string | undefined;
    const projects = projectsParam ? projectsParam.split(',').filter(Boolean) : undefined;
    const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const limit = Number.isFinite(parsedLimit) && parsedLimit! > 0 ? parsedLimit : undefined;

    const db = this.dbManager.getSessionStore().db;
    const observations = getObservationsByFilePath(db, filePath, { projects, limit });

    res.json({ observations, count: observations.length });
  });

  /**
   * Get observations by array of IDs
   * POST /api/observations/batch
   * Body: { ids: number[], orderBy?: 'date_desc' | 'date_asc', limit?: number, project?: string }
   */
  private handleGetObservationsByIds = this.wrapHandler((req: Request, res: Response): void => {
    let { ids, orderBy, limit, project } = req.body;

    // Coerce string-encoded arrays from MCP clients (e.g. "[1,2,3]" or "1,2,3")
    if (typeof ids === 'string') {
      try { ids = JSON.parse(ids); } catch { ids = ids.split(',').map(Number); }
    }

    if (!ids || !Array.isArray(ids)) {
      this.badRequest(res, 'ids must be an array of numbers');
      return;
    }

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    // Validate all IDs are numbers
    if (!ids.every(id => typeof id === 'number' && Number.isInteger(id))) {
      this.badRequest(res, 'All ids must be integers');
      return;
    }

    const store = this.dbManager.getSessionStore();
    const observations = store.getObservationsByIds(ids, { orderBy, limit, project });

    if (observations.length === 0) {
      res.json(observations);
      return;
    }

    // Enrich each observation with retrieval-time context from capture snapshots (V30)
    const obsIds = observations.map((o: any) => o.id as number);
    const ctxMap = store.getObservationRetrievalContext(obsIds);
    const db = store.db;

    const enriched = observations.map((obs: any) => {
      const ctx = ctxMap.get(obs.id) ?? null;
      if (!ctx) {
        return { ...obs, retrieved_with_context: null };
      }

      const rawUserPrompt = ctx.user_prompt ?? null;
      const rawPrior = ctx.prior_assistant_message ?? null;

      const user_prompt = rawUserPrompt
        ? (() => { const r = _redactSecrets(rawUserPrompt); return r.length > 200 ? r.slice(0, 200) : r; })()
        : null;

      const prior_assistant_snippet = rawPrior
        ? (() => { const r = _redactSecrets(rawPrior); return r.length > 150 ? r.slice(r.length - 150) : r; })()
        : null;

      // Sibling titles: same content_session_id + prompt_number, excluding self, max 5
      let sibling_obs_titles: string[] = [];
      if (ctx.content_session_id != null && ctx.prompt_number != null) {
        const sibRows = db.prepare(`
          SELECT o.title FROM observations o
          JOIN observation_capture_snapshots s ON s.observation_id = o.id
          WHERE s.content_session_id = ? AND s.prompt_number = ? AND o.id != ?
          ORDER BY s.created_at_epoch ASC
          LIMIT 5
        `).all(ctx.content_session_id, ctx.prompt_number, obs.id) as Array<{ title: string | null }>;
        sibling_obs_titles = sibRows.map(r => r.title ?? '').filter(Boolean);
      }

      return {
        ...obs,
        retrieved_with_context: { user_prompt, prior_assistant_snippet, sibling_obs_titles },
      };
    });

    res.json(enriched);
  });

  /**
   * Get session by ID
   * GET /api/session/:id
   */
  private handleGetSessionById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const sessions = store.getSessionSummariesByIds([id]);

    if (sessions.length === 0) {
      this.notFound(res, `Session #${id} not found`);
      return;
    }

    res.json(sessions[0]);
  });

  /**
   * Get SDK sessions by SDK session IDs
   * POST /api/sdk-sessions/batch
   * Body: { memorySessionIds: string[] }
   */
  private handleGetSdkSessionsByIds = this.wrapHandler((req: Request, res: Response): void => {
    let { memorySessionIds } = req.body;

    // Coerce string-encoded arrays from MCP clients (e.g. '["a","b"]' or "a,b")
    if (typeof memorySessionIds === 'string') {
      try { memorySessionIds = JSON.parse(memorySessionIds); } catch { memorySessionIds = memorySessionIds.split(',').map((s: string) => s.trim()); }
    }

    if (!Array.isArray(memorySessionIds)) {
      this.badRequest(res, 'memorySessionIds must be an array');
      return;
    }

    const store = this.dbManager.getSessionStore();
    const sessions = store.getSdkSessionsBySessionIds(memorySessionIds);
    res.json(sessions);
  });

  /**
   * Get user prompt by ID
   * GET /api/prompt/:id
   */
  private handleGetPromptById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const prompts = store.getUserPromptsByIds([id]);

    if (prompts.length === 0) {
      this.notFound(res, `Prompt #${id} not found`);
      return;
    }

    res.json(prompts[0]);
  });

  /**
   * Get database statistics (with worker metadata)
   */
  private handleGetStats = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getSessionStore().db;

    // Read version from package.json
    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    // Get database stats
    const totalObservations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
    const totalSummaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };
    const tokenObservationRows = db.prepare(`
      SELECT
        title,
        subtitle,
        narrative,
        facts,
        discovery_tokens
      FROM observations
    `).all() as TokenObservation[];
    const tokenEconomics = calculateTokenEconomics(tokenObservationRows);

    // Get database file size and path
    const dbPath = path.join(homedir(), '.claude-mem', 'claude-mem.db');
    let dbSize = 0;
    if (existsSync(dbPath)) {
      dbSize = statSync(dbPath).size;
    }

    // Worker metadata
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const activeSessions = this.sessionManager.getActiveSessionCount();
    const sseClients = this.sseBroadcaster.getClientCount();

    res.json({
      worker: {
        version,
        uptime,
        activeSessions,
        sseClients,
        port: getWorkerPort()
      },
      database: {
        path: dbPath,
        size: dbSize,
        observations: totalObservations.count,
        sessions: totalSessions.count,
        summaries: totalSummaries.count
      },
      tokenEconomics
    });
  });

  /**
   * Get list of distinct projects from observations
   * GET /api/projects
   */
  private handleGetProjects = this.wrapHandler((req: Request, res: Response): void => {
    const store = this.dbManager.getSessionStore();
    const rawPlatformSource = req.query.platformSource as string | undefined;
    const platformSource = rawPlatformSource ? normalizePlatformSource(rawPlatformSource) : undefined;

    if (platformSource) {
      const projects = store.getAllProjects(platformSource);
      res.json({
        projects,
        sources: [platformSource],
        projectsBySource: { [platformSource]: projects }
      });
      return;
    }

    res.json(store.getProjectCatalog());
  });

  /**
   * Get current processing status
   * GET /api/processing-status
   */
  private handleGetProcessingStatus = this.wrapHandler((req: Request, res: Response): void => {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    res.json({ isProcessing, queueDepth });
  });

  /**
   * Set processing status (called by hooks)
   * NOTE: This now broadcasts computed status based on active processing (ignores input)
   */
  private handleSetProcessing = this.wrapHandler((req: Request, res: Response): void => {
    // Broadcast current computed status (ignores manual input)
    this.workerService.broadcastProcessingStatus();

    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalQueueDepth();
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({ status: 'ok', isProcessing, queueDepth, activeSessions });
  });

  /**
   * Parse pagination parameters from request query
   */
  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; platformSource?: string; withinDays: number } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); // Max 100
    const project = req.query.project as string | undefined;
    const rawPlatformSource = req.query.platformSource as string | undefined;
    const platformSource = rawPlatformSource ? normalizePlatformSource(rawPlatformSource) : undefined;
    const withinDays = Math.max(parseInt(req.query.withinDays as string, 10) || 30, 0); // 0 = all-time

    return { offset, limit, project, platformSource, withinDays };
  }

  /**
   * Import memories from export file
   * POST /api/import
   * Body: { sessions: [], summaries: [], observations: [], prompts: [] }
   */
  private handleImport = this.wrapHandler((req: Request, res: Response): void => {
    const { sessions, summaries, observations, prompts } = req.body;

    const stats = {
      sessionsImported: 0,
      sessionsSkipped: 0,
      summariesImported: 0,
      summariesSkipped: 0,
      observationsImported: 0,
      observationsSkipped: 0,
      promptsImported: 0,
      promptsSkipped: 0
    };

    const store = this.dbManager.getSessionStore();

    // Import sessions first (dependency for everything else)
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        const result = store.importSdkSession(session);
        if (result.imported) {
          stats.sessionsImported++;
        } else {
          stats.sessionsSkipped++;
        }
      }
    }

    // Import summaries (depends on sessions)
    if (Array.isArray(summaries)) {
      for (const summary of summaries) {
        const result = store.importSessionSummary(summary);
        if (result.imported) {
          stats.summariesImported++;
        } else {
          stats.summariesSkipped++;
        }
      }
    }

    // Import observations (depends on sessions)
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        const result = store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
        } else {
          stats.observationsSkipped++;
        }
      }

      // Rebuild FTS index so imported observations are immediately searchable.
      // The FTS5 content table relies on triggers for incremental updates, but
      // those triggers may not have fired correctly for all import paths.
      if (stats.observationsImported > 0) {
        store.rebuildObservationsFTSIndex();
      }
    }

    // Import prompts (depends on sessions)
    if (Array.isArray(prompts)) {
      for (const prompt of prompts) {
        const result = store.importUserPrompt(prompt);
        if (result.imported) {
          stats.promptsImported++;
        } else {
          stats.promptsSkipped++;
        }
      }
    }

    res.json({
      success: true,
      stats
    });
  });

  /**
   * Get pending queue contents
   * GET /api/pending-queue
   * Returns all pending, processing, and failed messages with optional recently processed
   */
  private handleGetPendingQueue = this.wrapHandler((req: Request, res: Response): void => {
    const { PendingMessageStore } = require('../../../sqlite/PendingMessageStore.js');
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);

    // Get queue contents (pending, processing, failed)
    const queueMessages = pendingStore.getQueueMessages();

    // Get recently processed (last 30 min, up to 20)
    const recentlyProcessed = pendingStore.getRecentlyProcessed(20, 30);

    // Get stuck message count (processing > 5 min)
    const stuckCount = pendingStore.getStuckCount(5 * 60 * 1000);

    // Get sessions with pending work
    const sessionsWithPending = pendingStore.getSessionsWithPendingMessages();

    res.json({
      queue: {
        messages: queueMessages,
        totalPending: queueMessages.filter((m: { status: string }) => m.status === 'pending').length,
        totalProcessing: queueMessages.filter((m: { status: string }) => m.status === 'processing').length,
        totalFailed: queueMessages.filter((m: { status: string }) => m.status === 'failed').length,
        stuckCount
      },
      recentlyProcessed,
      sessionsWithPendingWork: sessionsWithPending
    });
  });

  /**
   * Process pending queue
   * POST /api/pending-queue/process
   * Body: { sessionLimit?: number } - defaults to 10
   * Starts SDK agents for sessions with pending messages
   */
  private handleProcessPendingQueue = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionLimit = Math.min(
      Math.max(parseInt(req.body.sessionLimit, 10) || 10, 1),
      100 // Max 100 sessions at once
    );

    const result = await this.workerService.processPendingQueues(sessionLimit);

    res.json({
      success: true,
      ...result
    });
  });

  /**
   * Clear all failed messages from the queue
   * DELETE /api/pending-queue/failed
   * Returns the number of messages cleared
   */
  private handleClearFailedQueue = this.wrapHandler((req: Request, res: Response): void => {
    const { PendingMessageStore } = require('../../../sqlite/PendingMessageStore.js');
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);

    const clearedCount = pendingStore.clearFailed();

    logger.info('QUEUE', 'Cleared failed queue messages', { clearedCount });

    res.json({
      success: true,
      clearedCount
    });
  });

  /**
   * Clear all messages from the queue (pending, processing, and failed)
   * DELETE /api/pending-queue/all
   * Returns the number of messages cleared
   */
  private handleClearAllQueue = this.wrapHandler((req: Request, res: Response): void => {
    const { PendingMessageStore } = require('../../../sqlite/PendingMessageStore.js');
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);

    const clearedCount = pendingStore.clearAll();

    logger.warn('QUEUE', 'Cleared ALL queue messages (pending, processing, failed)', { clearedCount });

    res.json({
      success: true,
      clearedCount
    });
  });

}
