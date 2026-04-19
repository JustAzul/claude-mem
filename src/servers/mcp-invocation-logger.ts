import type { Database } from 'bun:sqlite';

export interface McpInvocationLog {
  toolName: string;
  argsSummary: Record<string, unknown> | null;
  resultStatus: 'ok' | 'error';
  errorMessage?: string | null;
  durationMs: number;
}

/**
 * Fire-and-forget. Never throws — a logger crash must never break a tool call.
 * All errors are swallowed and logged at debug level.
 */
export function logMcpInvocation(db: Database, log: McpInvocationLog): void {
  try {
    const stmt = db.prepare(`
      INSERT INTO mcp_invocations (tool_name, args_summary, result_status, error_message, duration_ms, invoked_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.toolName,
      log.argsSummary ? JSON.stringify(log.argsSummary) : null,
      log.resultStatus,
      log.errorMessage ?? null,
      log.durationMs,
      Date.now()
    );
  } catch {
    // Silent — never break tool flow on logging failure
  }
}

/**
 * Build a per-tool args summary. Strips sensitive/huge fields, keeps structural metrics.
 */
export function buildArgsSummary(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  switch (toolName) {
    case 'search':
      return {
        query_length: typeof args.query === 'string' ? args.query.length : 0,
        has_project: !!args.project,
        has_type: !!args.type,
        has_obs_type: !!args.obs_type,
        has_date_range: !!(args.dateStart || args.dateEnd),
        limit: args.limit ?? null,
      };
    case 'timeline':
      return {
        anchor: args.anchor ?? null,
        query_length: typeof args.query === 'string' ? args.query.length : 0,
        depth_before: args.depth_before ?? null,
        depth_after: args.depth_after ?? null,
        has_project: !!args.project,
      };
    case 'get_observations':
      return { ids_count: Array.isArray(args.ids) ? args.ids.length : 0 };
    case 'smart_search':
      return {
        query_length: typeof args.query === 'string' ? args.query.length : 0,
        has_path: !!args.path,
        has_file_pattern: !!args.file_pattern,
        max_results: args.max_results ?? null,
      };
    case 'smart_unfold':
      return { has_file: !!args.file_path, has_symbol: !!args.symbol_name };
    case 'smart_outline':
      return { has_file: !!args.file_path };
    case 'build_corpus':
      return {
        has_name: !!args.name,
        has_query: !!args.query,
        has_types: !!args.types,
        has_concepts: !!args.concepts,
        has_files: !!args.files,
        limit: args.limit ?? null,
      };
    case 'list_corpora':
      return {};
    case 'prime_corpus':
    case 'rebuild_corpus':
    case 'reprime_corpus':
      return { has_name: !!args.name };
    case 'query_corpus':
      return { has_name: !!args.name, question_length: typeof args.question === 'string' ? args.question.length : 0 };
    case '__IMPORTANT':
      return {};
    default:
      return { unknown_tool: true };
  }
}
