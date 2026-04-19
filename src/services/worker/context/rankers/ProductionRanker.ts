import {
  computeRecencyScore,
  computeReuseScore,
  computeSpecificityScore,
  type RankedSemanticMatch,
  type SemanticCandidate,
  type SemanticObservationLike,
  type SemanticRanker,
} from './types.js';
import { logger } from '../../../../utils/logger.js';

const DISTANCE_WEIGHT = 100;
const RECENCY_WEIGHT = 12;
const SPECIFICITY_WEIGHT = 8;
const REUSE_WEIGHT = 4;

function scoreCandidate(
  candidate: SemanticCandidate,
  observation: SemanticObservationLike,
  threshold: number
): number {
  const closeness = threshold > 0
    ? Math.max(0, 1 - (candidate.distance / threshold))
    : 0;
  const recency = computeRecencyScore(observation?.created_at_epoch);
  const specificity = computeSpecificityScore(observation);
  const reuse = computeReuseScore(observation);

  return (
    closeness * DISTANCE_WEIGHT +
    recency * RECENCY_WEIGHT +
    specificity * SPECIFICITY_WEIGHT +
    reuse * REUSE_WEIGHT
  );
}

export class ProductionRanker implements SemanticRanker {
  readonly id = 'production_v1';

  rank(
    candidates: SemanticCandidate[],
    observationsById: Map<number, SemanticObservationLike>,
    threshold: number,
    limit: number
  ): RankedSemanticMatch[] {
    const ranked = candidates
      .map((candidate) => {
        const observation = observationsById.get(candidate.id);
        if (!observation) return null;
        return {
          ...candidate,
          observation,
          score: scoreCandidate(candidate, observation, threshold),
        };
      })
      .filter((match): match is RankedSemanticMatch => match != null)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.distance - right.distance;
      })
      .slice(0, limit);
    logger.debug(
      `[ProductionRanker] ranked ${ranked.length}/${candidates.length} candidates at threshold ${threshold} (limit=${limit})`
    );
    return ranked;
  }
}
