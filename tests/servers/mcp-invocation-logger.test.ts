/**
 * Tests for mcp-invocation-logger helpers.
 *
 * Uses an in-memory SQLite DB with the mcp_invocations schema applied directly —
 * no SessionStore dependency needed for unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { logMcpInvocation, buildArgsSummary } from '../../src/servers/mcp-invocation-logger.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS mcp_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    args_summary TEXT,
    result_status TEXT NOT NULL,
    error_message TEXT,
    duration_ms INTEGER,
    invoked_at_epoch INTEGER NOT NULL
  )
`;

describe('logMcpInvocation', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(CREATE_TABLE);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a row with correct columns for a successful invocation', () => {
    const before = Date.now();
    logMcpInvocation(db, {
      toolName: 'search',
      argsSummary: { query_length: 10 },
      resultStatus: 'ok',
      durationMs: 55,
    });
    const after = Date.now();

    const row = db.prepare('SELECT * FROM mcp_invocations').get() as {
      id: number;
      tool_name: string;
      args_summary: string;
      result_status: string;
      error_message: string | null;
      duration_ms: number;
      invoked_at_epoch: number;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.tool_name).toBe('search');
    expect(JSON.parse(row!.args_summary)).toEqual({ query_length: 10 });
    expect(row!.result_status).toBe('ok');
    expect(row!.error_message).toBeNull();
    expect(row!.duration_ms).toBe(55);
    expect(row!.invoked_at_epoch).toBeGreaterThanOrEqual(before);
    expect(row!.invoked_at_epoch).toBeLessThanOrEqual(after);
  });

  it('inserts an error row with error_message populated', () => {
    logMcpInvocation(db, {
      toolName: 'timeline',
      argsSummary: { anchor: null },
      resultStatus: 'error',
      errorMessage: 'Worker unavailable',
      durationMs: 12,
    });

    const row = db.prepare('SELECT result_status, error_message FROM mcp_invocations').get() as {
      result_status: string;
      error_message: string | null;
    } | undefined;

    expect(row!.result_status).toBe('error');
    expect(row!.error_message).toBe('Worker unavailable');
  });

  it('stores null args_summary when argsSummary is null', () => {
    logMcpInvocation(db, {
      toolName: 'list_corpora',
      argsSummary: null,
      resultStatus: 'ok',
      durationMs: 3,
    });

    const row = db.prepare('SELECT args_summary FROM mcp_invocations').get() as {
      args_summary: string | null;
    };
    expect(row.args_summary).toBeNull();
  });

  it('silently swallows errors when DB is closed — never throws', () => {
    const closedDb = new Database(':memory:');
    closedDb.run(CREATE_TABLE);
    closedDb.close();

    // Must not throw
    expect(() => {
      logMcpInvocation(closedDb, {
        toolName: 'search',
        argsSummary: { query_length: 5 },
        resultStatus: 'ok',
        durationMs: 1,
      });
    }).not.toThrow();
  });
});

describe('buildArgsSummary', () => {
  it('search — returns structural metrics, strips query content', () => {
    const result = buildArgsSummary('search', {
      query: 'abc',
      limit: 10,
    });
    expect(result).toEqual({
      query_length: 3,
      has_project: false,
      has_type: false,
      has_obs_type: false,
      has_date_range: false,
      limit: 10,
    });
  });

  it('search — has_project / has_type / has_obs_type / has_date_range set to true', () => {
    const result = buildArgsSummary('search', {
      query: 'hello world',
      project: '/home/user/proj',
      type: 'refactor',
      obs_type: 'bugfix',
      dateStart: '2025-01-01',
    });
    expect(result).toMatchObject({
      query_length: 11,
      has_project: true,
      has_type: true,
      has_obs_type: true,
      has_date_range: true,
    });
  });

  it('timeline — returns anchor and depth fields', () => {
    const result = buildArgsSummary('timeline', {
      anchor: 42,
      query: 'recent work',
      depth_before: 5,
      depth_after: 3,
      project: '/tmp',
    });
    expect(result).toEqual({
      anchor: 42,
      query_length: 11,
      depth_before: 5,
      depth_after: 3,
      has_project: true,
    });
  });

  it('get_observations — returns ids_count', () => {
    const result = buildArgsSummary('get_observations', { ids: [1, 2, 3] });
    expect(result).toEqual({ ids_count: 3 });
  });

  it('smart_search — returns query_length, has_path, max_results', () => {
    const result = buildArgsSummary('smart_search', {
      query: 'find parser',
      path: '/src',
      max_results: 20,
    });
    expect(result).toEqual({
      query_length: 11,
      has_path: true,
      has_file_pattern: false,
      max_results: 20,
    });
  });

  it('build_corpus — returns structural booleans', () => {
    const result = buildArgsSummary('build_corpus', {
      name: 'my-corpus',
      query: 'parser work',
      limit: 100,
    });
    expect(result).toMatchObject({
      has_name: true,
      has_query: true,
      has_types: false,
      has_concepts: false,
      has_files: false,
      limit: 100,
    });
  });

  it('unknown_tool — returns { unknown_tool: true }', () => {
    const result = buildArgsSummary('unknown_tool', {});
    expect(result).toEqual({ unknown_tool: true });
  });

  it('unknown_tool with args still returns { unknown_tool: true } (no PII leaks)', () => {
    const result = buildArgsSummary('some_future_tool', {
      secret_api_key: 'sk-1234567890abcdef',
      user_data: 'private content',
    });
    expect(result).toEqual({ unknown_tool: true });
  });
});
