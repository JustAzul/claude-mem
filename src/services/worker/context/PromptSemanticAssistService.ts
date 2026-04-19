import type { SessionStore } from '../../sqlite/SessionStore.js';
import type { ChromaSync } from '../../sync/ChromaSync.js';
import type { MemoryAssistReport } from '../../../shared/memory-assist.js';
import { estimateTokens } from '../../../shared/timeline-formatting.js';
import { logger } from '../../../utils/logger.js';
import { ExperimentalRanker } from './rankers/ExperimentalRanker.js';
import { ProductionRanker } from './rankers/ProductionRanker.js';
import {
  normalizeConcepts,
  toRankedCandidate,
  type RankedSemanticMatch,
  type SemanticCandidate,
  type SemanticObservationLike,
  type SemanticRanker,
} from './rankers/types.js';

const MIN_QUERY_LENGTH = 20;
const DEFAULT_DISTANCE_THRESHOLD = 0.35;
const MAX_LOOKAHEAD_MULTIPLIER = 4;

export interface PromptSemanticAssistRequest {
  query: string;
  project?: string;
  limit?: number;
  threshold?: number;
  promptNumber?: number;
  sessionDbId?: number;
  contentSessionId?: string;
  platformSource?: string;
  /** Override Chroma doc_type filter. Defaults to 'observation'. POC/research use only. */
  docType?: string;
}

export interface PromptSemanticAssistResult {
  context: string;
  count: number;
  decision: MemoryAssistReport;
}

