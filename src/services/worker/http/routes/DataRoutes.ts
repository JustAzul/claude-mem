
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot, paths } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { getObservationsByFilePath } from '../../../sqlite/observations/get.js';
import { calculateTokenEconomics } from '../../../../services/context/TokenCalculator.js';
import type { Observation as ContextObservation } from '../../../../services/context/types.js';
import { getFirstObservationCreatedAt } from '../../../sqlite/observations/recent.js';
import { getUptimeSeconds } from '../../../../shared/uptime.js';

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

const integerArrayLike = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => Number(part.trim()));
  }
  return value;
}, z.array(z.number().int()));

const stringArrayLike = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.string()));

const observationsBatchSchema = z.object({
  ids: integerArrayLike,
  orderBy: z.enum(['date_desc', 'date_asc']).optional(),
  limit: z.number().int().positive().optional(),
  project: z.string().optional(),
}).passthrough();

const sdkSessionsBatchSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const body = value as Record<string, unknown>;
  if (body.memorySessionIds === undefined && body.sdkSessionIds !== undefined) {
    return { ...body, memorySessionIds: body.sdkSessionIds };
  }

  return value;
}, z.object({
  memorySessionIds: stringArrayLike,
}).passthrough());

const setProcessingSchema = z.object({}).passthrough();

const importSchema = z.object({
  sessions: z.array(z.unknown()).optional(),
  summaries: z.array(z.unknown()).optional(),
  observations: z.array(z.unknown()).optional(),
  prompts: z.array(z.unknown()).optional(),
}).passthrough();

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
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.get('/api/observations/:id/origin', this.handleGetObservationOrigin.bind(this));
    app.get('/api/observations/:id/trace', this.handleGetObservationTrace.bind(this));
    app.get('/api/observations/by-file', this.handleGetObservationsByFile.bind(this));
    app.post('/api/observations/batch', validateBody(observationsBatchSchema), this.handleGetObservationsByIds.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', validateBody(sdkSessionsBatchSchema), this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));

    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));

    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));
    app.post('/api/processing', validateBody(setProcessingSchema), this.handleSetProcessing.bind(this));

    app.post('/api/import', validateBody(importSchema), this.handleImport.bind(this));
  }

  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, withinDays } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project, platformSource, withinDays);
    res.json(result);
  });

  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, withinDays } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project, platformSource, withinDays);
    res.json(result);
  });

  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, withinDays } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project, platformSource, withinDays);
    res.json(result);
  });

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
    const id = Number.parseInt(String(req.params['id']), 10);
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

  private handleGetObservationsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const { ids, orderBy, limit, project } = req.body as z.infer<typeof observationsBatchSchema>;

    if (ids.length === 0) {
      res.json([]);
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

  private handleGetSdkSessionsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const { memorySessionIds } = req.body as z.infer<typeof sdkSessionsBatchSchema>;

    const store = this.dbManager.getSessionStore();
    const sessions = store.getSdkSessionsBySessionIds(memorySessionIds);
    res.json(sessions);
  });

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

  private handleGetStats = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getSessionStore().db;

    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

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
    // TokenObservation is a DB projection with exactly the fields calculateTokenEconomics uses;
    // the cast is safe at runtime even though the type is narrower than ContextObservation.
    const tokenEconomics = calculateTokenEconomics(tokenObservationRows as unknown as ContextObservation[]);
    const firstObservationAt = getFirstObservationCreatedAt(db);

    const dbPath = paths.database();
    let dbSize = 0;
    if (existsSync(dbPath)) {
      dbSize = statSync(dbPath).size;
    }

    const uptime = getUptimeSeconds(this.startTime);
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
        summaries: totalSummaries.count,
        firstObservationAt
      },
      tokenEconomics
    });
  });

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

  private handleGetProcessingStatus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const isProcessing = await this.sessionManager.isAnySessionProcessing();
    const queueDepth = await this.sessionManager.getTotalActiveWork(); 
    res.json({ isProcessing, queueDepth });
  });

  private handleSetProcessing = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const isProcessing = await this.sessionManager.isAnySessionProcessing();
    const queueDepth = await this.sessionManager.getTotalQueueDepth();
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({ status: 'ok', isProcessing, queueDepth, activeSessions });
  });

  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; platformSource?: string; withinDays: number } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); 
    const project = req.query.project as string | undefined;
    const rawPlatformSource = req.query.platformSource as string | undefined;
    const platformSource = rawPlatformSource ? normalizePlatformSource(rawPlatformSource) : undefined;
    const withinDays = Math.max(parseInt(req.query.withinDays as string, 10) || 30, 0); // 0 = all-time

    return { offset, limit, project, platformSource, withinDays };
  }

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

    const importedObservations: Array<{ id: number; obs: typeof observations[0] }> = [];
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        const result = store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
          importedObservations.push({ id: result.id, obs });
        } else {
          stats.observationsSkipped++;
        }
      }

      if (stats.observationsImported > 0) {
        store.rebuildObservationsFTSIndex();
      }

      const chromaSync = this.dbManager.getChromaSync();
      if (chromaSync && importedObservations.length > 0) {
        const CHROMA_SYNC_CONCURRENCY = 8;
        const safeParseJson = (val: string | null): string[] => {
          if (!val) return [];
          try { return JSON.parse(val); } catch { return []; }
        };

        const syncOne = async ({ id, obs }: { id: number; obs: any }) => {
          const parsedObs = {
            type: obs.type || 'discovery',
            title: obs.title || null,
            subtitle: obs.subtitle || null,
            facts: safeParseJson(obs.facts),
            narrative: obs.narrative || null,
            concepts: safeParseJson(obs.concepts),
            files_read: safeParseJson(obs.files_read),
            files_modified: safeParseJson(obs.files_modified),
            why: obs.why || null,
            alternatives_rejected: obs.alternatives_rejected || null,
            related_observation_ids: safeParseJson(obs.related_observation_ids).map(Number).filter((n: number) => !Number.isNaN(n)),
          };

          await chromaSync.syncObservation(
            id,
            obs.memory_session_id,
            obs.project,
            parsedObs,
            obs.prompt_number || 0,
            obs.created_at_epoch,
            obs.discovery_tokens || 0
          ).catch(err => {
            logger.error('CHROMA', 'Import ChromaDB sync failed', { id }, err as Error);
          });
        };

        (async () => {
          for (let i = 0; i < importedObservations.length; i += CHROMA_SYNC_CONCURRENCY) {
            const batch = importedObservations.slice(i, i + CHROMA_SYNC_CONCURRENCY);
            await Promise.all(batch.map(syncOne));
          }
        })().catch(err => {
          logger.error('CHROMA', 'Import ChromaDB batch sync failed', {}, err as Error);
        });
      }
    }

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

}
