import { describe, expect, it } from 'bun:test';
import { evaluateSessionWallClockGuard } from '../../../../src/services/worker/http/routes/session-wall-clock.js';

describe('evaluateSessionWallClockGuard', () => {
  const oneHour = 60 * 60 * 1000;

  it('aborts sessions with no recent activity beyond the limit', () => {
    const result = evaluateSessionWallClockGuard({
      nowMs: 10 * oneHour,
      maxSessionWallClockMs: 4 * oneHour,
      sessionOriginMs: 0
    });

    expect(result.shouldAbort).toBe(true);
    expect(result.sessionAgeMs).toBe(10 * oneHour);
    expect(result.idleAgeMs).toBe(10 * oneHour);
  });

  it('keeps an old session alive when a recent prompt exists', () => {
    const result = evaluateSessionWallClockGuard({
      nowMs: 10 * oneHour,
      maxSessionWallClockMs: 4 * oneHour,
      sessionOriginMs: 0,
      latestUserPromptMs: 9 * oneHour
    });

    expect(result.shouldAbort).toBe(false);
    expect(result.idleAgeMs).toBe(oneHour);
    expect(result.activityOriginMs).toBe(9 * oneHour);
  });

  it('keeps an old session alive when recent pending work exists', () => {
    const result = evaluateSessionWallClockGuard({
      nowMs: 10 * oneHour,
      maxSessionWallClockMs: 4 * oneHour,
      sessionOriginMs: 0,
      latestPendingWorkMs: 8 * oneHour
    });

    expect(result.shouldAbort).toBe(false);
    expect(result.idleAgeMs).toBe(2 * oneHour);
    expect(result.activityOriginMs).toBe(8 * oneHour);
  });
});

