
import { logger } from '../../../utils/logger.js';
import { parseAgentXml, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { ingestSummary } from '../http/shared.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { notifyTelegram } from '../../integrations/TelegramNotifier.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { extractToolMetadata } from '../../domain/ToolContextExtractor.js';
import { normalizeConcepts } from '../../domain/ConceptNormalizer.js';
import { applyObservationGates } from './observation-gates.js';
import { SUMMARY_MODE_MARKER } from '../../../sdk/prompts.js';
import type { CaptureSnapshotSource } from '../../sqlite/observations/capture-snapshot.js';
import type { ObservationContextType } from '../../sqlite/memory-assist/origins.js';
import type { SessionStore } from '../../sqlite/SessionStore.js';

const MAX_CONSECUTIVE_SUMMARY_FAILURES = 3;

export interface ToolContext {
  tool_name: string;
  tool_input: unknown;
}

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
  session.lastGeneratorActivity = Date.now();

  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  const parsed = parseAgentXml(text, session.contentSessionId);

  if (!parsed.valid) {
    logger.warn('PARSER', `${agentName} returned non-XML/empty response — ignoring queued batch`, {
      sessionId: session.sessionDbId,
    });
    await sessionManager.confirmClaimedMessages(session.sessionDbId);
    session.earliestPendingTimestamp = null;
    return;
  }

  const lastMessage = session.conversationHistory.at(-1);
  const lastUserMessage = lastMessage?.role === 'user'
    ? lastMessage
    : [...session.conversationHistory].reverse().find((m: ConversationMessage) => m.role === 'user') ?? null;
  const summaryExpected = lastUserMessage?.content?.includes(SUMMARY_MODE_MARKER) ?? false;

  // OBS_GATE: downgrade rather than reject so we never lose data when the LLM omits required fields.
  const gatedObservations = applyObservationGates(
    parsed.observations,
    agentName,
    session.contentSessionId
  );

  const activeModeForConcepts = ModeManager.getInstance().getActiveMode();
  for (const obs of gatedObservations) {
    obs.concepts = normalizeConcepts(obs.concepts, activeModeForConcepts);
  }

  for (const obs of gatedObservations) {
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

  // Snapshot types before tool-trace override so telemetry measures LLM→normalizer
  // accuracy, not the post-override forced values (e.g. 'discovery' for Read/Grep).
  const preOverrideTypes = gatedObservations.map(obs => obs.type);

  if (toolContext !== undefined && gatedObservations.length > 0) {
    const meta = extractToolMetadata(toolContext.tool_name, toolContext.tool_input);
    for (const obs of gatedObservations) {
      obs.files_read = meta.files_read;
      obs.files_modified = meta.files_modified;
      if (meta.type_override !== undefined) {
        obs.type = meta.type_override;
      }
    }
  }

  if (!session.memorySessionId) {
    logger.warn('SDK', 'memorySessionId not yet captured; deferring storage until next round', {
      sessionId: session.sessionDbId
    });
    await sessionManager.resetProcessingToPending(session.sessionDbId);
    return;
  }

  const observations = gatedObservations;
  const summary = parsed.summary;
  const summaryForStore = normalizeSummaryForStorage(summary);

  const sessionStore = dbManager.getSessionStore();
  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);

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

  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  const labeledObservations = observations.map(obs => ({
    ...obs,
    agent_type: session.pendingAgentType ?? null,
    agent_id: session.pendingAgentId ?? null
  }));

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

  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  session.lastSummaryStored = result.summaryId !== null;

  const currentProcessingMessageId = session.processingMessageIds[session.processingMessageIds.length - 1] ?? null;
  if (result.observationIds.length > 0 && currentProcessingMessageId != null) {
    sessionStore.attachGeneratedObservationsToOutcomeSignal(currentProcessingMessageId, result.observationIds);
    sessionStore.attachObservationOriginsToPendingMessage(currentProcessingMessageId, result.observationIds);
    logger.debug('QUEUE', `ATTACHED_OBSERVATIONS | sessionDbId=${session.sessionDbId} | messageId=${currentProcessingMessageId} | observationIds=[${result.observationIds.join(',')}]`);
  } else if (result.observationIds.length > 0 && currentProcessingMessageId == null) {
    // V31: register context-based origin for observations emitted outside the tool-call
    // queue (init-prompt, summary, continuation, user-prompt-only) so the trace modal
    // can render something instead of "No origin link found" (obs #11779).
    const contextType = inferContextType(session, summary);
    const contextRef = buildContextRef(session, sessionStore);
    for (const observationId of result.observationIds) {
      sessionStore.insertContextOrigin(observationId, contextType, contextRef, result.createdAtEpoch);
    }
    logger.debug('QUEUE', `CONTEXT_ORIGIN_ATTACHED | sessionDbId=${session.sessionDbId} | obsIds=[${result.observationIds.join(',')}] | contextType=${contextType}`);
  }

  // Circuit breaker (#1633): only count failures when a summary was actually requested,
  // otherwise normal observation responses would trip it after 3 turns and permanently
  // block summarization.
  if (summaryExpected) {
    const skippedIntentionally = /<skip_summary\b/.test(text);
    if (summaryForStore !== null) {
      session.consecutiveSummaryFailures = 0;
    } else if (!skippedIntentionally) {
      session.consecutiveSummaryFailures += 1;
      if (session.consecutiveSummaryFailures >= MAX_CONSECUTIVE_SUMMARY_FAILURES) {
        logger.error('SESSION', `Circuit breaker: ${session.consecutiveSummaryFailures} consecutive summary failures — further summarize requests will be skipped (#1633)`, {
          sessionId: session.sessionDbId,
          contentSessionId: session.contentSessionId
        });
      }
    }
  }

  if (summary && (summary.skipped || session.lastSummaryStored)) {
    await ingestSummary({
      kind: 'parsed',
      sessionDbId: session.sessionDbId,
      messageId: -1,
      contentSessionId: session.contentSessionId,
      parsed: summary,
    });
  }

  await sessionManager.confirmClaimedMessages(session.sessionDbId);
  session.earliestPendingTimestamp = null;
  session.processingMessageIds = [];
  session.restartGuard?.recordSuccess();
  worker?.broadcastProcessingStatus?.();

  void notifyTelegram({
    observations: labeledObservations,
    observationIds: result.observationIds,
    project: session.project,
    memorySessionId: session.memorySessionId,
  });

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
}

function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;
  if (summary.skipped) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

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
  // Dedupe observation IDs before sync/broadcast: storeObservations may collapse
  // multiple parsed observations onto the same row via content_hash, producing
  // duplicate IDs. Syncing them 1:1 triggers repeated Chroma "IDs already exist"
  // reconciles. See issue #2240.
  const uniqueObservationIds = [...new Set(result.observationIds)];

  for (const obsId of uniqueObservationIds) {
    const observationIndex = result.observationIds.indexOf(obsId);
    const obs = observations[observationIndex];
    if (!obs) {
      logger.warn('DB', `${agentName} storage returned observation id without matching parsed observation`, {
        sessionId: session.sessionDbId,
        obsId,
        observationIndex
      });
      continue;
    }
    const chromaStart = Date.now();

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

    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,
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

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const settingValue: unknown = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;

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
