
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { stripMemoryTagsFromPrompt } from '../../utils/tag-stripping.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';

// Stop hook has a 120s timeout; cap our wait short of that so we have headroom
// to send the completion request after summary processing finishes.
const MAX_WAIT_FOR_SUMMARY_MS = 110_000;
const POLL_INTERVAL_MS = 1000;

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    if (input.cwd && !shouldTrackProject(input.cwd)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.stopHookActive === true) {
      logger.debug('HOOK', 'Skipping summary: Codex Stop hook re-entry detected', {
        sessionId: input.sessionId,
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.agentId) {
      logger.debug('HOOK', 'Skipping summary: subagent context detected', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'summarize: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    let lastAssistantMessage = '';

    if (input.lastAssistantMessage !== undefined) {
      lastAssistantMessage = stripMemoryTagsFromPrompt(input.lastAssistantMessage);
    } else {
      if (!transcriptPath) {
        logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      try {
        lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
        lastAssistantMessage = stripMemoryTagsFromPrompt(lastAssistantMessage);
      } catch (err) {
        logger.warn('HOOK', `Stop hook: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    }

    if (!lastAssistantMessage || !lastAssistantMessage.trim()) {
      logger.debug('HOOK', 'No assistant message available - skipping summary', {
        sessionId,
        transcriptPath
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    const platformSource = normalizePlatformSource(input.platform);

    const queueResult = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/summarize',
      'POST',
      {
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage,
        platformSource,
      },
    );
    if (isWorkerFallback(queueResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'Summary request queued, waiting for completion');

    // 2. Poll worker until pending work for this session is done.
    //    This keeps the Stop hook alive (120s timeout) so the SDK agent
    //    can finish processing the summary before SessionEnd kills the session.
    const waitStart = Date.now();
    let summaryStored: boolean | null = null;
    while ((Date.now() - waitStart) < MAX_WAIT_FOR_SUMMARY_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      let statusResponse: Response;
      let status: { queueLength?: number; summaryStored?: boolean | null };
      try {
        statusResponse = await workerHttpRequest(`/api/sessions/status?contentSessionId=${encodeURIComponent(sessionId)}`, { timeoutMs: 5000 });
        status = await statusResponse.json() as { queueLength?: number; summaryStored?: boolean | null };
      } catch (pollError) {
        // Worker may be busy — keep polling
        logger.debug('HOOK', 'Summary status poll failed, retrying', { error: pollError instanceof Error ? pollError.message : String(pollError) });
        continue;
      }

      const queueLength = status.queueLength ?? 0;
      // Only treat an empty queue as completion when the session exists (non-404).
      // A 404 means the session was not found — not that processing finished.
      if (queueLength === 0 && statusResponse.status !== 404) {
        summaryStored = status.summaryStored ?? null;
        logger.info('HOOK', 'Summary processing complete', {
          waitedMs: Date.now() - waitStart,
          summaryStored
        });
        // Warn when the agent processed a summarize request but produced no storable summary.
        // This is the silent-failure path described in #1633: queue empties but no summary record exists.
        if (summaryStored === false) {
          logger.warn('HOOK', 'Summary was not stored: LLM response likely lacked valid <summary> tags (#1633)', {
            sessionId,
            waitedMs: Date.now() - waitStart
          });
        }
        break;
      }
    }

    // 3a. Fire-and-forget: compute implicit use signals for this session.
    //     Best-effort — never blocks the hook on failure. Timeout 10s.
    try {
      await workerHttpRequest('/api/memory/compute-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId: sessionId }),
        timeoutMs: 10_000
      });
    } catch (err) {
      logger.debug('HOOK', `Summary: implicit-signal compute skipped: ${err instanceof Error ? err.message : err}`);
    }

    // 3. Complete the session — clean up active sessions map.
    //    This runs here in Stop (120s timeout) instead of SessionEnd (1.5s cap)
    //    so it reliably fires after summary work is done.
    try {
      await workerHttpRequest('/api/sessions/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId: sessionId }),
        timeoutMs: 10_000
      });
      logger.info('HOOK', 'Session completed in Stop hook', { contentSessionId: sessionId });
    } catch (err) {
      logger.warn('HOOK', `Stop hook: session-complete failed: ${err instanceof Error ? err.message : err}`);
    }

    return { continue: true, suppressOutput: true };
  },
};
