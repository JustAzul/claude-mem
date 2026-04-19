import { logger } from '../../../../utils/logger.js';

export interface SessionWallClockEvaluationInput {
  nowMs: number;
  maxSessionWallClockMs: number;
  sessionOriginMs: number;
  latestUserPromptMs?: number | null;
  latestPendingWorkMs?: number | null;
}

export interface SessionWallClockEvaluation {
  sessionAgeMs: number;
  activityOriginMs: number;
  idleAgeMs: number;
  latestUserPromptMs: number | null;
  latestPendingWorkMs: number | null;
  shouldAbort: boolean;
}

export function evaluateSessionWallClockGuard(
  input: SessionWallClockEvaluationInput
): SessionWallClockEvaluation {
  const latestUserPromptMs = input.latestUserPromptMs ?? null;
  const latestPendingWorkMs = input.latestPendingWorkMs ?? null;
  const activityOriginMs = Math.max(
    input.sessionOriginMs,
    latestUserPromptMs ?? 0,
    latestPendingWorkMs ?? 0
  );
  const sessionAgeMs = input.nowMs - input.sessionOriginMs;
  const idleAgeMs = input.nowMs - activityOriginMs;

  const evaluation = {
    sessionAgeMs,
    activityOriginMs,
    idleAgeMs,
    latestUserPromptMs,
    latestPendingWorkMs,
    shouldAbort: idleAgeMs > input.maxSessionWallClockMs
  };

  if (evaluation.shouldAbort) {
    logger.debug(
      `[session-wall-clock] aborting stale session: idleAgeMs=${evaluation.idleAgeMs} limitMs=${input.maxSessionWallClockMs}`
    );
  }

  return evaluation;
}
