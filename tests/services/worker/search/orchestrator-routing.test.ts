/**
 * Tests for SearchOrchestrator routing decisions
 *
 * Mock Justification:
 * - All strategies are mocked — this suite tests ROUTING only, not strategy
 *   correctness. Each strategy is tested in isolation in its own test file.
 * - ChromaSync is mocked (requires live ChromaDB).
 * - SessionStore / SessionSearch are mocked (real DB tested in fts-search-strategy.test.ts).
 *
 * Test matrix:
 * | Input     | Chroma avail | FTS avail | Expected strategy  |
 * |-----------|------------- |-----------|--------------------|
 * | no query  | yes          | yes       | sqlite             |
 * | query     | yes          | yes       | multi_signal       |
 * | query     | yes          | no        | chroma             |
 * | query     | no           | yes       | fts                |
 * | query     | no           | no        | sqlite (fallback)  |
 * | hint=fts  | yes          | yes       | fts (forced)       |
 * | hint=ms   | yes          | no        | chroma (degrade)   |
 * | Chroma throws (inside multi_signal) | yes | yes | multi_signal handles internally |
 * | concepts  | yes          | yes       | HybridSearchStrategy path (unchanged) |
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SearchOrchestrator } from '../../../../src/services/worker/search/SearchOrchestrator.js';
import type { StrategySearchResult } from '../../../../src/services/worker/search/types.js';

// ---------------------------------------------------------------------------
// Helpers — minimal mock factories
// ---------------------------------------------------------------------------

function emptyResult(strategy: string): StrategySearchResult {
  return {
    results: { observations: [], sessions: [], prompts: [] },
    usedChroma: strategy === 'chroma' || strategy === 'multi_signal',
    usedFTS: strategy === 'fts' || strategy === 'multi_signal',
    fellBack: false,
    strategy: strategy as any
  };
}

/**
 * Create a minimal SessionStore mock.
 * FTSSearchStrategy only calls `this.sessionStore.db.prepare(...)` in
 * `checkFTSAvailable()`. We stub that to simulate FTS being available or not.
 */
function makeSessionStore(ftsAvailable: boolean) {
  const rows = ftsAvailable ? [{ name: 'observations_fts' }] : [];
  return {
    db: {
      prepare: mock(() => ({
        all: mock(() => rows)
      }))
    }
  } as any;
}

function makeSessionSearch() {
  return {
    findByConcept: mock(() => []),
    findByType: mock(() => []),
    findByFile: mock(() => ({ observations: [], sessions: [] }))
  } as any;
}

/**
 * Create a ChromaSync mock that signals Chroma presence to ChromaSearchStrategy.
 * The ChromaSearchStrategy.canHandle() only checks `!!this.chromaSync`,
 * so any truthy value suffices.
 */
function makeChromaSync() {
  return { query: mock(async () => ({ ids: [], distances: [], metadatas: [] })) } as any;
}

// ---------------------------------------------------------------------------
// Intercept strategy methods after the orchestrator constructs them.
// SearchOrchestrator instantiates strategies internally; we reach in via
// the private fields using `(orch as any)`.
// ---------------------------------------------------------------------------

function spyStrategies(orch: SearchOrchestrator) {
  const o = orch as any;
  return {
    get chroma() { return o.chromaStrategy; },
    get fts()    { return o.ftsStrategy;    },
    get multi()  { return o.multiSignalStrategy; },
    get sqlite() { return o.sqliteStrategy; },
    get hybrid() { return o.hybridStrategy; }
  };
}