export class PromptSemanticAssistService {
  private readonly productionRanker: SemanticRanker;
  private readonly experimentalRanker: SemanticRanker;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly chromaSync: ChromaSync | null,
    productionRanker: SemanticRanker = new ProductionRanker(),
    experimentalRanker: SemanticRanker = new ExperimentalRanker()
  ) {
    this.productionRanker = productionRanker;
    this.experimentalRanker = experimentalRanker;
  }

  async evaluate(input: PromptSemanticAssistRequest): Promise<PromptSemanticAssistResult> {
    const query = input.query?.trim() ?? '';
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    const threshold = Number.isFinite(input.threshold)
      ? Number(input.threshold)
      : DEFAULT_DISTANCE_THRESHOLD;
    const baseDecision = {
      source: 'semantic_prompt' as const,
      project: input.project,
      platformSource: input.platformSource,
      promptNumber: input.promptNumber,
      sessionDbId: input.sessionDbId,
      contentSessionId: input.contentSessionId,
      promptLength: query.length,
      threshold,
    };

    if (query.length < MIN_QUERY_LENGTH) {
      logger.debug(`[PromptSemanticAssistService] skipped semantic recall: query too short (${query.length} chars)`);
      return {
        context: '',
        count: 0,
        decision: {
          ...baseDecision,
          status: 'skipped',
          reason: 'query_too_short',
        },
      };
    }

    if (!this.chromaSync) {
      logger.warn('[PromptSemanticAssistService] semantic recall unavailable because Chroma sync is not configured');
      return {
        context: '',
        count: 0,
        decision: {
          ...baseDecision,
          status: 'skipped',
          reason: 'semantic_search_unavailable',
        },
      };
    }

    try {
      const docType = input.docType ?? 'observation';
      const whereFilter = input.project
        ? { $and: [{ doc_type: docType }, { project: input.project }] }
        : { doc_type: docType };
      const lookaheadLimit = Math.min(limit * MAX_LOOKAHEAD_MULTIPLIER, 40);
      const chromaResults = await this.chromaSync.queryChroma(query, lookaheadLimit, whereFilter);

      if (chromaResults.ids.length === 0) {
        logger.debug('[PromptSemanticAssistService] skipped semantic recall: no matches returned by Chroma');
        return {
          context: '',
          count: 0,
          decision: {
            ...baseDecision,
            status: 'skipped',
            reason: 'no_matches',
            candidateCount: 0,
            selectedCount: 0,
          },
        };
      }

      const candidates = chromaResults.ids.map((id, index) => ({
        id,
        distance: chromaResults.distances[index] ?? Number.POSITIVE_INFINITY,
      }));

      let selectedCandidates = candidates
        .filter(candidate => candidate.distance <= threshold);

      // Exclude IDs injected within the last DEDUP_WINDOW prompts to avoid bloat.
      // After the window expires (or on session compaction), re-injection is allowed.
      const DEDUP_WINDOW = 5;
      if (input.contentSessionId && input.promptNumber != null && selectedCandidates.length > 0) {
        const recentIds = this.sessionStore.getRecentlyInjectedIds(
          input.contentSessionId, input.promptNumber, DEDUP_WINDOW
        );
        if (recentIds.size > 0) {
          selectedCandidates = selectedCandidates.filter(c => !recentIds.has(Number(c.id)));
          if (selectedCandidates.length === 0) {
            logger.debug(`[PromptSemanticAssistService] skipped semantic recall: all candidates recently injected (window=${DEDUP_WINDOW})`);
            return {
              context: '',
              count: 0,
              decision: {
                ...baseDecision,
                status: 'skipped',
                reason: 'recently_injected',
                candidateCount: candidates.length,
                selectedCount: 0,
              },
            };
          }
        }
      }

      if (selectedCandidates.length === 0) {
        const distances = candidates.map(candidate => candidate.distance).filter(Number.isFinite);
        logger.debug(
          `[PromptSemanticAssistService] skipped semantic recall: ${candidates.length} candidates but none under threshold ${threshold}`
        );
        return {
          context: '',
          count: 0,
          decision: {
            ...baseDecision,
            status: 'skipped',
            reason: 'below_threshold',
            candidateCount: candidates.length,
            selectedCount: 0,
            bestDistance: distances.length > 0 ? Math.min(...distances) : null,
            worstDistance: distances.length > 0 ? Math.max(...distances) : null,
          },
        };
      }

      if (docType === 'session_summary') {
        const summaryIds = selectedCandidates.map(c => Number(c.id)).filter(n => Number.isFinite(n) && n > 0);
        const summaries = this.sessionStore.getSessionSummariesByIds(summaryIds, { orderBy: 'date_desc' }).slice(0, limit);

        if (summaries.length === 0) {
          logger.warn('[PromptSemanticAssistService] skipped summary recall: hydration miss');
          return {
            context: '',
            count: 0,
            decision: {
              ...baseDecision,
              source: 'semantic_summary' as const,
              status: 'skipped',
              reason: 'hydration_miss',
              candidateCount: candidates.length,
              selectedCount: 0,
            },
          };
        }

        const lines: string[] = ['## Relevant Past Work (session summary)\n'];
        for (const s of summaries) {
          const date = (s.created_at as string | undefined)?.slice(0, 10) || '';
          lines.push(`### Session: ${s.project} (${date})`);
          if (s.investigated) lines.push(`**Investigated:** ${s.investigated}`);
          if (s.completed) lines.push(`**Completed:** ${s.completed}`);
          if (s.learned) lines.push(`**Learned:** ${s.learned}`);
          lines.push('');
        }
        const summaryContext = lines.join('\n');
        const selectedDistances = selectedCandidates.map(c => c.distance).filter(Number.isFinite);
        return {
          context: summaryContext,
          count: summaries.length,
          decision: {
            ...baseDecision,
            source: 'semantic_summary' as const,
            status: 'injected',
            reason: 'semantic_match',
            candidateCount: candidates.length,
            selectedCount: summaries.length,
            selectedIds: summaryIds,
            bestDistance: selectedDistances.length > 0 ? Math.min(...selectedDistances) : null,
            worstDistance: selectedDistances.length > 0 ? Math.max(...selectedDistances) : null,
            estimatedInjectedTokens: estimateTokens(summaryContext),
          },
        };
      }

      const observations = this.sessionStore.getObservationsByIds(
        selectedCandidates.map(candidate => candidate.id),
        { orderBy: 'date_desc' }
      );
      const byID = new Map<number, SemanticObservationLike>(observations.map((observation) => [observation.id, observation]));
      const rankedMatches = this.productionRanker.rank(selectedCandidates, byID, threshold, limit);
      const shadowMatches = this.experimentalRanker.rank(selectedCandidates, byID, threshold, limit);
      const selectedObservations = rankedMatches.map((match) => match.observation);

      if (selectedObservations.length === 0) {
        logger.warn('[PromptSemanticAssistService] skipped semantic recall: selected candidates could not be hydrated from SQLite');
        return {
          context: '',
          count: 0,
          decision: {
            ...baseDecision,
            status: 'skipped',
            reason: 'hydration_miss',
            candidateCount: candidates.length,
            selectedCount: 0,
          },
        };
      }

      const lines: string[] = ['## Relevant Past Work (semantic match)\n'];
      for (const observation of selectedObservations) {
        const date = observation.created_at?.slice(0, 10) || '';
        lines.push(`### ${observation.title || 'Observation'} (${date})`);
        if (observation.narrative) {
          lines.push(observation.narrative);
        } else if (observation.text) {
          lines.push(observation.text);
        } else if (observation.facts) {
          lines.push(observation.facts);
        }
        lines.push('');
      }
      const context = lines.join('\n');

      const selectedDistances = rankedMatches.map(candidate => candidate.distance).filter(Number.isFinite);
      logger.debug(
        `[PromptSemanticAssistService] injected ${selectedObservations.length} semantic memories from ${candidates.length} candidates`
      );
      return {
        context,
        count: selectedObservations.length,
        decision: {
          ...baseDecision,
          status: 'injected',
          reason: 'semantic_match',
          candidateCount: candidates.length,
          selectedCount: selectedObservations.length,
          selectedIds: rankedMatches.map(m => m.observation.id),
          bestDistance: selectedDistances.length > 0 ? Math.min(...selectedDistances) : null,
          worstDistance: selectedDistances.length > 0 ? Math.max(...selectedDistances) : null,
          estimatedInjectedTokens: estimateTokens(context),
          shadowRanking: {
            productionRankerId: this.productionRanker.id,
            experimentalRankerId: this.experimentalRanker.id,
            productionCandidates: rankedMatches.map(toRankedCandidate),
            experimentalCandidates: shadowMatches.map(toRankedCandidate),
            productionSelectedObservationIds: rankedMatches.map((match) => match.observation.id),
            experimentalSelectedObservationIds: shadowMatches.map((match) => match.observation.id),
          },
          traceItems: rankedMatches
            .map(match => {
              const observation = match.observation;
              return {
                observationId: observation.id,
                title: observation.title,
                type: observation.type,
                createdAtEpoch: observation.created_at_epoch,
                distance: Number.isFinite(match.distance) ? match.distance : null,
                filePath: [...(toRankedCandidate(match).relatedFilePaths ?? [])][0] ?? null,
                relatedFilePaths: toRankedCandidate(match).relatedFilePaths,
                concepts: normalizeConcepts(observation),
                score: match.score,
              };
            })
            .filter((item): item is NonNullable<typeof item> => item != null),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[PromptSemanticAssistService] semantic recall failed: ${message}`);
      return {
        context: '',
        count: 0,
        decision: {
          ...baseDecision,
          status: 'error',
          reason: 'semantic_query_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
