/**
 * SearchOrchestrator - Coordinates search strategies and handles fallback logic
 *
 * This is the main entry point for search operations. It:
 * 1. Normalizes input parameters
 * 2. Selects the appropriate strategy
 * 3. Executes the search
 * 4. Handles fallbacks on failure
 * 5. Delegates to formatters for output
 */

import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { ChromaSync } from '../../sync/ChromaSync.js';

import { ChromaSearchStrategy } from './strategies/ChromaSearchStrategy.js';
import { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';
import { HybridSearchStrategy } from './strategies/HybridSearchStrategy.js';
import { FTSSearchStrategy } from './strategies/FTSSearchStrategy.js';
import { MultiSignalSearchStrategy } from './strategies/MultiSignalSearchStrategy.js';

import { ResultFormatter } from './ResultFormatter.js';
import { TimelineBuilder } from './TimelineBuilder.js';
import type { TimelineItem, TimelineData } from './TimelineBuilder.js';

import {
  SEARCH_CONSTANTS,
} from './types.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  SearchResults,
  ObservationSearchResult
} from './types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Normalized parameters from URL-friendly format
 */
interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
}

export class SearchOrchestrator {
  private chromaStrategy: ChromaSearchStrategy | null = null;
  private sqliteStrategy: SQLiteSearchStrategy;
  private hybridStrategy: HybridSearchStrategy | null = null;
  private ftsStrategy: FTSSearchStrategy | null = null;
  private multiSignalStrategy: MultiSignalSearchStrategy | null = null;
  private resultFormatter: ResultFormatter;
  private timelineBuilder: TimelineBuilder;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync | null
  ) {
    // Initialize strategies
    this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);

    if (chromaSync) {
      this.chromaStrategy = new ChromaSearchStrategy(chromaSync, sessionStore);
      this.hybridStrategy = new HybridSearchStrategy(chromaSync, sessionStore, sessionSearch);
    }

    // FTS strategy is always instantiated when sessionStore + sessionSearch are present.
    // The strategy itself gates execution on FTS5 table availability (checkFTSAvailable).
    this.ftsStrategy = new FTSSearchStrategy(sessionStore, sessionSearch);

    // MultiSignal requires both Chroma and FTS
    if (this.chromaStrategy !== null && this.ftsStrategy !== null) {
      this.multiSignalStrategy = new MultiSignalSearchStrategy(this.chromaStrategy, this.ftsStrategy);
    }

    this.resultFormatter = new ResultFormatter();
    this.timelineBuilder = new TimelineBuilder();
  }

  /**
   * Main search entry point
   */
  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    // Decision tree for strategy selection
    return await this.executeWithFallback(options);
  }

  /**
   * Execute search with fallback logic
   *
   * Decision tree:
   *   PATH 1:  no query                             → SQLite (filter-only)
   *   PATH 2a: query + strategyHint=multi_signal    → MultiSignalSearchStrategy (if available, else graceful degrade)
   *   PATH 2b: query + strategyHint=fts             → FTSSearchStrategy (forced)
   *   PATH 2c: query + multiSignalStrategy avail    → MultiSignalSearchStrategy (auto)
   *   PATH 2d: query + Chroma only                  → ChromaSearchStrategy
   *   PATH 2e: query + FTS only                     → FTSSearchStrategy (Chroma offline)
   *   PATH 3:  all strategies failed/unavail        → SQLite fallback
   */
  private async executeWithFallback(
    options: NormalizedParams
  ): Promise<StrategySearchResult> {
    // PATH 1: FILTER-ONLY (no query text) — use SQLite regardless of hint
    if (!options.query) {
      logger.debug('SEARCH', 'Orchestrator: Filter-only query, using SQLite', {});
      return await this.sqliteStrategy.search(options);
    }

    const hint = options.strategyHint;

    // PATH 2a: Explicit multi_signal hint
    if (hint === 'multi_signal') {
      if (this.multiSignalStrategy !== null && this.multiSignalStrategy.canHandle(options)) {
        logger.debug('SEARCH', 'Orchestrator: strategyHint=multi_signal, using MultiSignalSearchStrategy', {});
        return await this.multiSignalStrategy.search(options);
      }
      // Graceful degrade: multi_signal unavailable, fall through to auto-routing
      logger.debug('SEARCH', 'Orchestrator: strategyHint=multi_signal but strategy unavailable, degrading to auto', {});
    }

    // PATH 2b: Explicit fts hint
    if (hint === 'fts') {
      if (this.ftsStrategy !== null && this.ftsStrategy.canHandle(options)) {
        logger.debug('SEARCH', 'Orchestrator: strategyHint=fts, using FTSSearchStrategy', {});
        return await this.ftsStrategy.search(options);
      }
      // FTS unavailable, fall through to auto-routing
      logger.debug('SEARCH', 'Orchestrator: strategyHint=fts but FTS not available, degrading to auto', {});
    }

    // PATH 2c: Auto-routing — multi_signal (Chroma + FTS both available)
    if (this.multiSignalStrategy !== null && this.multiSignalStrategy.canHandle(options)) {
      logger.debug('SEARCH', 'Orchestrator: Using MultiSignalSearchStrategy (auto)', {});
      return await this.multiSignalStrategy.search(options);
    }

    // PATH 2d: Auto-routing — Chroma only (FTS unavailable or uninitialized)
    if (this.chromaStrategy !== null && this.chromaStrategy.canHandle(options)) {
      logger.debug('SEARCH', 'Orchestrator: Using Chroma semantic search (FTS unavailable)', {});
      const result = await this.chromaStrategy.search(options);

      if (result.usedChroma) {
        return result;
      }

      // Chroma returned but marked failure — fall to SQLite
      logger.debug('SEARCH', 'Orchestrator: Chroma failed, falling back to SQLite', {});
      const fallbackResult = await this.sqliteStrategy.search({
        ...options,
        query: undefined // Remove query for SQLite fallback
      });

      return {
        ...fallbackResult,
        fellBack: true
      };
    }

    // PATH 2e: Auto-routing — FTS only (Chroma offline)
    if (this.ftsStrategy !== null && this.ftsStrategy.canHandle(options)) {
      logger.debug('SEARCH', 'Orchestrator: Using FTSSearchStrategy (Chroma offline)', {});
      return await this.ftsStrategy.search(options);
    }

    // PATH 3: All strategies failed/unavailable — SQLite fallback (no query)
    logger.debug('SEARCH', 'Orchestrator: No strategy available, falling back to SQLite (no query)', {});
    const fallbackResult = await this.sqliteStrategy.search({
      ...options,
      query: undefined
    });

    return {
      ...fallbackResult,
      fellBack: true,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by concept with hybrid search
   */
  async findByConcept(concept: string, args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByConcept(concept, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByConcept(concept, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by type with hybrid search
   */
  async findByType(type: string | string[], args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByType(type, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByType(type, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by file with hybrid search
   */
  async findByFile(filePath: string, args: any): Promise<{
    observations: ObservationSearchResult[];
    sessions: any[];
    usedChroma: boolean;
  }> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByFile(filePath, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByFile(filePath, options);
    return { ...results, usedChroma: false };
  }

  /**
   * Get timeline around anchor
   */
  getTimeline(
    timelineData: TimelineData,
    anchorId: number | string,
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number
  ): TimelineItem[] {
    const items = this.timelineBuilder.buildTimeline(timelineData);
    return this.timelineBuilder.filterByDepth(items, anchorId, anchorEpoch, depthBefore, depthAfter);
  }

  /**
   * Format timeline for display
   */
  formatTimeline(
    items: TimelineItem[],
    anchorId: number | string | null,
    options: {
      query?: string;
      depthBefore?: number;
      depthAfter?: number;
    } = {}
  ): string {
    return this.timelineBuilder.formatTimeline(items, anchorId, options);
  }

  /**
   * Format search results for display
   */
  formatSearchResults(
    results: SearchResults,
    query: string,
    chromaFailed: boolean = false
  ): string {
    return this.resultFormatter.formatSearchResults(results, query, chromaFailed);
  }

  /**
   * Get result formatter for direct access
   */
  getFormatter(): ResultFormatter {
    return this.resultFormatter;
  }

  /**
   * Get timeline builder for direct access
   */
  getTimelineBuilder(): TimelineBuilder {
    return this.timelineBuilder;
  }

  /**
   * Normalize query parameters from URL-friendly format
   */
  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    // Parse comma-separated concepts into array
    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated files into array
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated obs_type into array
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
      delete normalized.obs_type;
    }

    // Parse comma-separated type (for filterSchema) into array
    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Map 'type' param to 'searchType' for API consistency
    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }

    // Flatten dateStart/dateEnd into dateRange object
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    return normalized;
  }

  /**
   * Check if Chroma is available
   */
  isChromaAvailable(): boolean {
    return !!this.chromaSync;
  }
}
