/**
 * Tests for MultiSignalSearchStrategy — additive semantic + BM25 fusion
 *
 * Mock Justification:
 * - ChromaSearchStrategy is mocked (requires live ChromaDB + embedding model).
 * - FTSSearchStrategy is mocked (real DB tested separately in fts-search-strategy.test.ts).
 * - Focus: orchestration logic, scoring pipeline, fallback paths.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { MultiSignalSearchStrategy } from '../../../../../src/services/worker/search/strategies/MultiSignalSearchStrategy.js';
import type { ChromaSearchStrategy } from '../../../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import type { FTSSearchStrategy } from '../../../../../src/services/worker/search/strategies/FTSSearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult
} from '../../../../../src/services/worker/search/types.js';

// ---------------------------------------------------------------------------
// Minimal helpers
// ---------------------------------------------------------------------------

function makeObs(id: number, score: number, rank?: number): ObservationSearchResult {
  return {
    id,
    memory_session_id: 'sess-1',
    project: 'test-project',
    title: `Observation ${id}`,
    subtitle: null,
    narrative: `Content for observation ${id}`,
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

function chromaResult(observations: ObservationSearchResult[], used = true): StrategySearchResult {
  return {
    results: { observations, sessions: [], prompts: [] },
    usedChroma: used,
    usedFTS: false,
    fellBack: false,
    strategy: 'chroma'
  };
}

function ftsResult(observations: ObservationSearchResult[], used = true): StrategySearchResult {
  return {
    results: { observations, sessions: [], prompts: [] },
    usedChroma: false,
    usedFTS: used,
    fellBack: false,
    strategy: 'fts'
  };
}

function makeChromaMock(result: StrategySearchResult | (() => Promise<StrategySearchResult>)): ChromaSearchStrategy {
  return {
    name: 'chroma',
    canHandle: () => true,
    search: typeof result === 'function' ? result : () => Promise.resolve(result)
  } as unknown as ChromaSearchStrategy;
}

function makeFtsMock(result: StrategySearchResult | (() => Promise<StrategySearchResult>)): FTSSearchStrategy {
  return {
    name: 'fts',
    canHandle: () => true,
    search: typeof result === 'function' ? result : () => Promise.resolve(result)
  } as unknown as FTSSearchStrategy;
}

const defaultOptions: StrategySearchOptions = {
  query: 'TypeScript async search',
  limit: 10
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiSignalSearchStrategy', () => {

  describe('canHandle', () => {
    it('returns true when query is present and both strategies can handle', () => {
      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([])),
        makeFtsMock(ftsResult([]))
      );
      expect(strategy.canHandle(defaultOptions)).toBe(true);
    });

    it('returns false when query is too short', () => {
      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([])),
        makeFtsMock(ftsResult([]))
      );
      expect(strategy.canHandle({ query: 'a', limit: 10 })).toBe(false);
    });

    it('returns false when Chroma cannot handle', () => {
      const chromaMock = { name: 'chroma', canHandle: () => false, search: mock() } as unknown as ChromaSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(chromaMock, makeFtsMock(ftsResult([])));
      expect(strategy.canHandle(defaultOptions)).toBe(false);
    });

    it('returns false when FTS cannot handle', () => {
      const ftsMock = { name: 'fts', canHandle: () => false, search: mock() } as unknown as FTSSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(makeChromaMock(chromaResult([])), ftsMock);
      expect(strategy.canHandle(defaultOptions)).toBe(false);
    });
  });

  describe('search — query guards', () => {
    it('returns empty for query shorter than 2 characters without calling either strategy', async () => {
      const chromaSearch = mock(() => Promise.resolve(chromaResult([])));
      const ftsSearch = mock(() => Promise.resolve(ftsResult([])));
      const chromaMock = { name: 'chroma', canHandle: () => true, search: chromaSearch } as unknown as ChromaSearchStrategy;
      const ftsMock = { name: 'fts', canHandle: () => true, search: ftsSearch } as unknown as FTSSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(chromaMock, ftsMock);

      const result = await strategy.search({ query: 'x', limit: 10 });

      expect(result.results.observations).toHaveLength(0);
      expect(result.strategy).toBe('multi_signal');
      expect(chromaSearch).not.toHaveBeenCalled();
      expect(ftsSearch).not.toHaveBeenCalled();
    });

    it('returns empty for empty query', async () => {
      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([])),
        makeFtsMock(ftsResult([]))
      );
      const result = await strategy.search({ query: '', limit: 10 });
      expect(result.results.observations).toHaveLength(0);
    });
  });

  describe('search — parallel execution with over-fetch', () => {
    it('calls both strategies with limit multiplied by 4 (min 60)', async () => {
      const chromaSearch = mock(() => Promise.resolve(chromaResult([])));
      const ftsSearch = mock(() => Promise.resolve(ftsResult([])));
      const chromaMock = { name: 'chroma', canHandle: () => true, search: chromaSearch } as unknown as ChromaSearchStrategy;
      const ftsMock = { name: 'fts', canHandle: () => true, search: ftsSearch } as unknown as FTSSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(chromaMock, ftsMock);

      await strategy.search({ query: 'typescript search', limit: 10 });

      expect(chromaSearch).toHaveBeenCalledTimes(1);
      expect(ftsSearch).toHaveBeenCalledTimes(1);

      const chromaCallOpts = (chromaSearch.mock.calls[0] as StrategySearchOptions[])[0];
      const ftsCallOpts = (ftsSearch.mock.calls[0] as StrategySearchOptions[])[0];
      // max(10 * 4, 60) = 60
      expect(chromaCallOpts.limit).toBe(60);
      expect(ftsCallOpts.limit).toBe(60);
    });

    it('uses at least limit*4 when that exceeds 60', async () => {
      const chromaSearch = mock(() => Promise.resolve(chromaResult([])));
      const ftsSearch = mock(() => Promise.resolve(ftsResult([])));
      const chromaMock = { name: 'chroma', canHandle: () => true, search: chromaSearch } as unknown as ChromaSearchStrategy;
      const ftsMock = { name: 'fts', canHandle: () => true, search: ftsSearch } as unknown as FTSSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(chromaMock, ftsMock);

      await strategy.search({ query: 'typescript search', limit: 20 });

      const chromaCallOpts = (chromaSearch.mock.calls[0] as StrategySearchOptions[])[0];
      // max(20 * 4, 60) = max(80, 60) = 80
      expect(chromaCallOpts.limit).toBe(80);
    });
  });

  describe('search — additive scoring', () => {
    it('combines semantic + bm25 with max_possible=2.0 divisor', async () => {
      const sem = makeObs(1, 0.8);
      const fts = makeObs(1, 0.0, -2.0); // rank = -2.0, rawBm25 = 2.0

      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([sem])),
        makeFtsMock(ftsResult([fts]))
      );

      const result = await strategy.search(defaultOptions);
      expect(result.results.observations).toHaveLength(1);

      const obs = result.results.observations[0] as ObservationSearchResult & { combined_score: number };
      // rawBm25 = 2.0, params for 3-word query: midpoint=5, steepness=0.7
      // normalized = sigmoid(0.7 * (2.0 - 5.0)) = sigmoid(-2.1) ≈ 0.109
      // combined = (0.8 + 0.109) / 2.0 ≈ 0.455
      expect(obs.combined_score).toBeDefined();
      expect(obs.combined_score).toBeGreaterThan(0.4);
      expect(obs.combined_score).toBeLessThan(0.6);
    });

    it('uses max_possible=1.0 when no FTS results fire for any candidate', async () => {
      const sem = makeObs(1, 0.6);
      // FTS results for completely different IDs — so obs 1 gets 0 BM25 boost
      const fts = makeObs(99, 0.0, -5.0);

      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([sem])),
        makeFtsMock(ftsResult([fts]))
      );

      const result = await strategy.search(defaultOptions);
      const obs = result.results.observations[0] as ObservationSearchResult & { combined_score: number };
      // bm25Scores map has entry for id=99 but not id=1
      // but hasBm25 = true (map is non-empty), so max_possible = 2.0
      // combined = (0.6 + 0.0) / 2.0 = 0.3
      expect(obs.combined_score).toBeCloseTo(0.3, 4);
    });
  });

  describe('search — threshold gate', () => {
    it('excludes semantic results below threshold (0.1), even with high BM25', async () => {
      const lowSem = makeObs(1, 0.05);  // below threshold
      const highSem = makeObs(2, 0.7);
      const fts1 = makeObs(1, 0.0, -10.0); // very high BM25 for obs 1
      const fts2 = makeObs(2, 0.0, -5.0);

      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([lowSem, highSem])),
        makeFtsMock(ftsResult([fts1, fts2]))
      );

      const result = await strategy.search(defaultOptions);
      const ids = result.results.observations.map(o => o.id);
      expect(ids).not.toContain(1);
      expect(ids).toContain(2);
    });
  });

  describe('search — BM25 boosts but does not add new candidates', () => {
    it('observation only in FTS (not in semantic) is NOT included in results', async () => {
      const sem = makeObs(1, 0.7);
      const fts1 = makeObs(1, 0.0, -5.0);  // in semantic universe
      const fts2 = makeObs(99, 0.0, -10.0); // NOT in semantic universe

      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([sem])),
        makeFtsMock(ftsResult([fts1, fts2]))
      );

      const result = await strategy.search(defaultOptions);
      const ids = result.results.observations.map(o => o.id);
      expect(ids).toContain(1);
      expect(ids).not.toContain(99);
    });
  });

  describe('search — ranking', () => {
    it('returns results sorted by combined_score descending', async () => {
      const obs1 = makeObs(1, 0.3);
      const obs2 = makeObs(2, 0.9);
      const obs3 = makeObs(3, 0.6);

      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([obs1, obs2, obs3])),
        makeFtsMock(ftsResult([])) // no BM25 boost — pure semantic ranking
      );

      const result = await strategy.search(defaultOptions);
      const ids = result.results.observations.map(o => o.id);
      expect(ids[0]).toBe(2); // 0.9
      expect(ids[1]).toBe(3); // 0.6
      expect(ids[2]).toBe(1); // 0.3
    });
  });

  describe('search — BM25 sigmoid normalization', () => {
    it('raw BM25 at midpoint (5.0) normalizes to ~0.5', async () => {
      // For 3-word query: midpoint=5, steepness=0.7
      // rank=-5.0 → rawBm25=5.0 → normalized=0.5
      const sem = makeObs(1, 0.8);
      const fts = makeObs(1, 0.0, -5.0);

      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([sem])),
        makeFtsMock(ftsResult([fts]))
      );

      const result = await strategy.search(defaultOptions);
      const obs = result.results.observations[0] as ObservationSearchResult & { combined_score: number };
      // combined = (0.8 + 0.5) / 2.0 = 0.65
      expect(obs.combined_score).toBeCloseTo(0.65, 2);
    });
  });

  describe('search — fallbacks', () => {
    it('returns FTS results with fellBack=true when Chroma throws', async () => {
      const ftsObs = [makeObs(1, 0.0, -5.0), makeObs(2, 0.0, -3.0)];
      const chromaMock = {
        name: 'chroma',
        canHandle: () => true,
        search: () => Promise.reject(new Error('Chroma connection refused'))
      } as unknown as ChromaSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(
        chromaMock,
        makeFtsMock(ftsResult(ftsObs))
      );

      const result = await strategy.search(defaultOptions);
      expect(result.fellBack).toBe(true);
      expect(result.strategy).toBe('multi_signal');
      expect(result.usedChroma).toBe(false);
      expect(result.usedFTS).toBe(true);
      expect(result.results.observations.length).toBe(2);
    });

    it('returns Chroma results with fellBack=true when FTS throws', async () => {
      const semObs = [makeObs(1, 0.8), makeObs(2, 0.6)];
      const ftsMock = {
        name: 'fts',
        canHandle: () => true,
        search: () => Promise.reject(new Error('FTS table missing'))
      } as unknown as FTSSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult(semObs)),
        ftsMock
      );

      const result = await strategy.search(defaultOptions);
      expect(result.fellBack).toBe(true);
      expect(result.strategy).toBe('multi_signal');
      expect(result.usedChroma).toBe(true);
      expect(result.usedFTS).toBe(false);
      expect(result.results.observations.length).toBe(2);
    });

    it('returns empty with fellBack=true when both strategies throw', async () => {
      const chromaMock = {
        name: 'chroma',
        canHandle: () => true,
        search: () => Promise.reject(new Error('Chroma down'))
      } as unknown as ChromaSearchStrategy;
      const ftsMock = {
        name: 'fts',
        canHandle: () => true,
        search: () => Promise.reject(new Error('FTS down'))
      } as unknown as FTSSearchStrategy;
      const strategy = new MultiSignalSearchStrategy(chromaMock, ftsMock);

      const result = await strategy.search(defaultOptions);
      expect(result.fellBack).toBe(true);
      expect(result.results.observations).toHaveLength(0);
    });

    it('returns FTS results when Chroma returns usedChroma=false (failed silently)', async () => {
      const chromaMock = {
        name: 'chroma',
        canHandle: () => true,
        search: () => Promise.resolve(chromaResult([], false))
      } as unknown as ChromaSearchStrategy;
      const ftsObs = [makeObs(1, 0.0, -5.0)];
      const strategy = new MultiSignalSearchStrategy(
        chromaMock,
        makeFtsMock(ftsResult(ftsObs))
      );

      const result = await strategy.search(defaultOptions);
      expect(result.fellBack).toBe(true);
      expect(result.usedChroma).toBe(false);
    });
  });

  describe('search — result metadata', () => {
    it('sets strategy=multi_signal, usedChroma=true, usedFTS=true on success', async () => {
      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([makeObs(1, 0.8)])),
        makeFtsMock(ftsResult([makeObs(1, 0.0, -5.0)]))
      );

      const result = await strategy.search(defaultOptions);
      expect(result.strategy).toBe('multi_signal');
      expect(result.usedChroma).toBe(true);
      expect(result.usedFTS).toBe(true);
      expect(result.fellBack).toBe(false);
    });

    it('attaches combined_score to each observation in result', async () => {
      const strategy = new MultiSignalSearchStrategy(
        makeChromaMock(chromaResult([makeObs(1, 0.8), makeObs(2, 0.5)])),
        makeFtsMock(ftsResult([]))
      );

      const result = await strategy.search(defaultOptions);
      for (const obs of result.results.observations) {
        const o = obs as ObservationSearchResult & { combined_score?: number };
        expect(o.combined_score).toBeDefined();
        expect(typeof o.combined_score).toBe('number');
      }
    });
  });
});
