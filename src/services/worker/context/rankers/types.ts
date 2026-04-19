import { parseFileList } from '../../../sqlite/observations/files.js';
import type { MemoryAssistRankedCandidate } from '../../../../shared/memory-assist.js';

export interface SemanticCandidate {
  id: number;
  distance: number;
}

export interface SemanticObservationLike {
  id: number;
  title?: string | null;
  type?: string | null;
  narrative?: string | null;
  text?: string | null;
  facts?: string | null;
  concepts?: string | null;
  files_read?: string | null;
  files_modified?: string | null;
  created_at_epoch?: number;
  relevance_count?: number | null;
}

export interface RankedSemanticMatch extends SemanticCandidate {
  observation: SemanticObservationLike;
  score: number;
}

export interface SemanticRanker {
  readonly id: string;
  rank(
    candidates: SemanticCandidate[],
    observationsById: Map<number, SemanticObservationLike>,
    threshold: number,
    limit: number
  ): RankedSemanticMatch[];
}

export function isGenericTitle(title?: string | null): boolean {
  const normalized = title?.trim().toLowerCase() ?? '';
  return normalized === '' || normalized === 'observation' || normalized === 'untitled';
}

export function computeRecencyScore(createdAtEpoch?: number): number {
  if (!createdAtEpoch || !Number.isFinite(createdAtEpoch)) return 0;
  const recentMemoryWindowMs = 30 * 24 * 60 * 60 * 1000;
  const ageMs = Math.max(0, Date.now() - createdAtEpoch);
  if (ageMs <= recentMemoryWindowMs) {
    return 1 - ageMs / recentMemoryWindowMs;
  }
  return 0;
}

export function computeSpecificityScore(observation: SemanticObservationLike): number {
  const filesRead = parseFileList(observation?.files_read);
  const filesModified = parseFileList(observation?.files_modified);
  const totalFiles = filesRead.length + filesModified.length;
  let score = 0;

  if (filesModified.length > 0) score += 1;
  if (totalFiles > 0 && totalFiles <= 3) score += 1;
  else if (totalFiles > 8) score -= 0.5;
  if (!isGenericTitle(observation?.title)) score += 0.5;
  if (observation?.narrative) score += 0.25;

  return Math.max(0, score);
}

export function computeReuseScore(observation: SemanticObservationLike): number {
  const relevanceCount = Number(observation?.relevance_count ?? 0);
  if (!Number.isFinite(relevanceCount) || relevanceCount <= 0) return 0;
  return Math.min(relevanceCount, 5) / 5;
}

export function normalizeConcepts(observation: SemanticObservationLike): string[] {
  if (!observation?.concepts) return [];
  try {
    const parsed = JSON.parse(observation.concepts);
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    }
  } catch {
    // Fall back to a best-effort token split for legacy rows.
  }

  return observation.concepts
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function toRankedCandidate(match: RankedSemanticMatch): MemoryAssistRankedCandidate {
  const filesRead = parseFileList(match.observation.files_read);
  const filesModified = parseFileList(match.observation.files_modified);

  return {
    observationId: match.observation.id,
    distance: Number.isFinite(match.distance) ? match.distance : null,
    score: match.score,
    title: match.observation.title,
    type: match.observation.type,
    createdAtEpoch: match.observation.created_at_epoch,
    relatedFilePaths: [...new Set([...filesModified, ...filesRead])],
    concepts: normalizeConcepts(match.observation),
  };
}
