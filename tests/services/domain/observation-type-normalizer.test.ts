import { describe, it, expect } from 'bun:test';
import { normalizeObservationType } from '../../../src/services/domain/ObservationTypeNormalizer.js';
import type { ModeConfig } from '../../../src/services/domain/types.js';

// Minimal ModeConfig that mirrors the real code.json valid types.
const CODE_MODE: ModeConfig = {
  name: 'code',
  description: 'Code mode',
  version: '1.0.0',
  observation_types: [
    { id: 'bugfix',    label: 'Bug Fix',   description: '', emoji: '', work_emoji: '' },
    { id: 'feature',   label: 'Feature',   description: '', emoji: '', work_emoji: '' },
    { id: 'refactor',  label: 'Refactor',  description: '', emoji: '', work_emoji: '' },
    { id: 'change',    label: 'Change',    description: '', emoji: '', work_emoji: '' },
    { id: 'discovery', label: 'Discovery', description: '', emoji: '', work_emoji: '' },
    { id: 'decision',  label: 'Decision',  description: '', emoji: '', work_emoji: '' },
  ],
  observation_concepts: [],
  prompts: {} as ModeConfig['prompts'],
};

// Helper: extract just the final type for terse assertions.
function norm(type: string | null | undefined): string {
  return normalizeObservationType(CODE_MODE, type).finalType;
}

// ─── Valid types pass through unchanged ─────────────────────────────────────

describe('valid types — pass through unchanged', () => {
  it('bugfix',    () => expect(norm('bugfix')).toBe('bugfix'));
  it('feature',   () => expect(norm('feature')).toBe('feature'));
  it('refactor',  () => expect(norm('refactor')).toBe('refactor'));
  it('change',    () => expect(norm('change')).toBe('change'));
  it('discovery', () => expect(norm('discovery')).toBe('discovery'));
  it('decision',  () => expect(norm('decision')).toBe('decision'));

  it('valid type has normalizedFromAlias=false and usedFallback=false', () => {
    const r = normalizeObservationType(CODE_MODE, 'discovery');
    expect(r.normalizedFromAlias).toBe(false);
    expect(r.usedFallback).toBe(false);
    expect(r.originalType).toBe('discovery');
  });
});

// ─── discovery bucket ────────────────────────────────────────────────────────

describe('aliases → discovery', () => {
  it('inspection', ()        => expect(norm('inspection')).toBe('discovery'));
  it('verification', ()      => expect(norm('verification')).toBe('discovery'));
  it('finding', ()           => expect(norm('finding')).toBe('discovery'));
  it('state', ()             => expect(norm('state')).toBe('discovery'));
  it('state-snapshot', ()    => expect(norm('state-snapshot')).toBe('discovery'));
  it('code-inspection', ()   => expect(norm('code-inspection')).toBe('discovery'));
  it('code-path', ()         => expect(norm('code-path')).toBe('discovery'));
  it('test', ()              => expect(norm('test')).toBe('discovery'));
  it('test-inspection', ()   => expect(norm('test-inspection')).toBe('discovery'));
  it('test-result', ()       => expect(norm('test-result')).toBe('discovery'));
  it('test-success', ()      => expect(norm('test-success')).toBe('discovery'));
  it('runtime', ()           => expect(norm('runtime')).toBe('discovery'));
  it('storage', ()           => expect(norm('storage')).toBe('discovery'));
  it('ui', ()                => expect(norm('ui')).toBe('discovery'));
  it('ui-shared', ()         => expect(norm('ui-shared')).toBe('discovery'));
  it('result', ()            => expect(norm('result')).toBe('discovery'));
  it('status', ()            => expect(norm('status')).toBe('discovery'));
  it('judging', ()           => expect(norm('judging')).toBe('discovery'));
  it('judge', ()             => expect(norm('judge')).toBe('discovery'));
  it('data', ()              => expect(norm('data')).toBe('discovery'));
  it('debugging', ()         => expect(norm('debugging')).toBe('discovery'));
  it('debugging-finding', () => expect(norm('debugging-finding')).toBe('discovery'));
  it('debug', ()             => expect(norm('debug')).toBe('discovery'));
  it('hook', ()              => expect(norm('hook')).toBe('discovery'));
  it('schema', ()            => expect(norm('schema')).toBe('discovery'));
  it('api', ()               => expect(norm('api')).toBe('discovery'));
  it('context', ()           => expect(norm('context')).toBe('discovery'));
  it('dashboard', ()         => expect(norm('dashboard')).toBe('discovery'));
  it('filesystem', ()        => expect(norm('filesystem')).toBe('discovery'));
  it('infrastructure', ()    => expect(norm('infrastructure')).toBe('discovery'));
  it('issue', ()             => expect(norm('issue')).toBe('discovery'));
  it('lifecycle', ()         => expect(norm('lifecycle')).toBe('discovery'));
  it('performance', ()       => expect(norm('performance')).toBe('discovery'));
  it('processing', ()        => expect(norm('processing')).toBe('discovery'));
  it('read', ()              => expect(norm('read')).toBe('discovery'));
  it('repo-state', ()        => expect(norm('repo-state')).toBe('discovery'));
  it('user-preference', ()   => expect(norm('user-preference')).toBe('discovery'));
  it('workspace-state', ()   => expect(norm('workspace-state')).toBe('discovery'));
});

