
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
import { ChromaUnavailableError } from './errors.js';
import { logger } from '../../../utils/logger.js';

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

  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    return await this.executeWithFallback(options);
  }

  private async executeWithFallback(
    options: NormalizedParams
  ): Promise<StrategySearchResult> {
    if (!options.query) {
      logger.debug('SEARCH', 'Orchestrator: Filter-only query, using SQLite', {});
      return await this.sqliteStrategy.search(options);
    }

    const hint = options.strategyHint;

    if (hint === 'multi_signal') {
      if (this.multiSignalStrategy !== null && this.multiSignalStrategy.canHandle(options)) {
        logger.debug('SEARCH', 'Orchestrator: strategyHint=multi_signal, using MultiSignalSearchStrategy', {});
        return await this.multiSignalStrategy.search(options);
      }
      logger.debug('SEARCH', 'Orchestrator: strategyHint=multi_signal but strategy unavailable, degrading to auto', {});
    }

    if (hint === 'fts') {
      if (this.ftsStrategy !== null && this.ftsStrategy.canHandle(options)) {
        logger.debug('SEARCH', 'Orchestrator: strategyHint=fts, using FTSSearchStrategy', {});
        return await this.ftsStrategy.search(options);
      }
      logger.debug('SEARCH', 'Orchestrator: strategyHint=fts but FTS not available, degrading to auto', {});
    }

    if (this.multiSignalStrategy !== null && this.multiSignalStrategy.canHandle(options)) {
      logger.debug('SEARCH', 'Orchestrator: Using MultiSignalSearchStrategy (auto)', {});
      return await this.multiSignalStrategy.search(options);
    }

    if (this.chromaStrategy !== null && this.chromaStrategy.canHandle(options)) {
      logger.debug('SEARCH', 'Orchestrator: Using Chroma semantic search (FTS unavailable)', {});
      try {
        const result = await this.chromaStrategy.search(options);
        if (result.usedChroma) {
          return result;
        }
        logger.debug('SEARCH', 'Orchestrator: Chroma failed, falling back to SQLite', {});
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        throw new ChromaUnavailableError(
          `Chroma query failed: ${errorObj.message}`,
          errorObj
        );
      }

      const fallbackResult = await this.sqliteStrategy.search({
        ...options,
        query: undefined
      });
      return { ...fallbackResult, fellBack: true };
    }

    if (this.ftsStrategy !== null && this.ftsStrategy.canHandle(options)) {
      logger.debug('SEARCH', 'Orchestrator: Using FTSSearchStrategy (Chroma offline)', {});
      return await this.ftsStrategy.search(options);
    }

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

  async findByConcept(concept: string, args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByConcept(concept, options);
    }

    const results = this.sqliteStrategy.findByConcept(concept, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  async findByType(type: string | string[], args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByType(type, options);
    }

    const results = this.sqliteStrategy.findByType(type, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  async findByFile(filePath: string, args: any): Promise<{
    observations: ObservationSearchResult[];
    sessions: any[];
    usedChroma: boolean;
  }> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByFile(filePath, options);
    }

    const results = this.sqliteStrategy.findByFile(filePath, options);
    return { ...results, usedChroma: false };
  }

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

  formatSearchResults(
    results: SearchResults,
    query: string,
    chromaFailed: boolean = false
  ): string {
    return this.resultFormatter.formatSearchResults(results, query, chromaFailed);
  }

  getFormatter(): ResultFormatter {
    return this.resultFormatter;
  }

  getTimelineBuilder(): TimelineBuilder {
    return this.timelineBuilder;
  }

  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
      delete normalized.obs_type;
    }

    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }

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

  isChromaAvailable(): boolean {
    return !!this.chromaSync;
  }
}
