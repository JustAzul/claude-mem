
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse, transcriptPath } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!toolName) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    // Extract the prior assistant message from the transcript so the capture
    // snapshot carries turn context (powers Phase 4 retrieval-time rendering).
    // Best-effort: a missing transcript or parse error must not drop the observation.
    let lastAssistantMessage: string | null = null;
    if (transcriptPath) {
      try {
        const extracted = extractLastMessage(transcriptPath, 'assistant', true);
        if (extracted && extracted.trim()) {
          lastAssistantMessage = extracted;
        }
      } catch (err: unknown) {
        logger.debug('HOOK', `PostToolUse: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const result = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/observations',
      'POST',
      {
        contentSessionId: sessionId,
        platformSource,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        cwd,
        agentId: input.agentId,
        agentType: input.agentType,
        last_assistant_message: lastAssistantMessage,
      },
    );

    if (isWorkerFallback(result)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'Observation sent successfully', { toolName });
    return { continue: true, suppressOutput: true };
  },
};