// ─── change bucket ───────────────────────────────────────────────────────────

describe('aliases → change', () => {
  it('code-change', ()   => expect(norm('code-change')).toBe('change'));
  it('code_change', ()   => expect(norm('code_change')).toBe('change'));
  it('change-record', () => expect(norm('change-record')).toBe('change'));
  it('routing', ()       => expect(norm('routing')).toBe('change'));
  it('progress', ()      => expect(norm('progress')).toBe('change'));
  it('documentation', () => expect(norm('documentation')).toBe('change'));
  it('build', ()         => expect(norm('build')).toBe('change'));
  it('commit', ()        => expect(norm('commit')).toBe('change'));
  it('git', ()           => expect(norm('git')).toBe('change'));
  it('sync', ()          => expect(norm('sync')).toBe('change'));
  it('runbook', ()       => expect(norm('runbook')).toBe('change'));
  it('test-edit', ()     => expect(norm('test-edit')).toBe('change'));
  it('test-update', ()   => expect(norm('test-update')).toBe('change'));
  it('test_update', ()   => expect(norm('test_update')).toBe('change'));
});

// ─── bugfix bucket ───────────────────────────────────────────────────────────

describe('aliases → bugfix', () => {
  it('bug', ()           => expect(norm('bug')).toBe('bugfix'));
  it('failure', ()       => expect(norm('failure')).toBe('bugfix'));
  it('fix', ()           => expect(norm('fix')).toBe('bugfix'));
  it('test-failure', ()  => expect(norm('test-failure')).toBe('bugfix'));
  it('test_failure', ()  => expect(norm('test_failure')).toBe('bugfix'));
  it('tool-failure', ()  => expect(norm('tool-failure')).toBe('bugfix'));
  it('tool_failure', ()  => expect(norm('tool_failure')).toBe('bugfix'));
});

// ─── decision bucket ─────────────────────────────────────────────────────────

describe('aliases → decision', () => {
  it('plan', ()          => expect(norm('plan')).toBe('decision'));
  it('planning', ()      => expect(norm('planning')).toBe('decision'));
  it('decision-made', () => expect(norm('decision-made')).toBe('decision'));
});

// ─── Unknown type → fallback to discovery (not bugfix) ───────────────────────

describe('fallback behaviour', () => {
  it('completely unknown type falls back to discovery', () => {
    expect(norm('something_we_never_saw')).toBe('discovery');
  });

  it('another unknown type also falls back to discovery', () => {
    expect(norm('xyzzy')).toBe('discovery');
  });

  it('fallback sets usedFallback=true and retains originalType', () => {
    const r = normalizeObservationType(CODE_MODE, 'something_we_never_saw');
    expect(r.usedFallback).toBe(true);
    expect(r.normalizedFromAlias).toBe(false);
    expect(r.originalType).toBe('something_we_never_saw');
    expect(r.fallbackType).toBe('discovery');
    expect(r.finalType).toBe('discovery');
  });
});

// ─── Case variants ───────────────────────────────────────────────────────────

describe('case variants', () => {
  it('"STATE" → discovery', ()  => expect(norm('STATE')).toBe('discovery'));
  it('"State" → discovery', ()  => expect(norm('State')).toBe('discovery'));
  it('"state" → discovery', ()  => expect(norm('state')).toBe('discovery'));

  it('"FINDING" → discovery', ()  => expect(norm('FINDING')).toBe('discovery'));
  it('"Finding" → discovery', ()  => expect(norm('Finding')).toBe('discovery'));

  it('"BUG" → bugfix', ()   => expect(norm('BUG')).toBe('bugfix'));
  it('"Bug" → bugfix', ()   => expect(norm('Bug')).toBe('bugfix'));

  it('"PLAN" → decision', ()   => expect(norm('PLAN')).toBe('decision'));
  it('"Plan" → decision', ()   => expect(norm('Plan')).toBe('decision'));
});

// ─── Underscore / space / hyphen equivalence ─────────────────────────────────

