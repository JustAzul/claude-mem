
import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, existsSync, statSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot } from '../../../../shared/paths.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { MemoryAssistTracker } from '../../MemoryAssistTracker.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

const VIEWER_HTML_CANDIDATE_PATHS: readonly string[] = (() => {
  const packageRoot = getPackageRoot();
  return [
    path.join(packageRoot, 'ui', 'viewer.html'),
    path.join(packageRoot, 'plugin', 'ui', 'viewer.html'),
  ];
})();

const resolvedViewerHtmlPath: string | null =
  VIEWER_HTML_CANDIDATE_PATHS.find((candidate) => existsSync(candidate)) ?? null;

const viewerHtmlBytes: Buffer | null = resolvedViewerHtmlPath
  ? readFileSync(resolvedViewerHtmlPath)
  : null;

if (resolvedViewerHtmlPath) {
  logger.info('SYSTEM', 'Cached viewer.html at boot', {
    path: resolvedViewerHtmlPath,
    bytes: viewerHtmlBytes!.byteLength,
  });
} else {
  logger.warn('SYSTEM', 'viewer.html not found at any expected location at boot', {
    candidates: VIEWER_HTML_CANDIDATE_PATHS,
  });
}

export class ViewerRoutes extends BaseRouteHandler {
  constructor(
    private sseBroadcaster: SSEBroadcaster,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
    private memoryAssistTracker: MemoryAssistTracker
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    const packageRoot = getPackageRoot();
    app.use(express.static(path.join(packageRoot, 'ui')));

    app.get('/health', this.handleHealth.bind(this));
    app.get('/', this.handleViewerUI.bind(this));
    app.get('/stream', this.handleSSEStream.bind(this));
  }

  private handleHealth = this.wrapHandler((req: Request, res: Response): void => {
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({
      status: 'ok',
      timestamp: Date.now(),
      activeSessions
    });
  });

  private handleViewerUI = this.wrapHandler((req: Request, res: Response): void => {
    if (!viewerHtmlBytes) {
      throw new Error('Viewer UI not found at any expected location');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewerHtmlBytes);
  });

  private handleSSEStream = this.wrapHandler((req: Request, res: Response): void => {
    try {
      this.dbManager.getSessionStore();
    } catch (initError: unknown) {
      if (initError instanceof Error) {
        logger.warn('HTTP', 'SSE stream requested before DB initialization', {}, initError);
      }
      res.status(503).json({ error: 'Service initializing' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    this.sseBroadcaster.addClient(res);

    const projectCatalog = this.dbManager.getSessionStore().getProjectCatalog();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: projectCatalog.projects,
      sources: projectCatalog.sources,
      projectsBySource: projectCatalog.projectsBySource,
      memoryAssistEvents: this.memoryAssistTracker.getRecent(50),
      timestamp: Date.now()
    });

    void (async () => {
      try {
        const isProcessing = await this.sessionManager.isAnySessionProcessing();
        const queueDepth = await this.sessionManager.getTotalActiveWork();
        this.sseBroadcaster.broadcast({
          type: 'processing_status',
          isProcessing,
          queueDepth
        });
      } catch (error) {
        logger.warn('HTTP', 'Failed to broadcast initial processing status', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  private getViewerBundleVersionToken(packageRoot: string, bundlePath: string): string {
    let packageVersion = 'dev';
    try {
      const packageJsonPath = path.join(packageRoot, 'package.json');
      if (existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
        packageVersion = packageJson.version || packageVersion;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('HTTP', `[ViewerRoutes] failed to read package version for cache-busting: ${message}`);
    }

    let bundleMtime = '0';
    try {
      if (existsSync(bundlePath)) {
        bundleMtime = String(Math.trunc(statSync(bundlePath).mtimeMs));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('HTTP', `[ViewerRoutes] failed to read viewer bundle mtime for cache-busting: ${message}`);
    }

    const processStart = typeof process.uptime === 'function'
      ? String(Date.now() - Math.trunc(process.uptime() * 1000))
      : String(Date.now());

    return `${packageVersion}-${bundleMtime}-${processStart}`;
  }
}
