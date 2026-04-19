/**
 * Capture snapshot helper — validation-probe foundation (migration V30).
 *
 * Preserves the raw source (user_prompt, prior_assistant_message, tool_input,
 * tool_output, tool_name, cwd) alongside the captured observation fields so
 * downstream auditing (rubric runner, hallucination detector, content reuse)
 * can compare ground-truth inputs to LLM outputs. Without this pairing there
 * is no way to measure capture fidelity empirically.
 *
 * Extracted from SessionStore to avoid copy-pasting the INSERT across the
 * three observation writers (SRP / DRY). Each writer calls
 * `insertCaptureSnapshot(...)` inside its existing transaction so the snapshot
 * and the observation land atomically — neither can persist without the other.
 */
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export interface CaptureSnapshotSource {
  memorySessionId: string | null;
  contentSessionId: string | null;
  promptNumber: number | null;
  userPrompt: string | null;
  priorAssistantMessage: string | null;
  toolName: string | null;
  /** Already-serialized JSON string (or raw string). Helper does not stringify. */
  toolInput: string | null;
  /** Already-serialized JSON string (or raw string). Helper does not stringify. */
  toolOutput: string | null;
  cwd: string | null;
}

export interface CaptureSnapshotCaptured {
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  /** Serialized JSON array */
  facts: string | null;
  /** Serialized JSON array */
  concepts: string | null;
  why: string | null;
  alternativesRejected: string | null;
  /** Serialized JSON array */
  relatedObservationIds: string | null;
}

/**
 * Insert a capture snapshot row paired to an observation. Must be invoked
 * WITHIN the caller's open transaction so failure rolls back the observation.
 *
 * Never throws on snapshot-specific failures — the observation is the critical
 * data. We log and continue so a broken snapshot column shape does not block
 * live observation capture.
 */
export function insertCaptureSnapshot(
  db: Database,
  observationId: number,
  source: CaptureSnapshotSource,
  captured: CaptureSnapshotCaptured,
  createdAtEpoch: number
): void {
  if (!observationId) {
    logger.warn('DB', 'insertCaptureSnapshot: missing observationId — skipping');
    return;
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO observation_capture_snapshots (
        observation_id,
        memory_session_id,
        content_session_id,
        prompt_number,
        user_prompt,
        prior_assistant_message,
        tool_name,
        tool_input,
        tool_output,
        cwd,
        captured_type,
        captured_title,
        captured_subtitle,
        captured_narrative,
        captured_facts,
        captured_concepts,
        captured_why,
        captured_alternatives_rejected,
        captured_related_observation_ids,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      observationId,
      source.memorySessionId,
      source.contentSessionId,
      source.promptNumber,
      source.userPrompt,
      source.priorAssistantMessage,
      source.toolName,
      source.toolInput,
      source.toolOutput,
      source.cwd,
      captured.type,
      captured.title,
      captured.subtitle,
      captured.narrative,
      captured.facts,
      captured.concepts,
      captured.why,
      captured.alternativesRejected,
      captured.relatedObservationIds,
      createdAtEpoch
    );
  } catch (error: unknown) {
    logger.warn(
      'DB',
      'insertCaptureSnapshot failed — observation persisted without snapshot',
      { observationId },
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Retention helper — delete snapshot rows older than `cutoffEpochMs`.
 * Returns the number of rows deleted.
 */
export function deleteExpiredSnapshots(
  db: Database,
  cutoffEpochMs: number
): number {
  const stmt = db.prepare(
    'DELETE FROM observation_capture_snapshots WHERE created_at_epoch < ?'
  );
  const result = stmt.run(cutoffEpochMs);
  return Number(result.changes || 0);
}

/**
 * Empty/no-source placeholder — used by manual and bulk-import write paths
 * that have no pending_message trace. Callers still want the snapshot so the
 * row count matches the observation count.
 */
export function emptyCaptureSnapshotSource(
  memorySessionId: string | null,
  contentSessionId: string | null,
  promptNumber: number | null
): CaptureSnapshotSource {
  return {
    memorySessionId,
    contentSessionId,
    promptNumber,
    userPrompt: null,
    priorAssistantMessage: null,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    cwd: null,
  };
}

/**
 * Serialize a raw source value (tool_input / tool_output) into the canonical
 * storage shape: strings pass through, everything else is JSON-stringified.
 * Avoids double-encoding when the upstream queue already handed back a string.
 */
export function toSnapshotString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build the `captured` slice from an observation-shaped object using the same
 * JSON serialization rules as the INSERT INTO observations statement. Keeps
 * writers from duplicating serialization logic for the snapshot path.
 */
export function capturedFromObservation(observation: {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  why?: string | null;
  alternatives_rejected?: string | null;
  related_observation_ids?: number[];
}): CaptureSnapshotCaptured {
  return {
    type: observation.type,
    title: observation.title,
    subtitle: observation.subtitle,
    narrative: observation.narrative,
    facts: JSON.stringify(observation.facts ?? []),
    concepts: JSON.stringify(observation.concepts ?? []),
    why: observation.why ?? null,
    alternativesRejected: observation.alternatives_rejected ?? null,
    relatedObservationIds:
      observation.related_observation_ids && observation.related_observation_ids.length > 0
        ? JSON.stringify(observation.related_observation_ids)
        : null,
  };
}
