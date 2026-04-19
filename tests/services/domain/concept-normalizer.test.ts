import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';
import { normalizeConcepts } from '../../../src/services/domain/ConceptNormalizer.js';
import type { ModeConfig } from '../../../src/services/domain/types.js';

const CODE_MODE: ModeConfig = {
  name: 'code',
  description: 'Code mode',
  version: '1.0.0',
  observation_types: [{ id: 'discovery', label: 'Discovery', description: '', emoji: '', work_emoji: '' }],
  observation_concepts: [
    { id: 'how-it-works', label: 'How It Works', description: '' },
    { id: 'why-it-exists', label: 'Why It Exists', description: '' },
    { id: 'what-changed', label: 'What Changed', description: '' },
    { id: 'problem-solution', label: 'Problem-Solution', description: '' },
    { id: 'gotcha', label: 'Gotcha', description: '' },
    { id: 'pattern', label: 'Pattern', description: '' },
    { id: 'trade-off', label: 'Trade-Off', description: '' },
  ],
  prompts: {} as ModeConfig['prompts'],
};

describe('normalizeConcepts', () => {
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(s => s.mockRestore());
  });

  it('all-valid concepts pass through unchanged', () => {
    const result = normalizeConcepts(['how-it-works', 'gotcha', 'pattern'], CODE_MODE);
    expect(result).toEqual(['how-it-works', 'gotcha', 'pattern']);
  });

  it('invalid concepts are dropped (documentation, workflow, ui, code-path, error)', () => {
    const result = normalizeConcepts(
      ['documentation', 'workflow', 'ui', 'code-path', 'error'],
      CODE_MODE
    );
    expect(result).toEqual([]);
  });

  it('invalid concepts dropped and no alias substitution performed', () => {
    // 'analysis' maps to 'discovery' in ObservationTypeNormalizer but should NOT be aliased here
    const result = normalizeConcepts(['analysis'], CODE_MODE);
    expect(result).toEqual([]);
  });

  it('mixed valid and invalid — only valid kept', () => {
    const result = normalizeConcepts(['how-it-works', 'invalid-concept', 'pattern'], CODE_MODE);
    expect(result).toEqual(['how-it-works', 'pattern']);
  });

  it('duplicates de-duplicated, first-occurrence order preserved', () => {
    const result = normalizeConcepts(
      ['gotcha', 'pattern', 'gotcha', 'how-it-works', 'pattern'],
      CODE_MODE
    );
    expect(result).toEqual(['gotcha', 'pattern', 'how-it-works']);
  });

  it('case variants matched to canonical id (How-It-Works → how-it-works)', () => {
    const result = normalizeConcepts(['How-It-Works', 'GOTCHA', 'Pattern'], CODE_MODE);
    expect(result).toEqual(['how-it-works', 'gotcha', 'pattern']);
  });

  it('mixed-case duplicate collapses to single canonical entry', () => {
    const result = normalizeConcepts(['how-it-works', 'HOW-IT-WORKS'], CODE_MODE);
    expect(result).toEqual(['how-it-works']);
  });

  it('empty input returns empty array', () => {
    expect(normalizeConcepts([], CODE_MODE)).toEqual([]);
  });

  it('null handled safely (treated as empty)', () => {
    // @ts-expect-error — deliberately passing null to test runtime guard
    expect(normalizeConcepts(null, CODE_MODE)).toEqual([]);
  });

  it('undefined handled safely (treated as empty)', () => {
    // @ts-expect-error — deliberately passing undefined to test runtime guard
    expect(normalizeConcepts(undefined, CODE_MODE)).toEqual([]);
  });

  it('non-string entries inside array are skipped without crash', () => {
    // @ts-expect-error — deliberately passing mixed types to test runtime guard
    const result = normalizeConcepts([42, null, 'how-it-works', {}, 'gotcha'], CODE_MODE);
    expect(result).toEqual(['how-it-works', 'gotcha']);
  });

  it('dropped invalid concepts are logged at debug level', () => {
    normalizeConcepts(['how-it-works', 'not-a-concept'], CODE_MODE);
    expect(logger.debug).toHaveBeenCalledWith(
      'CONCEPT_NORMALIZER',
      'Dropping invalid concept',
      expect.objectContaining({ value: 'not-a-concept' })
    );
  });

  it('valid concepts are NOT logged (no noise for normal path)', () => {
    normalizeConcepts(['how-it-works', 'gotcha'], CODE_MODE);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('mode with no observation_concepts returns empty for any input', () => {
    const emptyMode: ModeConfig = { ...CODE_MODE, observation_concepts: [] };
    const result = normalizeConcepts(['how-it-works', 'gotcha'], emptyMode);
    expect(result).toEqual([]);
  });
});
