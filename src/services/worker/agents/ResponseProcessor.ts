/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Execute atomic database transactions
 * - Orchestrate Chroma sync (fire-and-forget)
 * - Broadcast to SSE clients
 * - Clean up processed messages
 *
 * This module extracts 150+ lines of duplicate code from SDKAgent, GeminiAgent, and OpenRouterAgent.
 */

import { logger } from '../../../utils/logger.js';
import { parseObservations, parseSummary, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { SUMMARY_MODE_MARKER, MAX_CONSECUTIVE_SUMMARY_FAILURES } from '../../../sdk/prompts.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { extractToolMetadata } from '../../domain/ToolContextExtractor.js';
import { normalizeConcepts } from '../../domain/ConceptNormalizer.js';
import { applyObservationGates } from './observation-gates.js';
import type { CaptureSnapshotSource } from '../../sqlite/observations/capture-snapshot.js';
import type { ObservationContextType } from '../../sqlite/memory-assist/origins.js';
import type { SessionStore } from '../../sqlite/SessionStore.js';

/**
 * Source tool context for a single observation message.
 * Passed from agents so that ResponseProcessor can override LLM-inferred
 * file lists and type with ground-truth values from the tool trace.
 */
export interface ToolContext {
  tool_name: string;
  /** Parsed tool input object (already JSON.parse'd by the caller, or raw string). */
  tool_input: unknown;
}

/**
 * Process agent response text (parse XML, save to database, sync to Chroma, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic database transaction to store observations + summary
 * 4. Async Chroma sync (fire-and-forget, failures are non-critical)
 * 5. SSE broadcast to web UI clients
 * 6. Session cleanup
 *
 * @param text - Response text from the agent
 * @param session - Active session being processed
 * @param dbManager - Database manager for storage operations
 * @param sessionManager - Session manager for message tracking
 * @param worker - Worker reference for SSE broadcasting (optional)
 * @param discoveryTokens - Token cost delta for this response
 * @param originalTimestamp - Original epoch when message was queued (for accurate timestamps)
 * @param agentName - Name of the agent for logging (e.g., 'SDK', 'Gemini', 'OpenRouter')
 * @param projectRoot - Optional project root for CLAUDE.md updates
 * @param modelId - Optional model ID for telemetry
 * @param toolContext - Optional source tool context for deterministic metadata override
 */
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  modelId?: string,
  toolContext?: ToolContext,
  captureSource?: CaptureSnapshotSource
): Promise<void> {
  // Track generator activity for stale detection (Issue #1099)
  session.lastGeneratorActivity = Date.now();

  // Add assistant response to shared conversation history for provider interop
  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  // Parse observations and summary
  const parsedObservations = parseObservations(text, session.contentSessionId);

  // Detect whether the most recent prompt was a summary request.
  // If so, enable observation-to-summary coercion to prevent the infinite
  // retry loop described in #1633.
  const lastMessage = session.conversationHistory.at(-1);
  const lastUserMessage = lastMessage?.role === 'user'
    ? lastMessage
    : session.conversationHistory.findLast(m => m.role === 'user') ?? null;
  const summaryExpected = lastUserMessage?.content?.includes(SUMMARY_MODE_MARKER) ?? false;

  const summary = parseSummary(text, session.sessionDbId, summaryExpected);

  // OBS_GATE (Phase 2 E2): enforce taxonomy invariants the prompt declares.
  //   - bugfix without <why>                     → downgrade to change
  //   - decision without <why> or <alternatives> → downgrade to discovery
  // Losing data is worse than a weaker label, so we downgrade, never reject.
  // Each fire emits logger.warn('OBS_GATE', ...) so the rate can be grepped.
  const observations = applyObservationGates(
    parsedObservations,
    agentName,
    session.contentSessionId
  );

  // Normalize concepts on every observation regardless of whether a tool context is
  // available. Init and summary responses can also produce <observation> blocks, and
  // those must not bypass concept validation.
  const activeModeForConcepts = ModeManager.getInstance().getActiveMode();
  for (const obs of observations) {
    obs.concepts = normalizeConcepts(obs.concepts, activeModeForConcepts);
  }

  // Log raw LLM output snippet when concepts are empty but facts are present.
  // This captures whether the LLM omitted <concepts> entirely vs. used wrong inner-tag format.
  for (const obs of observations) {
    if (obs.concepts.length === 0 && obs.facts.length >= 2) {
      const snippet = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      logger.warn('PARSER', 'Observation stored with empty concepts — raw response snippet', {
        sessionId: session.sessionDbId,
        title: obs.title,
        factsCount: obs.facts.length,
        whyPresent: obs.why !== null,
        rawSnippet: snippet
      });
    }
  }

  // telemetry measures LLM→normalizer accuracy; snapshot types before post-processing
  // overrides so the forced values (e.g. 'discovery' for Read/Grep) do not pollute
  // LLM accuracy metrics — we want to measure what the normalizer produced, not what
  // the deterministic override produced.
  const preOverrideTypes = observations.map(obs => obs.type);

  // Post-process observations: override structural metadata from tool trace.
  // LLM inference for files_read/files_modified is ~100% wrong for read-only tools,
  // and type accuracy is ~60%. Ground-truth values come from the tool call itself.
  if (toolContext !== undefined && observations.length > 0) {
    const meta = extractToolMetadata(toolContext.tool_name, toolContext.tool_input);

    for (const obs of observations) {
      obs.files_read = meta.files_read;
      obs.files_modified = meta.files_modified;

      if (meta.type_override !== undefined) {
        obs.type = meta.type_override;
      }
    }
  }

  // Detect non-XML responses (auth errors, rate limits, garbled output).
  // When the response contains no parseable XML and produced no observations,
  // mark the pending messages as failed instead of confirming them — this prevents
  // silent data loss when the LLM returns garbage (#1874).
  const isNonXmlResponse = (
    text.trim() &&
    observations.length === 0 &&
    !summary &&
    !/<observation>|<summary>|<skip_summary\b/.test(text)
  );

  if (isNonXmlResponse) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    logger.warn('PARSER', `${agentName} returned non-XML response; marking messages as failed for retry (#1874)`, {
      sessionId: session.sessionDbId,
      preview
    });

    // Mark messages as failed (retry logic in PendingMessageStore handles retries)
    const pendingStore = sessionManager.getPendingMessageStore();
    for (const messageId of session.processingMessageIds) {
      pendingStore.markFailed(messageId);
    }
    session.processingMessageIds = [];
    return;
  }

  // Convert nullable fields to empty strings for storeSummary (if summary exists)
  const summaryForStore = normalizeSummaryForStorage(summary);

  // Get session store for atomic transaction
  const sessionStore = dbManager.getSessionStore();
  const activeMode = ModeManager.getInstance().getActiveMode();

  for (let i = 0; i < observations.length; i++) {
    const observation = observations[i];
    if (!observation.original_type || !observation.normalized_type_strategy) continue;
    sessionStore.recordObservationTypeCorrection({
      modeId: activeMode.name || 'unknown',
      originalType: observation.original_type,
      normalizedType: preOverrideTypes[i],
      fallbackType: observation.fallback_type || preOverrideTypes[i],
      strategy: observation.normalized_type_strategy,
      correlationId: session.contentSessionId,
      project: session.project,
      platformSource: session.platformSource,
    });
  }

  // CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  // SAFETY NET (Issue #846 / Multi-terminal FK fix):
  // The PRIMARY fix is in SDKAgent.ts where ensureMemorySessionIdRegistered() is called
  // immediately when the SDK returns a memory_session_id. This call is a defensive safety net
  // in case the DB was somehow not updated (race condition, crash, etc.).
  // In multi-terminal scenarios, createSDKSession() now resets memory_session_id to NULL
  // for each new generator, ensuring clean isolation.
  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);

  // Log pre-storage with session ID chain for verification
  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // Label observations with the subagent identity captured from the claimed messages.
  // Main-session messages leave these null, so main-session rows stay NULL in the DB.
  const labeledObservations = observations.map(obs => ({
    ...obs,
    agent_type: session.pendingAgentType ?? null,
    agent_id: session.pendingAgentId ?? null
  }));

  // ATOMIC TRANSACTION: Store observations + summary ONCE
  // Messages are already deleted from queue on claim, so no completion tracking needed.
  // Wrap in try/finally so the subagent tracker clears even if storage throws —
  // otherwise stale identity could leak into the next batch and mislabel rows.
  // Expected invariant: all observations in a batch share the same agent context,
  // because ResponseProcessor runs after a single agent-response cycle.
  //
  // captureSource carries the raw inputs (tool_input, tool_output, user_prompt,
  // prior_assistant_message, cwd) so V30 snapshot rows have ground truth to compare
  // against captured observation fields. Agents set this per-message before yielding.
  let result: ReturnType<typeof sessionStore.storeObservations>;
  try {
    result = sessionStore.storeObservations(
      session.memorySessionId,
      session.project,
      labeledObservations,
      summaryForStore,
      session.lastPromptNumber,
      discoveryTokens,
      originalTimestamp ?? undefined,
      modelId,
      captureSource
    );
  } finally {
    session.pendingAgentId = null;
    session.pendingAgentType = null;
  }

  // Log storage result with IDs for end-to-end traceability
  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // Track whether a summary record was stored so the status endpoint can expose this
  // to the Stop hook for silent-summary-loss detection (#1633)
  session.lastSummaryStored = result.summaryId !== null;

  const currentProcessingMessageId = session.processingMessageIds[session.processingMessageIds.length - 1] ?? null;
  if (result.observationIds.length > 0 && currentProcessingMessageId != null) {
    sessionStore.attachGeneratedObservationsToOutcomeSignal(currentProcessingMessageId, result.observationIds);
    sessionStore.attachObservationOriginsToPendingMessage(currentProcessingMessageId, result.observationIds);
    logger.debug('QUEUE', `ATTACHED_OBSERVATIONS | sessionDbId=${session.sessionDbId} | messageId=${currentProcessingMessageId} | observationIds=[${result.observationIds.join(',')}]`);
  } else if (result.observationIds.length > 0 && currentProcessingMessageId == null) {
    // No pending_message_id → observation was generated outside the tool-call
    // queue path. This is the normal case for init-prompt responses, summary
    // responses, and user-prompt-only turns. Historically we logged a
    // "ORPHAN_OBSERVATIONS" warn and moved on; that left those observations
    // with no row in observation_tool_origins and rendered in the trace modal
    // as "No origin link found" forever (see obs #11779 for a concrete case).
    //
    // V31 fix: register a context-based origin so the trace endpoint can
    // render something meaningful. We infer the context_type from session
    // state rather than passing it through the signature — the information
    // is already unambiguous at this point.
    const contextType = inferContextType(session, summary);
    const contextRef = buildContextRef(session, sessionStore);
    for (const observationId of result.observationIds) {
      sessionStore.insertContextOrigin(observationId, contextType, contextRef, result.createdAtEpoch);
    }
    logger.debug('QUEUE', `CONTEXT_ORIGIN_ATTACHED | sessionDbId=${session.sessionDbId} | obsIds=[${result.observationIds.join(',')}] | contextType=${contextType}`);
  }

  // Circuit breaker: track consecutive summary failures (#1633).
  // Only evaluate when a summary was actually expected (summarize message was sent).
  // Without this guard, the counter would increment on every normal observation
  // response, tripping the breaker after 3 observations and permanently blocking
  // summarization — reproducing the data-loss scenario this fix is meant to prevent.
  if (summaryExpected) {
    const skippedIntentionally = /<skip_summary\b/.test(text);
    if (summaryForStore !== null) {
      // Summary was present in the response — reset the failure counter
      session.consecutiveSummaryFailures = 0;
    } else if (skippedIntentionally) {
      // Explicit <skip_summary/> is a valid protocol response — neither success
      // nor failure. Leave the counter unchanged so we don't mask a bad run that
      // happens to end on a skip, but also don't punish intentional skips.
    } else {
      // Summary was expected but none was stored — count as failure
      session.consecutiveSummaryFailures += 1;
      if (session.consecutiveSummaryFailures >= MAX_CONSECUTIVE_SUMMARY_FAILURES) {
        logger.error('SESSION', `Circuit breaker: ${session.consecutiveSummaryFailures} consecutive summary failures — further summarize requests will be skipped (#1633)`, {
          sessionId: session.sessionDbId,
          contentSessionId: session.contentSessionId
        });
      }
    }
  }

  // CLAIM-CONFIRM: Now that storage succeeded, confirm all processing messages (delete from queue)
  // This is the critical step that prevents message loss on generator crash
  const pendingStore = sessionManager.getPendingMessageStore();
  for (const messageId of session.processingMessageIds) {
    pendingStore.confirmProcessed(messageId);
  }
  if (session.processingMessageIds.length > 0) {
    logger.debug('QUEUE', `CONFIRMED_BATCH | sessionDbId=${session.sessionDbId} | count=${session.processingMessageIds.length} | ids=[${session.processingMessageIds.join(',')}]`);
  }
  // Clear the tracking array after confirmation
  session.processingMessageIds = [];

  // AFTER transaction commits - async operations (can fail safely without data loss)
  await syncAndBroadcastObservations(
    observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );

  // Sync and broadcast summary if present
  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName
  );

  // Clean up session state
  cleanupProcessedMessages(session, worker);
}

