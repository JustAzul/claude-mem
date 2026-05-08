
import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';
import { normalizeObservationType } from '../services/domain/ObservationTypeNormalizer.js';

// TODO(#2233): migrate to Anthropic tool-use API for deterministic JSON output. This text-XML path is the bridge.
// Only strip fences when the entire payload is a single fenced block. Stripping
// the first opening + last closing fence anywhere in the string can corrupt
// content that contains internal fenced examples or surrounding prose
// (CodeRabbit review on PR #2282).
function stripCodeFences(text: string): string {
  const match = text.match(/^\s*```(?:xml)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : text;
}

export interface ParsedObservation {
  type: string;
  original_type?: string | null;
  normalized_type_strategy?: 'alias' | 'fallback' | null;
  fallback_type?: string | null;
  pre_gate_type?: string | null;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  why: string | null;
  alternatives_rejected: string | null;
  related_observation_ids: number[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  skipped?: boolean;
  skip_reason?: string | null;
}

export type ParseResult =
  | { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null }
  | { valid: false };

export function parseAgentXml(raw: string, correlationId?: string | number): ParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false };
  }

  raw = stripCodeFences(raw);

  const skipMatch = /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/.exec(raw);
  if (skipMatch) {
    return {
      valid: true,
      observations: [],
      summary: {
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        skipped: true,
        skip_reason: skipMatch[1] ?? null,
      },
    };
  }

  const firstRoot = /<(observation|summary)\b/i.exec(raw);
  if (!firstRoot) {
    return { valid: false };
  }

  const rootName = firstRoot[1].toLowerCase();
  if (rootName === 'observation') {
    const observations = parseObservationBlocks(raw, correlationId);
    if (observations.length === 0) {
      return { valid: false };
    }
    return { valid: true, observations, summary: null };
  }

  const summary = parseSummaryBlock(raw, correlationId);
  if (!summary) {
    return { valid: false };
  }
  return { valid: true, observations: [], summary };
}

function parseObservationBlocks(text: string, correlationId?: string | number): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    const type = extractField(obsContent, 'type');
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');
    const why = extractField(obsContent, 'why');
    const alternatives_rejected = extractField(obsContent, 'alternatives_rejected');

    // related is an array of <id>integer</id> inside <related>...</related>
    const relatedRaw = extractArrayElements(obsContent, 'related', 'id');
    const related_observation_ids: number[] = [];
    for (const raw of relatedRaw) {
      const n = Number.parseInt(String(raw).trim(), 10);
      if (Number.isInteger(n) && n > 0) related_observation_ids.push(n);
    }

    // All fields except type are nullable in schema.
    // If type is missing or invalid, use first type from mode as fallback.

    const mode = ModeManager.getInstance().getActiveMode();
    const normalization = normalizeObservationType(mode, type);
    const finalType = normalization.finalType;

    if (normalization.originalType == null) {
      logger.error('PARSER', `Observation missing type field, using "${normalization.fallbackType}"`, { correlationId });
    } else if (normalization.normalizedFromAlias) {
      logger.warn('PARSER', `Normalized observation type: ${normalization.originalType} -> "${normalization.finalType}"`, {
        correlationId,
      });
    } else if (normalization.usedFallback) {
      logger.error('PARSER', `Invalid observation type: ${normalization.originalType}, using "${normalization.fallbackType}"`, { correlationId });
    }

    const cleanedConcepts = concepts.filter(c => c !== finalType);

    if (cleanedConcepts.length !== concepts.length) {
      logger.debug('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }

    if (cleanedConcepts.length === 0) {
      logger.warn('PARSER', 'Observation has empty concepts — LLM may have omitted <concepts> block', {
        correlationId,
        type: finalType,
        title
      });
    }

    // Skip ghost observations — records where every content field is null/empty.
    // These accumulate when the LLM emits a bare <observation/> (or one with only <type>)
    // due to context overflow. They carry no information and pollute the context window.
    // (subtitle and file lists are intentionally excluded from this guard: an observation
    // with only a subtitle is still too thin to be useful on its own.)
    if (!title && !narrative && facts.length === 0 && cleanedConcepts.length === 0) {
      logger.warn('PARSER', 'Skipping empty observation (all content fields null)', {
        correlationId,
        type: finalType
      });
      continue;
    }

    observations.push({
      type: finalType,
      original_type: normalization.originalType,
      normalized_type_strategy: normalization.normalizedFromAlias ? 'alias' : normalization.usedFallback ? 'fallback' : null,
      fallback_type: normalization.fallbackType,
      title,
      subtitle,
      facts,
      narrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified,
      why,
      alternatives_rejected,
      related_observation_ids
    });
  }

  return observations;
}

function parseSummaryBlock(text: string, correlationId?: string | number): ParsedSummary | null {
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);
  if (!summaryMatch) return null;

  const summaryContent = summaryMatch[1];

  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); 

  if (!request && !investigated && !learned && !completed && !next_steps) {
    logger.warn('PARSER', 'Summary block has no sub-tags — rejecting false positive', { correlationId });
    return null;
  }

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes,
  };
}

function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = match[1].trim();
  return trimmed === '' ? null : trimmed;
}

function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  const arrayRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`);
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  const elementRegex = new RegExp(`<${elementName}>([\\s\\S]*?)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    const trimmed = elementMatch[1].trim();
    if (trimmed) {
      elements.push(trimmed);
    }
  }

  return elements;
}
