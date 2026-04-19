/**
 * MultiSignalSearchStrategy - Additive fusion of semantic + BM25 signals
 *
 * Implements Mem0's production-tuned hybrid retrieval approach:
 *   1. Semantic results (Chroma) form the candidate universe.
 *   2. BM25 scores (SQLite FTS5) boost existing semantic candidates.
 *   3. Observations only in FTS (not in semantic) are NOT included.
 *   4. Combined score = (semantic + bm25) / max_possible, capped at 1.0.
 *
 * Reference: Mem0 scoring.py + main.py:_search_vector_store (lines 1335-1400)
 * Mem0 achieves 91.6 on LoCoMo with this additive-scoring approach.
 *
 * Used when: query text is provided, both Chroma and FTS5 are available.
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult
} from '../types.js';
import type { MultiSignalObservationResult } from '../types.js';
import { SEARCH_CONSTANTS } from '../types.js';
import { getBm25SigmoidParams, normalizeBm25, scoreAndRank } from '../scoring.js';
import { sanitizeFTSQuery } from './FTSSearchStrategy.js';
import type { ChromaSearchStrategy } from './ChromaSearchStrategy.js';
import type { FTSSearchStrategy } from './FTSSearchStrategy.js';
import { logger } from '../../../../utils/logger.js';

/** Minimum query length to trigger multi-signal search */
const MIN_QUERY_LENGTH = 2;

/** Semantic score threshold — candidates below this are excluded before combining */
const DEFAULT_THRESHOLD = 0.1;

/**
 * Over-fetch multiplier for the scoring pool.
 * Matches Mem0's `internal_limit = max(limit * 4, 60)` pattern.
 */
const OVER_FETCH_MULTIPLIER = 4;
const OVER_FETCH_MIN = 60;

