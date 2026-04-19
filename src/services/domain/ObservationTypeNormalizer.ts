import type { ModeConfig } from './types.js';

export interface ObservationTypeNormalizationResult {
  finalType: string;
  fallbackType: string;
  originalType: string | null;
  normalizedFromAlias: boolean;
  usedFallback: boolean;
}

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

const CANONICAL_ALIASES: Record<string, string> = {
  // ── discovery: observation / inspection / investigation ──────────────────
  'code-path-inspection': 'discovery',
  'code-path-analysis':   'discovery',
  'inspection':           'discovery',
  'code-inspection':      'discovery',
  'code-path':            'discovery',
  'investigation':        'discovery',
  'research':             'discovery',
  'exploration':          'discovery',
  'analysis':             'discovery',
  'state':                'discovery',
  'state-snapshot':       'discovery',
  'verification':         'discovery',
  'finding':              'discovery',
  'test':                 'discovery',
  'test-inspection':      'discovery',
  'test-result':          'discovery',
  'test-success':         'discovery',
  'runtime':              'discovery',
  'storage':              'discovery',
  'ui':                   'discovery',
  'ui-shared':            'discovery',
  'result':               'discovery',
  'status':               'discovery',
  'judging':              'discovery',
  'judge':                'discovery',
  'data':                 'discovery',
  'debugging':            'discovery',
  'debugging-finding':    'discovery',
  'debug':                'discovery',
  'hook':                 'discovery',
  'schema':               'discovery',
  'api':                  'discovery',
  'context':              'discovery',
  'dashboard':            'discovery',
  'filesystem':           'discovery',
  'infrastructure':       'discovery',
  'issue':                'discovery',
  'lifecycle':            'discovery',
  'performance':          'discovery',
  'processing':           'discovery',
  'read':                 'discovery',
  'repo-state':           'discovery',
  'user-preference':      'discovery',
  'workspace-state':      'discovery',

  // ── change: modifications ────────────────────────────────────────────────
  'code-change':          'change',
  'change-record':        'change',
  'config-change':        'change',
  'configuration':        'change',
  'routing':              'change',
  'progress':             'change',
  'documentation':        'change',
  'build':                'change',
  'commit':               'change',
  'git':                  'change',
  'sync':                 'change',
  'runbook':              'change',
  'test-edit':            'change',
  'test-update':          'change',

  // ── bugfix: failure / fix ────────────────────────────────────────────────
  'bug':                  'bugfix',
  'failure':              'bugfix',
  'fix':                  'bugfix',
  'test-failure':         'bugfix',
  'tool-failure':         'bugfix',

  // ── decision: planning / architecture ────────────────────────────────────
  'plan':                 'decision',
  'planning':             'decision',
  'decision-made':        'decision',

  // ── feature ──────────────────────────────────────────────────────────────
  'implementation':       'feature',
  'enhancement':          'feature',

  // ── refactor ─────────────────────────────────────────────────────────────
  'cleanup':              'refactor',
  'optimization':         'refactor',
};

function findAliasMatch(value: string, validTypes: Set<string>): string | null {
  const slug = toSlug(value);
  const canonical = CANONICAL_ALIASES[slug];
  if (canonical && validTypes.has(canonical)) {
    return canonical;
  }
  return null;
}

export function normalizeObservationType(
  mode: ModeConfig,
  type: string | null | undefined
): ObservationTypeNormalizationResult {
  const validTypes = mode.observation_types.map((observationType) => observationType.id);
  const validTypeSet = new Set(validTypes);
  // Fallback is always 'discovery': observational work is the most common ambiguous case,
  // and 'bugfix' (mode index 0) is the worst default because it implies a problem existed.
  const fallbackType = validTypeSet.has('discovery') ? 'discovery' : validTypes[0];
  const normalizedInput = type?.trim() ?? null;

  if (!normalizedInput) {
    return {
      finalType: fallbackType,
      fallbackType,
      originalType: null,
      normalizedFromAlias: false,
      usedFallback: true,
    };
  }

  if (validTypeSet.has(normalizedInput)) {
    return {
      finalType: normalizedInput,
      fallbackType,
      originalType: normalizedInput,
      normalizedFromAlias: false,
      usedFallback: false,
    };
  }

  const aliasMatch = findAliasMatch(normalizedInput, validTypeSet);
  if (aliasMatch) {
    return {
      finalType: aliasMatch,
      fallbackType,
      originalType: normalizedInput,
      normalizedFromAlias: true,
      usedFallback: false,
    };
  }

  return {
    finalType: fallbackType,
    fallbackType,
    originalType: normalizedInput,
    normalizedFromAlias: false,
    usedFallback: true,
  };
}
