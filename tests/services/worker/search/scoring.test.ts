/**
 * Tests for scoring utilities — ported from Mem0's scoring.py
 *
 * Validates:
 * - getBm25SigmoidParams: adaptive params per query term count
 * - normalizeBm25: logistic sigmoid correctness
 * - scoreAndRank: additive fusion, threshold filtering, top-k
 *
 * Mock Justification: NONE — pure math functions, no I/O
 */
import { describe, it, expect } from 'bun:test';
import {
  getBm25SigmoidParams,
  normalizeBm25,
  scoreAndRank
} from '../../../../src/services/worker/search/scoring.js';
import type { ObservationSearchResult } from '../../../../src/services/worker/search/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObs(id: number, score: number, rank?: number): ObservationSearchResult {
  return {
    id,
    memory_session_id: 'sess-1',
    project: 'test-project',
    title: `Observation ${id}`,
    subtitle: null,
    narrative: null,
    text: null,
    facts: null,
    concepts: null,
    type: 'feature',
    created_at: new Date().toISOString(),
    created_at_epoch: Date.now(),
    files_read: null,
    files_modified: null,
    prompt_number: null,
    discovery_tokens: 0,
    score,
    rank
  } as ObservationSearchResult;
}

// ---------------------------------------------------------------------------
// getBm25SigmoidParams
// ---------------------------------------------------------------------------

