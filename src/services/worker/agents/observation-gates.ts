/**
 * observation-gates.ts — post-parse enforcement gates for observation taxonomy.
 *
 * Why this exists (Phase 2 E2 · 2026-04-18):
 *   Rubric runner baseline (3-sample, 2026-04-18) showed `type_correctness: 0.38`
 *   and `why` fill rate 4.7%. The LLM frequently classifies observations as
 *   `bugfix` or `decision` without populating the fields that make those types
 *   meaningful (`why` for both; `alternatives_rejected` for decision). That
 *   silently pollutes the taxonomy — downstream consumers (rubric audits,
 *   retrieval, recommender) can no longer trust the `type` column.
 *
 * Gate behavior — downgrade, never reject:
 *   - type=bugfix  + missing <why>                         → type=change
 *   - type=decision + missing <why> OR <alternatives_rejected> → type=discovery
 *   - all other types pass through untouched
 *
 * We DOWNGRADE instead of rejecting because losing data is worse than a
 * weaker taxonomy label. Every gate trip logs with tag `OBS_GATE` so the
 * firing rate can be grepped from worker stderr to measure how often the
 * upstream prompt mis-classifies before the gate catches it.
 *
 * SRP: this module does exactly one thing — enforce the taxonomy invariants
 * the prompt declares as REQUIRED. ResponseProcessor stays lean.
 */

import { logger } from '../../../utils/logger.js';
import type { ParsedObservation } from '../../../sdk/parser.js';

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/**
 * Apply taxonomy enforcement gates to a list of parsed observations.
 *
 * Returns a NEW array with downgraded types; does not mutate input observations
 * (a caller could be holding references for audit). Each downgrade emits a
 * `logger.warn('OBS_GATE', ...)` record so the firing rate is measurable
 * from stderr without touching the DB.
 *
 * @param observations  Parsed observations emerging from `parseObservations`.
 * @param agentName     Agent identifier for the log payload (SDK/Gemini/etc.).
 * @param contentSessionId Optional correlation id for the log payload.
 */
export function applyObservationGates(
  observations: ParsedObservation[],
  agentName: string,
  contentSessionId?: string
): ParsedObservation[] {
  if (observations.length === 0) return observations;

  return observations.map((obs) => {
    if (obs.type === 'bugfix' && isBlank(obs.why)) {
      logger.warn(
        'OBS_GATE',
        'bugfix downgraded to change (missing why)',
        {
          observationTitle: obs.title ?? '(untitled)',
          agentName,
          contentSessionId,
        }
      );
      return { ...obs, type: 'change', pre_gate_type: 'bugfix' };
    }

    if (
      obs.type === 'decision' &&
      (isBlank(obs.why) || isBlank(obs.alternatives_rejected))
    ) {
      logger.warn(
        'OBS_GATE',
        'decision downgraded to discovery (missing why or alternatives)',
        {
          observationTitle: obs.title ?? '(untitled)',
          agentName,
          contentSessionId,
          hasWhy: !isBlank(obs.why),
          hasAlternatives: !isBlank(obs.alternatives_rejected),
        }
      );
      return { ...obs, type: 'discovery', pre_gate_type: 'decision' };
    }

    return obs;
  });
}
