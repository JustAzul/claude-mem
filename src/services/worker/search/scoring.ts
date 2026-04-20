/**
 * Scoring utilities for hybrid retrieval.
 *
 * Ported from Mem0's scoring.py:
 * https://github.com/mem0ai/mem0/blob/main/mem0/utils/scoring.py
 *
 * Provides:
 * - BM25 normalization: Sigmoid normalization of raw BM25 scores to [0, 1].
 * - BM25 parameter selection: Query-length-adaptive sigmoid parameters.
 * - Additive scoring: Combined scoring with semantic + BM25 + entity boost.
 */

import { logger } from '../../../utils/logger.js';
import type { ObservationSearchResult } from './types.js';

/**
 * Parameters for the logistic sigmoid used to normalize BM25 scores.
 */
export interface Bm25SigmoidParams {
  midpoint: number;
  steepness: number;
}

/**
 * A candidate in the scoring pool — a semantic result with optional BM25 boost.
 */
export interface ScoredCandidate {
  id: number;
  combined_score: number;
  observation: ObservationSearchResult;
}

/** Weight applied to entity boost signal (matching Mem0's ENTITY_BOOST_WEIGHT = 0.5) */
const ENTITY_BOOST_WEIGHT = 0.5;

/**
 * Get BM25 sigmoid parameters based on query term count.
 *
 * Longer queries tend to have higher raw BM25 scores, so the sigmoid
 * midpoint and steepness are adjusted accordingly.
 *
 * Ported from Mem0's `get_bm25_params`. Lemmatization is skipped here —
 * SQLite FTS5's `porter` tokenizer handles basic stemming. Term count is
 * computed from the raw query split by whitespace.
 *
 * @param queryLength - Number of whitespace-delimited terms in the query
 */
export function getBm25SigmoidParams(queryLength: number): Bm25SigmoidParams {
  const numTerms = Math.max(1, queryLength);

  if (numTerms <= 3) {
    return { midpoint: 5.0, steepness: 0.7 };
  } else if (numTerms <= 6) {
    return { midpoint: 7.0, steepness: 0.6 };
  } else if (numTerms <= 9) {
    return { midpoint: 9.0, steepness: 0.5 };
  } else if (numTerms <= 15) {
    return { midpoint: 10.0, steepness: 0.5 };
  } else {
    return { midpoint: 12.0, steepness: 0.5 };
  }
}

/**
 * Normalize a raw BM25 score to [0, 1] using a logistic sigmoid.
 *
 * Ported from Mem0's `normalize_bm25`.
 *
 * @param rawScore - Positive raw BM25 score (0 to ~20+). In SQLite FTS5, the
 *   `rank` column is negative (more negative = more relevant), so callers must
 *   negate it before passing here: `rawScore = -observation.rank`.
 * @param midpoint - Score at which sigmoid outputs exactly 0.5.
 * @param steepness - Controls how quickly the sigmoid transitions.
 */
export function normalizeBm25(rawScore: number, midpoint: number, steepness: number): number {
  return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

/**
 * Options for `scoreAndRank`.
 */
export interface ScoreAndRankOptions {
  /** Universe of candidates — only semantic results are ever included. */
  semanticResults: ObservationSearchResult[];
  /**
   * Normalized BM25 scores keyed by observation id (as string).
   * Observations absent from this map get a BM25 score of 0.
   */
  bm25Scores: Map<string, number>;
  /**
   * Entity boost values keyed by observation id (as string).
   * Observations absent from this map get an entity boost of 0.
   * Pass an empty Map for Phase 1 (entity boost is a Phase 2 feature).
   */
  entityBoosts: Map<string, number>;
  /** Minimum semantic score — candidates below this are excluded. */
  threshold: number;
  /** Maximum number of results to return. */
  topK: number;
}

/**
 * Score candidates additively and return the top-k results.
 *
 * Ported from Mem0's `score_and_rank`. Key invariants:
 *   - Semantic results form the entire candidate universe.
 *   - Threshold gates the semantic score BEFORE combining.
 *   - `combined = (semantic + bm25 + entity_boost) / max_possible`, capped at 1.0.
 *   - max_possible adapts based on which signals are active.
 *
 * The divisor ensures combined scores remain in [0, 1] regardless of how many
 * signals fire. An observation only in FTS (not in semantic results) is NOT
 * included — semantic relevance is the filter.
 */
export function scoreAndRank(options: ScoreAndRankOptions): ScoredCandidate[] {
  const { semanticResults, bm25Scores, entityBoosts, threshold, topK } = options;

  const hasBm25 = bm25Scores.size > 0;
  const hasEntity = entityBoosts.size > 0;

  let maxPossible = 1.0;
  if (hasBm25) maxPossible += 1.0;
  if (hasEntity) maxPossible += ENTITY_BOOST_WEIGHT;

  const scored: ScoredCandidate[] = [];

  for (const observation of semanticResults) {
    const semanticScore = observation.score ?? 0.0;
    if (semanticScore < threshold) continue;

    const idStr = String(observation.id);
    const bm25Score = bm25Scores.get(idStr) ?? 0.0;
    const entityBoost = entityBoosts.get(idStr) ?? 0.0;

    const rawCombined = semanticScore + bm25Score + entityBoost;
    const combined = Math.min(rawCombined / maxPossible, 1.0);

    scored.push({ id: observation.id, combined_score: combined, observation });
  }

  scored.sort((a, b) => b.combined_score - a.combined_score);
  return scored.slice(0, topK);
}
