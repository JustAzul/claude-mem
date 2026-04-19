/**
 * Recommender gate — single source of truth for "is the calibration
 * recommender paused?" decision.
 *
 * Until Probe B lands a validated content-reuse signal, the recommender's
 * prescriptions (raise/lower threshold) are driven by `likelyHelpedRate`,
 * which is derived from `signalSource='exact_observation_link'`. That signal
 * fires whenever a new observation is generated — not when an injected item
 * is actually reused. A 2026-04 audit found 12/15 "likely_helped" samples
 * were path-overlap tautologies. This gate short-circuits the recommender
 * to a neutral banner while raw telemetry (injectRate, verdicts) stays
 * visible in the UI.
 *
 * Flip `CLAUDE_MEM_RECOMMENDER_PAUSED` default to 'false' in
 * SettingsDefaultsManager once Probe B ships.
 */
import path from 'path';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';

export const RECOMMENDER_PAUSED_REASON = 'awaiting content-reuse signal';

/**
 * Returns true when the recommender must emit a `kind: 'paused'` card
 * instead of a prescriptive recommendation.
 *
 * Resolution order (highest priority first):
 *   1. `process.env.CLAUDE_MEM_RECOMMENDER_PAUSED`
 *   2. Persisted setting in ~/.claude-mem/settings.json
 *   3. Hardcoded default in SettingsDefaultsManager (currently 'true')
 */
export function isRecommenderPaused(): boolean {
  if (process.env.CLAUDE_MEM_RECOMMENDER_PAUSED !== undefined) {
    return process.env.CLAUDE_MEM_RECOMMENDER_PAUSED === 'true';
  }

  try {
    const settingsPath = path.join(
      SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'),
      'settings.json',
    );
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    return settings.CLAUDE_MEM_RECOMMENDER_PAUSED === 'true';
  } catch {
    // Defensive: on any read failure, fall back to the hardcoded default
    // via SettingsDefaultsManager.getBool (env > default only).
    return SettingsDefaultsManager.getBool('CLAUDE_MEM_RECOMMENDER_PAUSED');
  }
}