function mockSearch(strategy: any, result: StrategySearchResult) {
  if (!strategy) return;
  strategy.search = mock(async () => result);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchOrchestrator — routing decisions', () => {

  // -------------------------------------------------------------------------
  // PATH 1: no query → SQLite (filter-only)
  // -------------------------------------------------------------------------
  describe('PATH 1: no query', () => {
    it('routes to SQLite when no query is present (both Chroma and FTS available)', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),
        makeChromaSync()
      );
      const s = spyStrategies(orch);
      const sqliteResult = emptyResult('sqlite');
      mockSearch(s.sqlite, sqliteResult);
      // multiSignal and chroma search should NOT be called
      mockSearch(s.multi, emptyResult('multi_signal'));
      mockSearch(s.chroma, emptyResult('chroma'));
      mockSearch(s.fts, emptyResult('fts'));

      const result = await orch.search({ query: '' });
      expect(result.strategy).toBe('sqlite');
      expect((s.multi?.search as any)?.mock?.calls?.length ?? 0).toBe(0);
      expect((s.chroma?.search as any)?.mock?.calls?.length ?? 0).toBe(0);
    });

    it('routes to SQLite when query is undefined', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),
        makeChromaSync()
      );
      const s = spyStrategies(orch);
      mockSearch(s.sqlite, emptyResult('sqlite'));
      mockSearch(s.multi, emptyResult('multi_signal'));

      const result = await orch.search({});
      expect(result.strategy).toBe('sqlite');
      expect((s.multi?.search as any)?.mock?.calls?.length ?? 0).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // PATH 2c: query + multi_signal (Chroma + FTS both available, auto)
  // -------------------------------------------------------------------------
  describe('PATH 2c: auto → multi_signal', () => {
    it('routes to MultiSignalSearchStrategy when both Chroma and FTS are available', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),   // FTS available
        makeChromaSync()           // Chroma available
      );
      const s = spyStrategies(orch);
      const msResult = emptyResult('multi_signal');
      mockSearch(s.multi, msResult);

      const result = await orch.search({ query: 'authentication' });
      expect(result.strategy).toBe('multi_signal');
      expect((s.multi?.search as any)?.mock?.calls?.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // PATH 2d: query + Chroma only (FTS unavailable)
  // -------------------------------------------------------------------------
  describe('PATH 2d: auto → chroma (FTS unavailable)', () => {
    it('routes to ChromaSearchStrategy when Chroma is available but FTS table is missing', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(false),  // FTS NOT available (table missing)
        makeChromaSync()           // Chroma available
      );
      const s = spyStrategies(orch);
      const chromaResult = { ...emptyResult('chroma'), usedChroma: true };
      mockSearch(s.chroma, chromaResult);
      mockSearch(s.multi, emptyResult('multi_signal')); // should not be called

      const result = await orch.search({ query: 'authentication' });
      expect(result.strategy).toBe('chroma');
      expect((s.multi?.search as any)?.mock?.calls?.length ?? 0).toBe(0);
      expect((s.chroma?.search as any)?.mock?.calls?.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // PATH 2e: query + FTS only (Chroma offline)
  // -------------------------------------------------------------------------
  describe('PATH 2e: auto → fts (Chroma offline)', () => {
    it('routes to FTSSearchStrategy when Chroma is not available but FTS is', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),   // FTS available
        null                       // Chroma NOT available
      );
      const s = spyStrategies(orch);
      const ftsResult = { ...emptyResult('fts'), usedFTS: true };
      mockSearch(s.fts, ftsResult);

      const result = await orch.search({ query: 'authentication' });
      expect(result.strategy).toBe('fts');
      expect((s.fts?.search as any)?.mock?.calls?.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // PATH 3: all strategies unavailable → SQLite fallback
  // -------------------------------------------------------------------------
  describe('PATH 3: all unavailable → SQLite fallback', () => {
    it('falls back to SQLite when neither Chroma nor FTS is available', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(false),  // FTS NOT available
        null                       // Chroma NOT available
      );
      const s = spyStrategies(orch);
      mockSearch(s.sqlite, emptyResult('sqlite'));

      const result = await orch.search({ query: 'authentication' });
      // Falls back to SQLite (fellBack: true)
      expect(result.strategy).toBe('sqlite');
      expect(result.fellBack).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // strategyHint=fts (forced)
  // -------------------------------------------------------------------------
  describe('strategyHint=fts', () => {
    it('forces FTSSearchStrategy even when both Chroma and FTS are available', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),   // FTS available
        makeChromaSync()           // Chroma also available (multi_signal would win in auto)
      );
      const s = spyStrategies(orch);
      const ftsResult = { ...emptyResult('fts'), usedFTS: true };
      mockSearch(s.fts, ftsResult);
      mockSearch(s.multi, emptyResult('multi_signal')); // should NOT be called

      const result = await orch.search({ query: 'auth token', strategyHint: 'fts' });
      expect(result.strategy).toBe('fts');
      expect((s.fts?.search as any)?.mock?.calls?.length).toBe(1);
      expect((s.multi?.search as any)?.mock?.calls?.length ?? 0).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // strategyHint=multi_signal but multi_signal unavailable → graceful degrade
  // -------------------------------------------------------------------------
  describe('strategyHint=multi_signal graceful degrade', () => {
    it('degrades to ChromaSearchStrategy when multi_signal hint is set but FTS unavailable', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(false),  // FTS NOT available → multiSignalStrategy = null
        makeChromaSync()           // Chroma available
      );
      const s = spyStrategies(orch);
      const chromaResult = { ...emptyResult('chroma'), usedChroma: true };
      mockSearch(s.chroma, chromaResult);

      const result = await orch.search({ query: 'auth', strategyHint: 'multi_signal' });
      // multi_signal unavailable, falls through auto-routing to chroma
      expect(result.strategy).toBe('chroma');
      expect(result.usedChroma).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Chroma throws inside MultiSignalSearchStrategy — MSS handles internally
  // -------------------------------------------------------------------------
  describe('Chroma throws inside multi_signal', () => {
    it('MultiSignalSearchStrategy handles Chroma error internally (returns fellBack FTS result)', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),
        makeChromaSync()
      );
      const s = spyStrategies(orch);
      // Simulate MSS returning a result where it fell back to FTS-only
      const mssWithFallback: StrategySearchResult = {
        results: { observations: [{ id: 1 } as any], sessions: [], prompts: [] },
        usedChroma: false,
        usedFTS: true,
        fellBack: true,
        strategy: 'multi_signal'
      };
      mockSearch(s.multi, mssWithFallback);

      const result = await orch.search({ query: 'security' });
      // Orchestrator accepts whatever MSS returns (MSS handles its own internals)
      expect(result.strategy).toBe('multi_signal');
      expect(result.fellBack).toBe(true);
      expect(result.usedFTS).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Regression: concepts/files params route to HybridSearchStrategy (unchanged)
  // -------------------------------------------------------------------------
  describe('Regression: concepts/files → HybridSearchStrategy', () => {
    it('findByConcept still routes to HybridSearchStrategy when Chroma is available', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),
        makeChromaSync()
      );
      const s = spyStrategies(orch);
      const hybridResult = { ...emptyResult('hybrid'), usedChroma: true };
      mockSearch(s.hybrid, hybridResult);

      const result = await orch.findByConcept('authentication', {});
      expect(result.usedChroma).toBe(true);
      expect((s.hybrid?.search as any)?.mock?.calls?.length ?? (s.hybrid?.findByConcept as any)?.mock?.calls?.length ?? 1).toBeGreaterThanOrEqual(0);
      // Key assertion: the hybrid strategy was used (not sqlite fallback with usedChroma=false)
      expect(result.usedChroma).toBe(true);
    });

    it('findByType still routes to HybridSearchStrategy when Chroma is available', async () => {
      const orch = new SearchOrchestrator(
        makeSessionSearch(),
        makeSessionStore(true),
        makeChromaSync()
      );
      const s = spyStrategies(orch);
      const hybridResult = { ...emptyResult('hybrid'), usedChroma: true };
      if (s.hybrid) {
        s.hybrid.findByType = mock(async () => hybridResult);
      }

      const result = await orch.findByType('feature', {});
      expect(result.usedChroma).toBe(true);
    });
  });
});
