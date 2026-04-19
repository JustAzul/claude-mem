import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../../../src/utils/logger.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';

function createSession(sessionDbId: number) {
  return {
    sessionDbId,
    contentSessionId: 'content-1',
    memorySessionId: null,
    project: 'proj',
    platformSource: 'claude',
    userPrompt: 'prompt',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: 123,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    processingMessageIds: [],
    lastGeneratorActivity: Date.now()
  };
}

describe('SessionRoutes wall-clock guard', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {})
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('aborts stale sessions with no recent activity', () => {
    const session = createSession(72);
    const markAllSessionMessagesAbandoned = mock(() => 1);
    const removeSessionImmediate = mock(() => {});
    const startGeneratorWithProvider = mock(() => {});
    const dbPrepareGet = mock(() => ({ started_at_epoch: Date.now() - (5 * 60 * 60 * 1000) }));

    const routes = new SessionRoutes(
      {
        getSession: () => session,
        getPendingMessageStore: () => ({ markAllSessionMessagesAbandoned }),
        removeSessionImmediate
      } as any,
      {
        getSessionStore: () => ({
          db: { prepare: () => ({ get: dbPrepareGet }) },
          getLatestUserPromptEpoch: () => null,
          getLatestPendingWorkEpoch: () => null
        })
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    (routes as any).startGeneratorWithProvider = startGeneratorWithProvider;
    (routes as any).getSelectedProvider = () => 'custom';

    (routes as any).ensureGeneratorRunning(72, 'init');

    expect(session.abortController.signal.aborted).toBe(true);
    expect(markAllSessionMessagesAbandoned).toHaveBeenCalledWith(72);
    expect(removeSessionImmediate).toHaveBeenCalledWith(72);
    expect(startGeneratorWithProvider).not.toHaveBeenCalled();
  });

  it('does not abort stale-origin sessions when there is a recent prompt', () => {
    const session = createSession(73);
    const startGeneratorWithProvider = mock(() => {});
    const applyTierRouting = mock(() => {});
    const dbPrepareGet = mock(() => ({ started_at_epoch: Date.now() - (5 * 60 * 60 * 1000) }));

    const routes = new SessionRoutes(
      {
        getSession: () => session,
        getPendingMessageStore: () => ({ markAllSessionMessagesAbandoned: mock(() => 0) }),
        removeSessionImmediate: mock(() => {})
      } as any,
      {
        getSessionStore: () => ({
          db: { prepare: () => ({ get: dbPrepareGet }) },
          getLatestUserPromptEpoch: () => Date.now() - (15 * 60 * 1000),
          getLatestPendingWorkEpoch: () => null
        })
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    (routes as any).startGeneratorWithProvider = startGeneratorWithProvider;
    (routes as any).applyTierRouting = applyTierRouting;
    (routes as any).getSelectedProvider = () => 'custom';

    (routes as any).ensureGeneratorRunning(73, 'init');

    expect(session.abortController.signal.aborted).toBe(false);
    expect(startGeneratorWithProvider).toHaveBeenCalled();
  });
});
