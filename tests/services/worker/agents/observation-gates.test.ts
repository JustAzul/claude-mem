/**
 * Observation-gate tests — Phase 2 E2 (2026-04-18).
 *
 * The gate downgrades observations whose taxonomy label requires fields the
 * upstream prompt declares REQUIRED but the LLM left blank:
 *   - type=bugfix  without <why>                                → type=change
 *   - type=decision without <why> or <alternatives_rejected>    → type=discovery
 *   - everything else                                           → unchanged
 *
 * Losing data is worse than a weaker label, so we downgrade (mutate type),
 * never drop the observation. Each fire emits `logger.warn('OBS_GATE', ...)`
 * so the rate is measurable from stderr.
 */

import { describe, test, expect } from 'bun:test';
import { applyObservationGates } from '../../../../src/services/worker/agents/observation-gates.js';
import type { ParsedObservation } from '../../../../src/sdk/parser.js';

function makeObs(overrides: Partial<ParsedObservation>): ParsedObservation {
  return {
    type: 'discovery',
    title: 'Test observation',
    subtitle: null,
    facts: [],
    narrative: null,
    concepts: [],
    files_read: [],
    files_modified: [],
    why: null,
    alternatives_rejected: null,
    related_observation_ids: [],
    ...overrides,
  };
}

describe('applyObservationGates — bugfix gate', () => {
  test('bugfix + why=null → downgraded to change', () => {
    const input = [makeObs({ type: 'bugfix', title: 'null-why bugfix', why: null })];
    const out = applyObservationGates(input, 'TestAgent', 'sess-1');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('change');
    expect(out[0].title).toBe('null-why bugfix');
  });

  test('bugfix + why="" (empty string) → downgraded to change', () => {
    const input = [makeObs({ type: 'bugfix', title: 'empty-why bugfix', why: '' })];
    const out = applyObservationGates(input, 'TestAgent', 'sess-2');
    expect(out[0].type).toBe('change');
  });

  test('bugfix + why="   " (whitespace-only) → downgraded to change', () => {
    const input = [makeObs({ type: 'bugfix', title: 'ws-why bugfix', why: '   \n\t' })];
    const out = applyObservationGates(input, 'TestAgent', 'sess-3');
    expect(out[0].type).toBe('change');
  });

  test('bugfix + why populated → stays bugfix', () => {
    const input = [
      makeObs({
        type: 'bugfix',
        title: 'populated-why bugfix',
        why: 'because the queue deadlocked on restart',
      }),
    ];
    const out = applyObservationGates(input, 'TestAgent', 'sess-4');
    expect(out[0].type).toBe('bugfix');
    expect(out[0].why).toBe('because the queue deadlocked on restart');
  });
});

describe('applyObservationGates — decision gate', () => {
  test('decision + why populated + alternatives_rejected=null → downgraded to discovery', () => {
    const input = [
      makeObs({
        type: 'decision',
        title: 'missing alternatives',
        why: 'picked option A because it was simpler',
        alternatives_rejected: null,
      }),
    ];
    const out = applyObservationGates(input, 'TestAgent', 'sess-5');
    expect(out[0].type).toBe('discovery');
  });

  test('decision + why=null + alternatives populated → downgraded to discovery', () => {
    const input = [
      makeObs({
        type: 'decision',
        title: 'missing why',
        why: null,
        alternatives_rejected: 'considered B, considered C',
      }),
    ];
    const out = applyObservationGates(input, 'TestAgent', 'sess-6');
    expect(out[0].type).toBe('discovery');
  });

  test('decision + both fields whitespace → downgraded to discovery', () => {
    const input = [
      makeObs({
        type: 'decision',
        title: 'both blank',
        why: '  ',
        alternatives_rejected: '\n',
      }),
    ];
    const out = applyObservationGates(input, 'TestAgent', 'sess-7');
    expect(out[0].type).toBe('discovery');
  });

  test('decision + both fields populated → stays decision', () => {
    const input = [
      makeObs({
        type: 'decision',
        title: 'complete decision',
        why: 'picked json_each+CAST to avoid LIKE substring collisions',
        alternatives_rejected: 'LIKE pattern (caused false matches)',
      }),
    ];
    const out = applyObservationGates(input, 'TestAgent', 'sess-8');
    expect(out[0].type).toBe('decision');
    expect(out[0].why).toContain('json_each');
    expect(out[0].alternatives_rejected).toContain('LIKE');
  });
});

describe('applyObservationGates — non-gated types pass through', () => {
  test('feature + why=null → stays feature (gate does not fire)', () => {
    const input = [makeObs({ type: 'feature', title: 'bare feature', why: null })];
    const out = applyObservationGates(input, 'TestAgent', 'sess-9');
    expect(out[0].type).toBe('feature');
  });

  test('refactor + why=null → stays refactor', () => {
    const input = [makeObs({ type: 'refactor', title: 'bare refactor', why: null })];
    const out = applyObservationGates(input, 'TestAgent', 'sess-10');
    expect(out[0].type).toBe('refactor');
  });

  test('change + why=null → stays change', () => {
    const input = [makeObs({ type: 'change', title: 'bare change', why: null })];
    const out = applyObservationGates(input, 'TestAgent', 'sess-11');
    expect(out[0].type).toBe('change');
  });

  test('discovery + why=null → stays discovery', () => {
    const input = [makeObs({ type: 'discovery', title: 'bare discovery', why: null })];
    const out = applyObservationGates(input, 'TestAgent', 'sess-12');
    expect(out[0].type).toBe('discovery');
  });
});

describe('applyObservationGates — mixed batch + invariants', () => {
  test('mixed batch applies per-observation independently', () => {
    const input = [
      makeObs({ type: 'bugfix', title: 'a', why: null }),
      makeObs({ type: 'bugfix', title: 'b', why: 'because X was broken' }),
      makeObs({
        type: 'decision',
        title: 'c',
        why: 'chose A',
        alternatives_rejected: null,
      }),
      makeObs({ type: 'feature', title: 'd', why: null }),
    ];
    const out = applyObservationGates(input, 'TestAgent', 'mixed');
    expect(out.map((o) => o.type)).toEqual(['change', 'bugfix', 'discovery', 'feature']);
    expect(out.map((o) => o.title)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('empty input returns empty array', () => {
    const out = applyObservationGates([], 'TestAgent', 'sess-empty');
    expect(out).toEqual([]);
  });

  test('input observations are not mutated in place', () => {
    const input = [makeObs({ type: 'bugfix', title: 'orig', why: null })];
    const originalType = input[0].type;
    applyObservationGates(input, 'TestAgent', 'sess-immut');
    expect(input[0].type).toBe(originalType); // original still 'bugfix'
  });
});
