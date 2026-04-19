/**
 * MCP Usage Routes
 *
 * Exposes aggregate and recent invocation data from the mcp_invocations table.
 */

import express, { Request, Response } from 'express';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

interface ByToolRow {
  tool_name: string;
  count: number;
  avg_duration_ms: number;
  error_count: number;
  last_invoked_at: number;
  p95_duration_ms?: number;
}

interface HourlyBucketRow {
  hour_epoch: number;
  count: number;
}

interface DurationRow {
  tool_name: string;
  duration_ms: number;
}

interface InvocationRow {
  id: number;
  tool_name: string;
  args_summary: string | null;
  result_status: string;
  error_message: string | null;
  duration_ms: number;
  invoked_at_epoch: number;
}

export class McpUsageRoutes extends BaseRouteHandler {
  constructor(private readonly dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/mcp/usage', this.handleUsage.bind(this));
    app.get('/api/mcp/usage/recent', this.handleRecent.bind(this));
  }

  private handleUsage = this.wrapHandler((req: Request, res: Response): void => {
    const defaultSince = Date.now() - 30 * 24 * 3600 * 1000;
    const parsedSince = parseInt(String(req.query.since ?? ''), 10);
    const since = Number.isFinite(parsedSince) ? parsedSince : defaultSince;
    const until = Date.now();

    const db = this.dbManager.getSessionStore().db;

    // Per-tool aggregates
    const byToolRows = db.prepare(`
      SELECT tool_name,
             COUNT(*) AS count,
             AVG(duration_ms) AS avg_duration_ms,
             SUM(CASE WHEN result_status='error' THEN 1 ELSE 0 END) AS error_count,
             MAX(invoked_at_epoch) AS last_invoked_at
      FROM mcp_invocations
      WHERE invoked_at_epoch >= ?
      GROUP BY tool_name
      ORDER BY count DESC
    `).all(since) as ByToolRow[];

    // Fetch all durations to compute p95 per tool in JS
    const durationRows = db.prepare(`
      SELECT tool_name, duration_ms
      FROM mcp_invocations
      WHERE invoked_at_epoch >= ?
      ORDER BY tool_name, duration_ms ASC
    `).all(since) as DurationRow[];

    // Build p95 map
    const durationsByTool: Record<string, number[]> = {};
    for (const row of durationRows) {
      if (!durationsByTool[row.tool_name]) durationsByTool[row.tool_name] = [];
      durationsByTool[row.tool_name].push(row.duration_ms);
    }
    const p95Map: Record<string, number> = {};
    for (const [tool, durations] of Object.entries(durationsByTool)) {
      const sorted = durations; // already sorted by query
      const idx = Math.floor(sorted.length * 0.95);
      p95Map[tool] = sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
    }

    const byTool = byToolRows.map(row => ({
      tool_name: row.tool_name,
      count: row.count,
      avg_duration_ms: Math.round(row.avg_duration_ms),
      p95_duration_ms: p95Map[row.tool_name] ?? 0,
      error_count: row.error_count,
      last_invoked_at: row.last_invoked_at,
    }));

    // Hourly buckets
    const hourlyBuckets = db.prepare(`
      SELECT (invoked_at_epoch / 3600000) * 3600000 AS hour_epoch,
             COUNT(*) AS count
      FROM mcp_invocations
      WHERE invoked_at_epoch >= ?
      GROUP BY hour_epoch
      ORDER BY hour_epoch ASC
    `).all(since) as HourlyBucketRow[];

    res.json({
      window: { since, until },
      byTool,
      hourlyBuckets,
    });
  });

  private handleRecent = this.wrapHandler((req: Request, res: Response): void => {
    const parsedLimit = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;

    const db = this.dbManager.getSessionStore().db;

    const rows = db.prepare(`
      SELECT id, tool_name, args_summary, result_status, error_message, duration_ms, invoked_at_epoch
      FROM mcp_invocations
      ORDER BY invoked_at_epoch DESC
      LIMIT ?
    `).all(limit) as InvocationRow[];

    const invocations = rows.map(row => ({
      id: row.id,
      tool_name: row.tool_name,
      args_summary: row.args_summary ? (() => { try { return JSON.parse(row.args_summary!); } catch { return row.args_summary; } })() : null,
      result_status: row.result_status,
      error_message: row.error_message,
      duration_ms: row.duration_ms,
      invoked_at_epoch: row.invoked_at_epoch,
    }));

    res.json({ invocations });
  });
}