describe('slug equivalence (_, space, -)', () => {
  it('code_inspection → discovery', () => expect(norm('code_inspection')).toBe('discovery'));
  it('code inspection → discovery', () => expect(norm('code inspection')).toBe('discovery'));
  it('code-inspection → discovery', () => expect(norm('code-inspection')).toBe('discovery'));

  it('test_failure → bugfix', () => expect(norm('test_failure')).toBe('bugfix'));
  it('test failure → bugfix', () => expect(norm('test failure')).toBe('bugfix'));
  it('test-failure → bugfix', () => expect(norm('test-failure')).toBe('bugfix'));

  it('debugging_finding → discovery', () => expect(norm('debugging_finding')).toBe('discovery'));
  it('debugging finding → discovery', () => expect(norm('debugging finding')).toBe('discovery'));
  it('debugging-finding → discovery', () => expect(norm('debugging-finding')).toBe('discovery'));

  it('user_preference → discovery', () => expect(norm('user_preference')).toBe('discovery'));
  it('user preference → discovery', () => expect(norm('user preference')).toBe('discovery'));
  it('user-preference → discovery', () => expect(norm('user-preference')).toBe('discovery'));

  it('workspace_state → discovery', () => expect(norm('workspace_state')).toBe('discovery'));
  it('workspace state → discovery', () => expect(norm('workspace state')).toBe('discovery'));
  it('workspace-state → discovery', () => expect(norm('workspace-state')).toBe('discovery'));
});

// ─── Empty / null / undefined ────────────────────────────────────────────────

describe('empty / null / undefined input', () => {
  it('null → fallback (discovery)', () => {
    const r = normalizeObservationType(CODE_MODE, null);
    expect(r.finalType).toBe('discovery');
    expect(r.fallbackType).toBe('discovery');
    expect(r.originalType).toBeNull();
    expect(r.usedFallback).toBe(true);
  });

  it('undefined → fallback (discovery)', () => {
    const r = normalizeObservationType(CODE_MODE, undefined);
    expect(r.finalType).toBe('discovery');
    expect(r.usedFallback).toBe(true);
    expect(r.originalType).toBeNull();
  });

  it('empty string → fallback (discovery)', () => {
    const r = normalizeObservationType(CODE_MODE, '');
    expect(r.finalType).toBe('discovery');
    expect(r.usedFallback).toBe(true);
    expect(r.originalType).toBeNull();
  });

  it('whitespace-only string → fallback (discovery)', () => {
    const r = normalizeObservationType(CODE_MODE, '   ');
    expect(r.finalType).toBe('discovery');
    expect(r.usedFallback).toBe(true);
    expect(r.originalType).toBeNull();
  });
});

// ─── Telemetry output shape ──────────────────────────────────────────────────

describe('telemetry output — strategy fields', () => {
  it('alias match: normalizedFromAlias=true, usedFallback=false, originalType retained', () => {
    const r = normalizeObservationType(CODE_MODE, 'state');
    expect(r.finalType).toBe('discovery');
    expect(r.normalizedFromAlias).toBe(true);
    expect(r.usedFallback).toBe(false);
    expect(r.originalType).toBe('state');
    expect(r.fallbackType).toBe('discovery');
  });

  it('valid input: normalizedFromAlias=false, usedFallback=false', () => {
    const r = normalizeObservationType(CODE_MODE, 'bugfix');
    expect(r.normalizedFromAlias).toBe(false);
    expect(r.usedFallback).toBe(false);
    expect(r.originalType).toBe('bugfix');
    expect(r.finalType).toBe('bugfix');
  });

  it('unknown input: usedFallback=true, normalizedFromAlias=false, fallbackType=discovery', () => {
    const r = normalizeObservationType(CODE_MODE, 'totally-unknown-type');
    expect(r.usedFallback).toBe(true);
    expect(r.normalizedFromAlias).toBe(false);
    expect(r.fallbackType).toBe('discovery');
    expect(r.finalType).toBe('discovery');
    expect(r.originalType).toBe('totally-unknown-type');
  });

  it('fallbackType is discovery even in a mode where discovery is not first', () => {
    // Code mode lists bugfix first — fallback should still be discovery.
    const r = normalizeObservationType(CODE_MODE, 'xyzzy');
    expect(r.fallbackType).toBe('discovery');
  });

  it('mode without discovery uses validTypes[0] as fallback (graceful degradation)', () => {
    const minimalMode: ModeConfig = {
      ...CODE_MODE,
      observation_types: [
        { id: 'note', label: 'Note', description: '', emoji: '', work_emoji: '' },
      ],
    };
    const r = normalizeObservationType(minimalMode, 'xyzzy');
    expect(r.fallbackType).toBe('note');
    expect(r.finalType).toBe('note');
  });
});