/**
 * Normalize summary for storage (convert null fields to empty strings)
 */
function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

/**
 * Sync observations to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];
    const chromaStart = Date.now();

    // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
    dbManager.getChromaSync()?.syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    // Broadcast to SSE clients (for web UI)
    // BUGFIX: Use obs.files_read and obs.files_modified (not obs.files)
    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,  // text field is not in ParsedObservation
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }

  // Update folder CLAUDE.md files for touched folders (fire-and-forget)
  // This runs per-observation batch to ensure folders are updated as work happens
  // Only runs if CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED is true (default: false)
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // Handle both string 'true' and boolean true from JSON settings
  const settingValue = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true';

  if (folderClaudeMdEnabled) {
    const allFilePaths: string[] = [];
    for (const obs of observations) {
      allFilePaths.push(...(obs.files_modified || []));
      allFilePaths.push(...(obs.files_read || []));
    }

    if (allFilePaths.length > 0) {
      updateFolderClaudeMdFiles(
        allFilePaths,
        session.project,
        getWorkerPort(),
        projectRoot
      ).catch(error => {
        logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
      });
    }
  }
}

/**
 * Sync summary to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const chromaStart = Date.now();

  // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
  dbManager.getChromaSync()?.syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  // Broadcast to SSE clients (for web UI)
  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    platform_source: session.platformSource,
    request: summaryForStore!.request,
    investigated: summaryForStore!.investigated,
    learned: summaryForStore!.learned,
    completed: summaryForStore!.completed,
    next_steps: summaryForStore!.next_steps,
    notes: summaryForStore!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  // Update Cursor context file for registered projects (fire-and-forget)
  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('SYSTEM', 'Cursor context update failed (non-critical)', { project: session.project }, error as Error);
  });
}

// ============================================================================
// Context-origin helpers (V31)
//
// Observations that are emitted outside the tool-call queue (init prompt
// response, summary prompt response, continuation without any tool use, or a
// turn that only contained a user prompt) have no pending_message_id. Before
// V31 we logged "ORPHAN_OBSERVATIONS" and moved on — leaving those rows with
// no origin link forever. The helpers below infer what KIND of context
// produced the observation so `insertContextOrigin` can record a meaningful
// origin for the trace modal.
//
// Inference precedence (most specific wins):
//   summary present        → 'summary_prompt'
//   lastPromptNumber === 1 → 'init_prompt'
//   lastPromptNumber > 1   → 'continuation_prompt'
//   fallback               → 'user_prompt'
//
// The ref payload always carries sessionDbId / contentSessionId /
// promptNumber; when a matching row exists in user_prompts we also include
// user_prompt_id so the UI can link back to the exact prompt row.
// ============================================================================

interface UserPromptIdRow {
  id: number;
}

function inferContextType(
  session: ActiveSession,
  summary: ParsedSummary | null
): ObservationContextType {
  if (summary !== null) return 'summary_prompt';
  if (session.lastPromptNumber === 1) return 'init_prompt';
  if (session.lastPromptNumber > 1) return 'continuation_prompt';
  return 'user_prompt';
}

function buildContextRef(
  session: ActiveSession,
  sessionStore: SessionStore
): Record<string, unknown> {
  const ref: Record<string, unknown> = {
    sessionDbId: session.sessionDbId,
    contentSessionId: session.contentSessionId,
    promptNumber: session.lastPromptNumber,
  };

  if (session.contentSessionId && Number.isFinite(session.lastPromptNumber)) {
    try {
      const row = sessionStore.db
        .prepare('SELECT id FROM user_prompts WHERE content_session_id = ? AND prompt_number = ? LIMIT 1')
        .get(session.contentSessionId, session.lastPromptNumber) as UserPromptIdRow | undefined;
      if (row?.id) {
        ref.userPromptId = row.id;
      }
    } catch (error: unknown) {
      logger.debug(
        'QUEUE',
        `buildContextRef: user_prompts lookup failed for session=${session.contentSessionId} prompt=${session.lastPromptNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return ref;
}