export class MultiSignalSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'multi_signal';

  constructor(
    private chromaStrategy: ChromaSearchStrategy,
    private ftsStrategy: FTSSearchStrategy
  ) {
    super();
  }

  // -----------------------------------------------------------------------
  // SearchStrategy interface
  // -----------------------------------------------------------------------

  canHandle(options: StrategySearchOptions): boolean {
    const q = options.query ?? '';
    return (
      q.length >= MIN_QUERY_LENGTH &&
      this.chromaStrategy.canHandle(options) &&
      this.ftsStrategy.canHandle(options)
    );
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const { query, limit = SEARCH_CONSTANTS.DEFAULT_LIMIT } = options;

    // Guard: query absent or too short
    if (!query || query.length < MIN_QUERY_LENGTH) {
      logger.warn('SEARCH', 'MultiSignalSearchStrategy: query too short, returning empty', {});
      return this.emptyResult('multi_signal');
    }

    // Guard: sanitize for FTS — if nothing survives, bail early
    const sanitized = sanitizeFTSQuery(query);
    if (sanitized.length === 0) {
      logger.warn('SEARCH', 'MultiSignalSearchStrategy: query sanitized to empty', {});
      return this.emptyResult('multi_signal');
    }

    const internalLimit = Math.max(limit * OVER_FETCH_MULTIPLIER, OVER_FETCH_MIN);
    const overFetchOptions: StrategySearchOptions = { ...options, limit: internalLimit };

    // Step 1: Parallel fetch from both strategies
    let semanticResult: StrategySearchResult;
    let ftsResult: StrategySearchResult;

    try {
      [semanticResult, ftsResult] = await Promise.all([
        this.chromaStrategy.search(overFetchOptions).catch((err: unknown) => {
          logger.warn('SEARCH', 'MultiSignalSearchStrategy: Chroma strategy threw', {}, err instanceof Error ? err : undefined);
          return null;
        }),
        this.ftsStrategy.search(overFetchOptions).catch((err: unknown) => {
          logger.warn('SEARCH', 'MultiSignalSearchStrategy: FTS strategy threw', {}, err instanceof Error ? err : undefined);
          return null;
        })
      ]) as [StrategySearchResult | null, StrategySearchResult | null];
    } catch (error: unknown) {
      logger.warn('SEARCH', 'MultiSignalSearchStrategy: parallel fetch failed', {}, error instanceof Error ? error : undefined);
      return { ...this.emptyResult('multi_signal'), fellBack: true };
    }

    // chromaFailed covers three cases: null (threw), usedChroma=false (internal
    // failure), and an empty semantic universe. Treating empty-Chroma as a failure
    // matters for narrow technical queries (function/class names, error strings)
    // where semantic embeddings miss the match but BM25 finds it — without this,
    // multi_signal would silently return empty despite FTS having relevant hits.
    const chromaFailed =
      semanticResult === null ||
      !semanticResult.usedChroma ||
      semanticResult.results.observations.length === 0;
    const ftsFailed = ftsResult === null || !ftsResult.usedFTS;

    // Step 2: Graceful fallbacks when one signal fails
    if (chromaFailed && ftsFailed) {
      logger.warn('SEARCH', 'MultiSignalSearchStrategy: both signals failed, returning empty', {});
      return { ...this.emptyResult('multi_signal'), fellBack: true };
    }

    if (chromaFailed && !ftsFailed) {
      logger.warn('SEARCH', 'MultiSignalSearchStrategy: Chroma failed, returning FTS-only results', {});
      return {
        ...(ftsResult as StrategySearchResult),
        strategy: 'multi_signal',
        usedChroma: false,
        usedFTS: true,
        fellBack: true
      };
    }

    if (!chromaFailed && ftsFailed) {
      logger.warn('SEARCH', 'MultiSignalSearchStrategy: FTS failed, returning Chroma-only results', {});
      return {
        ...(semanticResult as StrategySearchResult),
        strategy: 'multi_signal',
        usedChroma: true,
        usedFTS: false,
        fellBack: true
      };
    }

    // Both succeeded — run additive scoring.
    //
    // ChromaSearchStrategy currently returns observations without `.score` populated
    // (semantic similarity is lost during the hydrate-from-SQLite step). Until that
    // gap is closed (follow-up), synthesize a position-based semantic score so the
    // threshold gate in scoreAndRank lets candidates through. Top result gets 1.0,
    // last gets a small positive value — preserves Chroma's rank ordering as the
    // tie-breaker and keeps BM25 boost additive on top.
    const semanticObsRaw = (semanticResult as StrategySearchResult).results.observations;
    const denom = Math.max(semanticObsRaw.length, 1);
    const semanticObs = semanticObsRaw.map((obs, idx) => {
      // Preserve an already-populated score (tests / future ChromaSearchStrategy
      // work that exposes raw similarity). Only synthesize when missing.
      if (obs.score !== undefined && obs.score !== null) return obs;
      return { ...obs, score: 1.0 - idx / denom };
    });
    const ftsObs = (ftsResult as StrategySearchResult).results.observations;

    // Step 3: Build normalized BM25 scores from FTS results
    const queryTerms = query.trim().split(/\s+/).filter(t => t.length > 0);
    const { midpoint, steepness } = getBm25SigmoidParams(queryTerms.length);

    const bm25Scores = new Map<string, number>();
    for (const obs of ftsObs) {
      // FTS5 rank is negative; negate to get positive score (higher = more relevant)
      const rawBm25 = obs.rank !== undefined ? -obs.rank : 0;
      if (rawBm25 > 0) {
        const normalized = normalizeBm25(rawBm25, midpoint, steepness);
        bm25Scores.set(String(obs.id), normalized);
      }
    }

    // Step 4: Additive scoring — semantic universe + BM25 boost
    const scored = scoreAndRank({
      semanticResults: semanticObs,
      bm25Scores,
      entityBoosts: new Map(), // Phase 2
      threshold: DEFAULT_THRESHOLD,
      topK: limit
    });

    // Step 5: Build output observations preserving original fields + combined_score
    const observations: MultiSignalObservationResult[] = scored.map(candidate => ({
      ...candidate.observation,
      combined_score: candidate.combined_score
    }));

    logger.debug('SEARCH', 'MultiSignalSearchStrategy: scoring complete', {
      semanticCandidates: semanticObs.length,
      ftsBoosts: bm25Scores.size,
      afterThreshold: scored.length
    });

    return {
      results: {
        observations: observations as ObservationSearchResult[],
        sessions: (semanticResult as StrategySearchResult).results.sessions,
        prompts: (semanticResult as StrategySearchResult).results.prompts
      },
      usedChroma: true,
      usedFTS: true,
      fellBack: false,
      strategy: 'multi_signal'
    };
  }
}
