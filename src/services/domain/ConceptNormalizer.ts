import { logger } from '../../utils/logger.js';
import type { ModeConfig } from './types.js';

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

/**
 * Filter a concepts array to only entries that appear in the mode's allowed set.
 *
 * Invalid concepts are dropped entirely — no alias mapping. This is intentional:
 * the LLM is instructed to use exact IDs, so an unrecognised value is noise, not
 * a mis-spelling worth salvaging. Silently correcting them would mask prompt-quality
 * problems and drift the taxonomy silently.
 *
 * Case-insensitive matching is provided because casing errors are mechanical (LLM
 * capitalisation variance) rather than semantic; the canonical ID is preserved.
 */
export function normalizeConcepts(concepts: string[], mode: ModeConfig): string[] {
  if (!Array.isArray(concepts) || concepts.length === 0) {
    return [];
  }

  const allowedById = new Map<string, string>();
  for (const concept of mode.observation_concepts) {
    if (typeof concept.id === 'string') {
      allowedById.set(toSlug(concept.id), concept.id);
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of concepts) {
    if (typeof raw !== 'string') {
      continue;
    }

    const slug = toSlug(raw);
    const canonical = allowedById.get(slug);

    if (canonical === undefined) {
      logger.debug('CONCEPT_NORMALIZER', 'Dropping invalid concept', { value: slug });
      continue;
    }

    if (seen.has(canonical)) {
      continue;
    }

    seen.add(canonical);
    result.push(canonical);
  }

  return result;
}
