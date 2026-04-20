/**
 * Viewer Routes
 *
 * Handles health check, viewer UI, and SSE stream endpoints.
 * These are used by the web viewer UI at http://localhost:37777
 */

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
    // Serve static UI assets (JS, CSS, fonts, etc.)
    const packageRoot = getPackageRoot();
    app.use(express.static(path.join(packageRoot, 'ui')));

    app.get('/health', this.handleHealth.bind(this));
    app.get('/', this.handleViewerUI.bind(this));
    app.get('/stream', this.handleSSEStream.bind(this));
  }

  /**
   * Health check endpoint
   */
  private handleHealth = this.wrapHandler((req: Request, res: Response): void => {
    // Include queue liveness info so monitoring can detect dead queues (#1867)
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({
      status: 'ok',
      timestamp: Date.now(),
      activeSessions
    });
  });

  /**
   * Serve viewer UI
   */
  private handleViewerUI = this.wrapHandler((req: Request, res: Response): void => {
    const packageRoot = getPackageRoot();

    // Try cache structure first (ui/viewer.html), then marketplace structure (plugin/ui/viewer.html)
    const viewerPaths = [
      path.join(packageRoot, 'ui', 'viewer.html'),
      path.join(packageRoot, 'plugin', 'ui', 'viewer.html')
    ];

    const viewerPath = viewerPaths.find(p => existsSync(p));

    if (!viewerPath) {
      throw new Error('Viewer UI not found at any expected location');
    }

    const html = readFileSync(viewerPath, 'utf-8');
    const bundlePath = path.join(path.dirname(viewerPath), 'viewer-bundle.js');
    const versionToken = this.getViewerBundleVersionToken(packageRoot, bundlePath);
    const hydratedHtml = html.replace(
      'viewer-bundle.js',
      `viewer-bundle.js?v=${encodeURIComponent(versionToken)}`
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    res.send(hydratedHtml);
  });

  /**
   * SSE stream endpoint
   */
  private handleSSEStream = this.wrapHandler((req: Request, res: Response): void => {
    // Guard: if DB is not yet initialized, return 503 before registering client
    try {
      this.dbManager.getSessionStore();
    } catch (initError: unknown) {
      if (initError instanceof Error) {
        logger.warn('HTTP', 'SSE stream requested before DB initialization', {}, initError);
      }
      res.status(503).json({ error: 'Service initializing' });
      return;
    }

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcaster
    this.sseBroadcaster.addClient(res);

    // Send initial_load event with project/source catalog
    const projectCatalog = this.dbManager.getSessionStore().getProjectCatalog();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: projectCatalog.projects,
      sources: projectCatalog.sources,
      projectsBySource: projectCatalog.projectsBySource,
      memoryAssistEvents: this.memoryAssistTracker.getRecent(50),
      timestamp: Date.now()
    });

    // Send initial processing status (based on queue depth + active generators)
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing,
      queueDepth
    });
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
      logger.warn(`[ViewerRoutes] failed to read package version for cache-busting: ${message}`);
    }

    let bundleMtime = '0';
    try {
      if (existsSync(bundlePath)) {
        bundleMtime = String(Math.trunc(statSync(bundlePath).mtimeMs));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[ViewerRoutes] failed to read viewer bundle mtime for cache-busting: ${message}`);
    }

    const processStart = typeof process.uptime === 'function'
      ? String(Date.now() - Math.trunc(process.uptime() * 1000))
      : String(Date.now());

    return `${packageVersion}-${bundleMtime}-${processStart}`;
  }
}
