/**
 * FTSSearchStrategy - BM25 keyword search via SQLite FTS5
 *
 * Queries the `observations_fts` virtual table created in migration 28.
 * Results are ordered by FTS5 BM25 rank (lower rank value = more relevant).
 * Project-scoped via JOIN with the observations table.
 *
 * Used when: Query text is provided, FTS5 table exists, and query length >= 2
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult
} from '../types.js';
import { SEARCH_CONSTANTS } from '../types.js';
import type { SessionStore } from '../../../sqlite/SessionStore.js';
import type { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { logger } from '../../../../utils/logger.js';

/** Minimum query length to avoid BM25 garbage on single-character terms */
const MIN_QUERY_LENGTH = 2;

/**
 * Sanitize a raw user query for safe use in an FTS5 MATCH expression.
 *
 * FTS5 MATCH syntax treats `"`, `(`, `)`, `:`, `*`, `-`, `^`, and whitespace
 * runs as special. This helper strips the most dangerous characters and
 * wraps the remaining terms in double-quotes so each word is treated as a
 * literal phrase prefix rather than a boolean operator.
 *
 * Strategy:
 * 1. Strip characters that break the parser outright: `"`, `(`, `)`, `:`
 * 2. Split on whitespace into individual tokens
 * 3. Wrap each non-empty token in double-quotes
 * 4. Join with `OR` — BM25 ranking naturally promotes docs matching more
 *    terms, and single-term matches still surface as relevant candidates
 *    for the multi-signal fusion layer to filter.
 *
 * Previously joined with a bare space (FTS5's implicit operator is AND,
 * not OR — the old comment was wrong). That AND behavior dropped recall
 * catastrophically on 3+ word queries: an empirical audit found AND
 * returning 5 rows where OR returned 891 (178× gap) for the same query,
 * which is why narrow multi-word MCP searches kept returning empty.
 */
export function sanitizeFTSQuery(raw: string): string {
  // Remove characters that break FTS5 MATCH syntax
  const stripped = raw.replace(/["():*\-^]/g, ' ');
  const tokens = stripped.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map(t => `"${t}"`).join(' OR ');
}

/**
 * Row shape returned by the BM25 FTS query.
 * Must match exactly the columns selected in the prepared statement below.
 */
interface FTSQueryRow {
  id: number;
  memory_session_id: string;
  project: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  type: string;
  created_at: string;
  created_at_epoch: number;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  rank: number;
}

export class FTSSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'fts';

  private ftsAvailable: boolean | null = null;

  constructor(
    private sessionStore: SessionStore,
    // SessionSearch kept for constructor symmetry with HybridSearchStrategy
    // but not actively used — all queries run directly on sessionStore.db
    private _sessionSearch: SessionSearch
  ) {
    super();
  }

  // -----------------------------------------------------------------------
  // FTS5 availability check — cached after first call
  // -----------------------------------------------------------------------

  private checkFTSAvailable(): boolean {
    if (this.ftsAvailable !== null) return this.ftsAvailable;
    const rows = this.sessionStore.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'")
      .all() as { name: string }[];
    this.ftsAvailable = rows.length > 0;
    return this.ftsAvailable;
  }

  // -----------------------------------------------------------------------
  // SearchStrategy interface
  // -----------------------------------------------------------------------

  canHandle(options: StrategySearchOptions): boolean {
    const q = options.query ?? '';
    return q.length >= MIN_QUERY_LENGTH && this.checkFTSAvailable();
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      obsType,
      dateRange,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project
    } = options;

    // Early-return guards — query absent or too short (canHandle already blocks this,
    // but search() must be safe to call independently).
    if (!query || query.length < MIN_QUERY_LENGTH) {
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        usedFTS: false,
        fellBack: false,
        strategy: 'fts'
      };
    }

    if (!this.checkFTSAvailable()) {
      logger.warn('SEARCH', 'FTSSearchStrategy: observations_fts table not available — skipping');
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        usedFTS: false,
        fellBack: false,
        strategy: 'fts'
      };
    }

    const sanitized = sanitizeFTSQuery(query);
    if (sanitized.length === 0) {
      logger.warn('SEARCH', 'FTSSearchStrategy: query reduced to empty after sanitization', {});
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        usedFTS: false,
        fellBack: false,
        strategy: 'fts'
      };
    }

    try {
      // Build optional filter clauses that are appended to the base SQL
      const additionalConditions: string[] = [];
      const params: (string | number)[] = [sanitized];

      // Project filter — always required for scoped search
      if (project) {
        additionalConditions.push('o.project = ?');
        params.push(project);
      }

      // obsType filter (single value or array)
      if (obsType) {
        if (Array.isArray(obsType)) {
          const placeholders = obsType.map(() => '?').join(', ');
          additionalConditions.push(`o.type IN (${placeholders})`);
          params.push(...obsType);
        } else {
          additionalConditions.push('o.type = ?');
          params.push(obsType);
        }
      }

      // dateRange filter — supports epoch integers and ISO strings
      if (dateRange?.start !== undefined) {
        const start = typeof dateRange.start === 'number'
          ? dateRange.start
          : new Date(dateRange.start).getTime();
        additionalConditions.push('o.created_at_epoch >= ?');
        params.push(start);
      }
      if (dateRange?.end !== undefined) {
        const end = typeof dateRange.end === 'number'
          ? dateRange.end
          : new Date(dateRange.end).getTime();
        additionalConditions.push('o.created_at_epoch <= ?');
        params.push(end);
      }

      params.push(limit);

      const whereExtra = additionalConditions.length > 0
        ? `AND ${additionalConditions.join(' AND ')}`
        : '';

      const sql = `
        SELECT
          o.id, o.memory_session_id, o.project,
          o.title, o.subtitle, o.narrative, o.text,
          o.facts, o.concepts, o.type,
          o.created_at, o.created_at_epoch,
          o.files_read, o.files_modified,
          o.prompt_number, o.discovery_tokens,
          observations_fts.rank AS rank
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          ${whereExtra}
        ORDER BY observations_fts.rank
        LIMIT ?
      `;

      const rows = this.sessionStore.db.prepare(sql).all(...params) as FTSQueryRow[];

      logger.debug('SEARCH', 'FTSSearchStrategy: BM25 query returned rows', {
        rowCount: rows.length
      });

      const observations: ObservationSearchResult[] = rows.map(row => ({
        id: row.id,
        memory_session_id: row.memory_session_id,
        project: row.project,
        title: row.title,
        subtitle: row.subtitle,
        narrative: row.narrative,
        text: row.text,
        facts: row.facts,
        concepts: row.concepts,
        type: row.type as ObservationSearchResult['type'],
        created_at: row.created_at,
        created_at_epoch: row.created_at_epoch,
        files_read: row.files_read,
        files_modified: row.files_modified,
        prompt_number: row.prompt_number,
        discovery_tokens: row.discovery_tokens,
        // FTS5 rank is negative; expose it for downstream re-ranking (Phase C RRF)
        rank: row.rank
      }));

      return {
        results: { observations, sessions: [], prompts: [] },
        usedChroma: false,
        usedFTS: true,
        fellBack: false,
        strategy: 'fts'
      };

    } catch (error: unknown) {
      logger.error('SEARCH', 'FTSSearchStrategy: BM25 query failed', {}, error as Error);
      return this.emptyResult('fts');
    }
  }
}