describe('getBm25SigmoidParams', () => {
  it('returns (5.0, 0.7) for 1-term query', () => {
    const p = getBm25SigmoidParams(1);
    expect(p.midpoint).toBe(5.0);
    expect(p.steepness).toBe(0.7);
  });

  it('returns (5.0, 0.7) for 3-term query (boundary)', () => {
    const p = getBm25SigmoidParams(3);
    expect(p.midpoint).toBe(5.0);
    expect(p.steepness).toBe(0.7);
  });

  it('returns (7.0, 0.6) for 5-term query', () => {
    const p = getBm25SigmoidParams(5);
    expect(p.midpoint).toBe(7.0);
    expect(p.steepness).toBe(0.6);
  });

  it('returns (7.0, 0.6) for 6-term query (boundary)', () => {
    const p = getBm25SigmoidParams(6);
    expect(p.midpoint).toBe(7.0);
    expect(p.steepness).toBe(0.6);
  });

  it('returns (9.0, 0.5) for 8-term query', () => {
    const p = getBm25SigmoidParams(8);
    expect(p.midpoint).toBe(9.0);
    expect(p.steepness).toBe(0.5);
  });

  it('returns (10.0, 0.5) for 12-term query', () => {
    const p = getBm25SigmoidParams(12);
    expect(p.midpoint).toBe(10.0);
    expect(p.steepness).toBe(0.5);
  });

  it('returns (12.0, 0.5) for 20-term query', () => {
    const p = getBm25SigmoidParams(20);
    expect(p.midpoint).toBe(12.0);
    expect(p.steepness).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// normalizeBm25
// ---------------------------------------------------------------------------

describe('normalizeBm25', () => {
  it('returns ~0.029 for raw=0 with midpoint=5, steepness=0.7', () => {
    // sigmoid(-5 * 0.7) = sigmoid(-3.5) ≈ 0.02931
    const result = normalizeBm25(0, 5, 0.7);
    expect(result).toBeCloseTo(0.02931, 3);
  });

  it('returns exactly 0.5 for raw=midpoint', () => {
    const result = normalizeBm25(5, 5, 0.7);
    expect(result).toBe(0.5);
  });

  it('returns ~0.9999 for raw=20 with midpoint=5, steepness=0.7', () => {
    // sigmoid((20 - 5) * 0.7) = sigmoid(10.5) ≈ 0.99997
    const result = normalizeBm25(20, 5, 0.7);
    expect(result).toBeGreaterThan(0.999);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('is monotonically increasing', () => {
    const scores = [0, 2, 4, 5, 8, 12, 20].map(v => normalizeBm25(v, 5, 0.7));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreAndRank
// ---------------------------------------------------------------------------

describe('scoreAndRank', () => {
  it('uses max_possible=1.0 when only semantic (no BM25, no entity)', () => {
    const obs = makeObs(1, 0.8);
    const results = scoreAndRank({
      semanticResults: [obs],
      bm25Scores: new Map(),
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 10
    });
    expect(results).toHaveLength(1);
    // combined = 0.8 / 1.0 = 0.8
    expect(results[0].combined_score).toBeCloseTo(0.8, 5);
  });

  it('uses max_possible=2.0 when semantic+bm25', () => {
    const obs = makeObs(1, 0.8);
    const bm25 = new Map([['1', 0.6]]);
    const results = scoreAndRank({
      semanticResults: [obs],
      bm25Scores: bm25,
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 10
    });
    expect(results).toHaveLength(1);
    // combined = (0.8 + 0.6) / 2.0 = 0.7
    expect(results[0].combined_score).toBeCloseTo(0.7, 5);
  });

  it('excludes candidates with semantic score below threshold', () => {
    const obs1 = makeObs(1, 0.05);  // below threshold
    const obs2 = makeObs(2, 0.2);   // above threshold
    const results = scoreAndRank({
      semanticResults: [obs1, obs2],
      bm25Scores: new Map(),
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 10
    });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(2);
  });

  it('excludes low-semantic candidate even with high BM25 (semantic gates first)', () => {
    const obs = makeObs(42, 0.05); // below threshold
    const bm25 = new Map([['42', 1.0]]); // max BM25 score
    const results = scoreAndRank({
      semanticResults: [obs],
      bm25Scores: bm25,
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 10
    });
    expect(results).toHaveLength(0);
  });

  it('limits results to topK', () => {
    const observations = [1, 2, 3, 4, 5].map(i => makeObs(i, 0.5 + i * 0.05));
    const results = scoreAndRank({
      semanticResults: observations,
      bm25Scores: new Map(),
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 3
    });
    expect(results).toHaveLength(3);
  });

  it('sorts results by combined_score descending', () => {
    const obs1 = makeObs(1, 0.3);
    const obs2 = makeObs(2, 0.9);
    const obs3 = makeObs(3, 0.6);
    const results = scoreAndRank({
      semanticResults: [obs1, obs2, obs3],
      bm25Scores: new Map(),
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 10
    });
    expect(results[0].id).toBe(2);
    expect(results[1].id).toBe(3);
    expect(results[2].id).toBe(1);
  });

  it('caps combined score at 1.0', () => {
    // semantic=1.0, bm25=1.0, max_possible=2.0 → 1.0
    const obs = makeObs(1, 1.0);
    const bm25 = new Map([['1', 1.0]]);
    const results = scoreAndRank({
      semanticResults: [obs],
      bm25Scores: bm25,
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 10
    });
    expect(results[0].combined_score).toBeLessThanOrEqual(1.0);
    expect(results[0].combined_score).toBeCloseTo(1.0, 5);
  });

  it('gives 0 BM25 boost to observations not in bm25Scores map', () => {
    const obs1 = makeObs(1, 0.8);
    const obs2 = makeObs(2, 0.8);
    const bm25 = new Map([['1', 0.6]]); // only obs1 has BM25
    const results = scoreAndRank({
      semanticResults: [obs1, obs2],
      bm25Scores: bm25,
      entityBoosts: new Map(),
      threshold: 0.1,
      topK: 10
    });
    // obs1 combined = (0.8 + 0.6) / 2.0 = 0.7
    // obs2 combined = (0.8 + 0.0) / 2.0 = 0.4
    const r1 = results.find(r => r.id === 1);
    const r2 = results.find(r => r.id === 2);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1!.combined_score).toBeCloseTo(0.7, 5);
    expect(r2!.combined_score).toBeCloseTo(0.4, 5);
    expect(results[0].id).toBe(1); // boosted obs first
  });
});
