import type {
  MemoryAssistDecisionRecord,
  MemoryAssistFeedbackLabel,
  MemoryAssistJudgedOutcome,
  MemoryAssistOutcomeSignal,
  MemoryAssistSystemEvidence,
  MemoryAssistSystemVerdict,
} from '../../shared/memory-assist.js';
import { logger } from '../../utils/logger.js';

export interface MemoryAssistJudgeResult {
  verdict: MemoryAssistSystemVerdict;
  confidence: number;
  reasons: string[];
  evidence: MemoryAssistSystemEvidence;
}

function finalizeJudgeResult(
  decision: MemoryAssistDecisionRecord,
  result: MemoryAssistJudgeResult
): MemoryAssistJudgeResult {
  logger.debug(
    `[MemoryAssistJudge] decision=${decision.id ?? 'new'} source=${decision.source} status=${decision.status} verdict=${result.verdict} confidence=${result.confidence.toFixed(2)}`
  );
  return result;
}

function emptyEvidence(): MemoryAssistSystemEvidence {
  return {
    matchedTracePaths: [],
    usedOutcomes: [],
    ignoredOutcomes: [],
  };
}

function normalizePath(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\\/g, '/').trim().toLowerCase();
}

function collectTracePaths(decision: MemoryAssistDecisionRecord): Set<string> {
  const paths = new Set<string>();
  for (const item of decision.traceItems ?? []) {
    const primary = normalizePath(item.filePath);
    if (primary) paths.add(primary);
    for (const related of item.relatedFilePaths ?? []) {
      const normalized = normalizePath(related);
      if (normalized) paths.add(normalized);
    }
  }
  return paths;
}

function collectOutcomePaths(outcomes: MemoryAssistOutcomeSignal[]): Set<string> {
  const paths = new Set<string>();
  for (const outcome of outcomes) {
    const primary = normalizePath(outcome.filePath);
    if (primary) paths.add(primary);
    for (const related of outcome.relatedFilePaths ?? []) {
      const normalized = normalizePath(related);
      if (normalized) paths.add(normalized);
    }
  }
  return paths;
}

function collectOutcomeMatchedPaths(
  outcome: MemoryAssistOutcomeSignal,
  overlapPathSet: Set<string>
): string[] {
  const matched = new Set<string>();
  const primary = normalizePath(outcome.filePath);
  if (primary && overlapPathSet.has(primary)) matched.add(primary);
  for (const related of outcome.relatedFilePaths ?? []) {
    const normalized = normalizePath(related);
    if (normalized && overlapPathSet.has(normalized)) matched.add(normalized);
  }
  return [...matched];
}

function collectTraceObservationMatches(
  decision: MemoryAssistDecisionRecord,
  outcome: MemoryAssistOutcomeSignal,
  matchedPaths: string[]
): number[] {
  const generated = new Set(outcome.generatedObservationIds ?? []);
  const matchedPathSet = new Set(matchedPaths);
  const matched = new Set<number>();

  for (const item of decision.traceItems ?? []) {
    if (generated.has(item.observationId)) {
      matched.add(item.observationId);
      continue;
    }

    const primary = normalizePath(item.filePath);
    if (primary && matchedPathSet.has(primary)) {
      matched.add(item.observationId);
      continue;
    }

    const hasRelatedPathMatch = (item.relatedFilePaths ?? []).some((path) => {
      const normalized = normalizePath(path);
      return normalized != null && matchedPathSet.has(normalized);
    });
    if (hasRelatedPathMatch) {
      matched.add(item.observationId);
    }
  }

  return [...matched];
}

function collectConceptOverlapCount(
  decision: MemoryAssistDecisionRecord,
  outcome: MemoryAssistOutcomeSignal
): number {
  const outcomeConcepts = new Set((outcome.concepts ?? []).map((concept) => concept.trim().toLowerCase()).filter(Boolean));
  if (outcomeConcepts.size === 0) return 0;

  const overlappingConcepts = new Set<string>();
  for (const item of decision.traceItems ?? []) {
    for (const concept of item.concepts ?? []) {
      const normalized = concept.trim().toLowerCase();
      if (normalized && outcomeConcepts.has(normalized)) {
        overlappingConcepts.add(normalized);
      }
    }
  }

  return overlappingConcepts.size;
}

function hasExactTraceObservationLink(
  outcome: MemoryAssistOutcomeSignal,
  traceObservationIds: Set<number>
): boolean {
  return (outcome.generatedObservationIds ?? []).some((observationId) => traceObservationIds.has(observationId));
}

function pathSetFromMatchedPaths(matchedPaths: string[]): Set<string> {
  return new Set(matchedPaths);
}

function outcomeTouchesMatchedPaths(
  outcome: MemoryAssistOutcomeSignal,
  matchedPathSet: Set<string>
): boolean {
  if (matchedPathSet.size === 0) return false;
  return collectOutcomeMatchedPaths(outcome, matchedPathSet).some((path) => matchedPathSet.has(path));
}

function hasPriorSameTargetAction(
  outcome: MemoryAssistOutcomeSignal,
  outcomes: MemoryAssistOutcomeSignal[],
  matchedPaths: string[],
  actions: Array<MemoryAssistOutcomeSignal['action']>
): boolean {
  const matchedPathSet = pathSetFromMatchedPaths(matchedPaths);
  if (matchedPathSet.size === 0) return false;

  return outcomes.some((candidate) => {
    if (candidate === outcome) return false;
    if (!actions.includes(candidate.action)) return false;
    if ((candidate.timestamp ?? 0) > (outcome.timestamp ?? 0)) return false;
    return outcomeTouchesMatchedPaths(candidate, matchedPathSet);
  });
}

function hasLaterSameTargetAction(
  outcome: MemoryAssistOutcomeSignal,
  outcomes: MemoryAssistOutcomeSignal[],
  matchedPaths: string[],
  actions: Array<MemoryAssistOutcomeSignal['action']>
): boolean {
  const matchedPathSet = pathSetFromMatchedPaths(matchedPaths);
  if (matchedPathSet.size === 0) return false;

  return outcomes.some((candidate) => {
    if (candidate === outcome) return false;
    if (!actions.includes(candidate.action)) return false;
    if ((candidate.timestamp ?? 0) < (outcome.timestamp ?? 0)) return false;
    return outcomeTouchesMatchedPaths(candidate, matchedPathSet);
  });
}

function determineSequenceRole(
  outcome: MemoryAssistOutcomeSignal,
  outcomes: MemoryAssistOutcomeSignal[],
  matchedPaths: string[]
): 'follow_up_read' | 'follow_up_edit' | 'terminal_follow_up' | 'browser_follow_up' | 'other_follow_up' {
  if (outcome.action === 'browser') return 'browser_follow_up';
  if (outcome.action === 'command') return hasPriorSameTargetAction(outcome, outcomes, matchedPaths, ['edit', 'write'])
    ? 'terminal_follow_up'
    : 'other_follow_up';
  if (outcome.action === 'read') return hasLaterSameTargetAction(outcome, outcomes, matchedPaths, ['edit', 'write'])
    ? 'follow_up_read'
    : 'other_follow_up';
  if (outcome.action === 'edit' || outcome.action === 'write') {
    return hasPriorSameTargetAction(outcome, outcomes, matchedPaths, ['read'])
      ? 'follow_up_edit'
      : 'other_follow_up';
  }
  return 'other_follow_up';
}

function buildJudgedOutcome(
  decision: MemoryAssistDecisionRecord,
  outcome: MemoryAssistOutcomeSignal,
  outcomes: MemoryAssistOutcomeSignal[],
  matchedPaths: string[],
  reason: string,
  usedInVerdict: boolean
): MemoryAssistJudgedOutcome {
  const matchedTraceObservationIds = collectTraceObservationMatches(decision, outcome, matchedPaths);
  const conceptOverlapCount = collectConceptOverlapCount(decision, outcome);
  const sequenceRole = determineSequenceRole(outcome, outcomes, matchedPaths);
  const signalSource = (outcome.generatedObservationIds?.length ?? 0) > 0
    ? 'exact_observation_link'
    : sequenceRole === 'follow_up_edit' || sequenceRole === 'terminal_follow_up'
      ? 'sequence_only'
    : outcome.action === 'browser'
      ? 'browser_only'
      : matchedPaths.length > 0
        ? 'file_overlap'
        : 'no_overlap';
  const evidenceStrength = signalSource === 'exact_observation_link'
    ? usedInVerdict
      ? 'primary'
      : 'supporting'
    : signalSource === 'sequence_only'
      ? usedInVerdict
        ? 'supporting'
        : 'context'
    : signalSource === 'file_overlap'
      ? usedInVerdict
        ? 'supporting'
        : 'context'
      : 'context';
  return {
    outcomeId: outcome.id,
    pendingMessageId: outcome.pendingMessageId ?? null,
    action: outcome.action,
    toolName: outcome.toolName,
    filePath: outcome.filePath ?? null,
    timestamp: outcome.timestamp,
    matchedPaths,
    matchedTraceObservationIds,
    generatedObservationIds: outcome.generatedObservationIds ?? [],
    conceptOverlapCount,
    sequenceRole,
    signalSource,
    evidenceStrength,
    reason,
  };
}

function matchesOutcomeAction(
  outcome: MemoryAssistOutcomeSignal,
  actions: Array<MemoryAssistOutcomeSignal['action']>
): boolean {
  return actions.includes(outcome.action);
}

function buildEvidence(
  decision: MemoryAssistDecisionRecord,
  outcomes: MemoryAssistOutcomeSignal[],
  overlapPathSet: Set<string>,
  usedPredicate: (outcome: MemoryAssistOutcomeSignal, matchedPaths: string[]) => boolean,
  usedReason: (outcome: MemoryAssistOutcomeSignal, matchedPaths: string[]) => string,
  ignoredReason: (outcome: MemoryAssistOutcomeSignal, matchedPaths: string[]) => string
): MemoryAssistSystemEvidence {
  const usedOutcomes: MemoryAssistJudgedOutcome[] = [];
  const ignoredOutcomes: MemoryAssistJudgedOutcome[] = [];

  for (const outcome of outcomes) {
    const matchedPaths = collectOutcomeMatchedPaths(outcome, overlapPathSet);
    if (usedPredicate(outcome, matchedPaths)) {
      usedOutcomes.push(buildJudgedOutcome(decision, outcome, outcomes, matchedPaths, usedReason(outcome, matchedPaths), true));
      continue;
    }
    ignoredOutcomes.push(buildJudgedOutcome(decision, outcome, outcomes, matchedPaths, ignoredReason(outcome, matchedPaths), false));
  }

  return {
    matchedTracePaths: [...overlapPathSet],
    usedOutcomes,
    ignoredOutcomes,
  };
}

export function judgeMemoryAssistDecision(
  decision: MemoryAssistDecisionRecord,
  outcomes: MemoryAssistOutcomeSignal[],
  feedback: MemoryAssistFeedbackLabel | null | undefined = decision.userFeedback
): MemoryAssistJudgeResult {
  if (feedback === 'helpful') {
    return finalizeJudgeResult(decision, {
      verdict: 'likely_helped',
      confidence: 0.98,
      reasons: ['User marked this memory assist as helpful.'],
      evidence: emptyEvidence(),
    });
  }

  if (feedback === 'not_helpful') {
    return finalizeJudgeResult(decision, {
      verdict: 'likely_not_helped',
      confidence: 0.98,
      reasons: ['User marked this memory assist as not helpful.'],
      evidence: emptyEvidence(),
    });
  }

  if (decision.status !== 'injected') {
    return finalizeJudgeResult(decision, {
      verdict: 'unclear',
      confidence: 0.4,
      reasons: ['No memory was injected, so there is no direct adoption signal to judge.'],
      evidence: emptyEvidence(),
    });
  }

  if (outcomes.length === 0) {
    return finalizeJudgeResult(decision, {
      verdict: 'unclear',
      confidence: 0.35,
      reasons: ['No follow-up tool actions were recorded after this injection.'],
      evidence: emptyEvidence(),
    });
  }

  // Exclude the triggering tool call from outcomes. file_context injection fires
  // on PreToolUse for a Read; the corresponding PostToolUse for that same Read
  // later writes an outcome with the same prompt_number, same file_path, and
  // action='read'. That outcome was being counted as adoption ("Claude used
  // the injected memory") when it is actually the trigger itself.
  // Empirical evidence: 100% of fast-outcome (<1s) likely_helped decisions had
  // outcome.prompt_number === decision.prompt_number, outcome.action='read',
  // and matching file_path. Delta of 205-486ms maps cleanly to Read execution
  // time. See baseline counterfactual audit (2026-04-18).
  const decisionPromptNumber = decision.promptNumber ?? null;
  const decisionTriggerPaths = new Set(
    (decision.traceItems ?? [])
      .map((item) => normalizePath(item.filePath))
      .filter((path): path is string => Boolean(path)),
  );
  const filteredOutcomes = outcomes.filter((outcome) => {
    if (outcome.action !== 'read') return true;
    if (decisionPromptNumber == null || outcome.promptNumber == null) return true;
    if (outcome.promptNumber !== decisionPromptNumber) return true;
    const outcomePath = normalizePath(outcome.filePath);
    if (!outcomePath) return true;
    // Same-prompt read on a trace file is almost certainly the trigger itself.
    return !decisionTriggerPaths.has(outcomePath);
  });

  const tracePaths = collectTracePaths(decision);
  // Use ALL outcomes for path overlap + sequence detection (so a follow_up_edit
  // can still reference its preceding trigger-read). But only count reads from
  // `filteredOutcomes` toward the tier-5 read-only signal — otherwise the
  // triggering Read itself inflates the count and produces circular
  // "likely_helped" verdicts.
  const outcomePaths = collectOutcomePaths(outcomes);
  const overlapPaths = [...tracePaths].filter((path) => outcomePaths.has(path));
  const touchedFiles = overlapPaths.length;
  const overlapPathSet = new Set(overlapPaths);
  const overlappingOutcomes = outcomes.filter((outcome) => collectOutcomeMatchedPaths(outcome, overlapPathSet).length > 0);
  const editActions = overlappingOutcomes.filter((outcome) => outcome.action === 'edit' || outcome.action === 'write').length;
  const readActions = filteredOutcomes.filter((outcome) =>
    outcome.action === 'read' && collectOutcomeMatchedPaths(outcome, overlapPathSet).length > 0
  ).length;
  const browserActions = outcomes.filter((outcome) => outcome.action === 'browser').length;
  const exactLinkedOverlap = overlappingOutcomes.filter((outcome) => (outcome.generatedObservationIds?.length ?? 0) > 0).length;
  const traceObservationIds = new Set((decision.traceItems ?? []).map((item) => item.observationId));
  const exactTraceLinkedOutcomes = outcomes.filter((outcome) => hasExactTraceObservationLink(outcome, traceObservationIds));
  const exactTraceMatches = exactTraceLinkedOutcomes.length;
  const exactTraceLinkedEditActions = exactTraceLinkedOutcomes.filter((outcome) => outcome.action === 'edit' || outcome.action === 'write').length;
  const exactTraceLinkedReadActions = exactTraceLinkedOutcomes.filter((outcome) => outcome.action === 'read').length;
  const sequencedEditActions = overlappingOutcomes.filter((outcome) =>
    (outcome.action === 'edit' || outcome.action === 'write')
    && hasPriorSameTargetAction(outcome, overlappingOutcomes, collectOutcomeMatchedPaths(outcome, overlapPathSet), ['read'])
  ).length;
  const terminalFollowUpCommands = overlappingOutcomes.filter((outcome) =>
    outcome.action === 'command'
    && hasPriorSameTargetAction(outcome, overlappingOutcomes, collectOutcomeMatchedPaths(outcome, overlapPathSet), ['edit', 'write'])
  ).length;

  if (exactTraceLinkedEditActions > 0) {
    return finalizeJudgeResult(decision, {
      verdict: 'likely_helped',
      confidence: sequencedEditActions > 0 ? 0.96 : 0.9,
      reasons: [
        `${exactTraceLinkedEditActions} follow-up edit/write action${exactTraceLinkedEditActions === 1 ? '' : 's'} generated observations that were reused directly in the trace.`,
        ...(sequencedEditActions > 0
          ? [`${sequencedEditActions} of those edit/write action${sequencedEditActions === 1 ? '' : 's'} followed a prior read on the same file.`]
          : []),
        ...(terminalFollowUpCommands > 0
          ? [`${terminalFollowUpCommands} same-target command follow-up${terminalFollowUpCommands === 1 ? '' : 's'} landed after an edit/write action.`]
          : []),
        'This is stronger evidence than plain file overlap because the exact generated observation linked back into the final trace.',
      ],
      evidence: buildEvidence(
        decision,
        outcomes,
        overlapPathSet,
        (outcome, matchedPaths) =>
          hasExactTraceObservationLink(outcome, traceObservationIds)
          && matchesOutcomeAction(outcome, ['edit', 'write']),
        (outcome, matchedPaths) => {
          const isSequenced = hasPriorSameTargetAction(outcome, outcomes, matchedPaths, ['read']);
          return `Primary evidence: this ${outcome.action === 'write' ? 'write' : 'edit'} generated observation content that was reused directly in the trace${isSequenced ? ', and it followed a same-target read' : ''}.`;
        },
        (outcome, matchedPaths) => hasExactTraceObservationLink(outcome, traceObservationIds)
          ? 'Ignored by verdict because only edit/write actions count as adoption in this branch.'
          : matchedPaths.length > 0
            ? 'Ignored by verdict because exact trace reuse outranked plain file overlap in this branch.'
            : 'Ignored by verdict because it did not generate trace-reused observations or overlap the injected memory paths.'
      ),
    });
  }

  if (exactTraceLinkedReadActions > 0) {
    return finalizeJudgeResult(decision, {
      verdict: 'likely_helped',
      confidence: 0.78,
      reasons: [
        `${exactTraceLinkedReadActions} follow-up read action${exactTraceLinkedReadActions === 1 ? '' : 's'} generated observations that were reused directly in the trace.`,
        'This is stronger evidence than plain file overlap, but weaker than seeing the same target edited afterward.',
      ],
      evidence: buildEvidence(
        decision,
        outcomes,
        overlapPathSet,
        (outcome) => hasExactTraceObservationLink(outcome, traceObservationIds) && outcome.action === 'read',
        () => 'Primary evidence: this read generated observation content that was reused directly in the trace.',
        (outcome, matchedPaths) => hasExactTraceObservationLink(outcome, traceObservationIds)
          ? 'Ignored by verdict because only read-based exact trace reuse counted in this branch.'
          : matchedPaths.length > 0
            ? 'Ignored by verdict because exact trace reuse outranked plain file overlap in this branch.'
            : 'Ignored by verdict because it did not generate trace-reused observations or overlap the injected memory paths.'
      ),
    });
  }

  if (touchedFiles > 0 && editActions > 0) {
    return finalizeJudgeResult(decision, {
      verdict: 'likely_helped',
      confidence: exactTraceMatches > 0
        ? 0.94
        : terminalFollowUpCommands > 0
          ? 0.91
          : exactLinkedOverlap > 0 || sequencedEditActions > 0
          ? 0.9
          : 0.88,
      reasons: [
        `Injected memory overlapped with ${touchedFiles} file path${touchedFiles === 1 ? '' : 's'} touched afterward.`,
        `${editActions} follow-up edit/write action${editActions === 1 ? '' : 's'} used those same files.`,
        ...(sequencedEditActions > 0
          ? [`${sequencedEditActions} of those edit/write action${sequencedEditActions === 1 ? '' : 's'} followed a prior read on the same file.`]
          : []),
        ...(exactLinkedOverlap > 0
          ? [`${exactLinkedOverlap} matching follow-up action${exactLinkedOverlap === 1 ? '' : 's'} produced exact linked observation${exactLinkedOverlap === 1 ? '' : 's'}.`]
          : []),
        ...(exactTraceMatches > 0
          ? [`${exactTraceMatches} follow-up action${exactTraceMatches === 1 ? '' : 's'} generated observations that were reused directly in the trace.`]
          : []),
        ...(terminalFollowUpCommands > 0
          ? [`${terminalFollowUpCommands} same-target command follow-up${terminalFollowUpCommands === 1 ? '' : 's'} landed after an edit/write action.`]
          : []),
      ],
      evidence: buildEvidence(
        decision,
        outcomes,
        overlapPathSet,
        (outcome, matchedPaths) => matchedPaths.length > 0 && matchesOutcomeAction(outcome, ['edit', 'write']),
        (outcome, matchedPaths) => {
          const sequencedRead = hasPriorSameTargetAction(outcome, outcomes, matchedPaths, ['read']);
          const commandFollowUp = hasLaterSameTargetAction(outcome, outcomes, matchedPaths, ['command']);
          return `${(outcome.generatedObservationIds?.length ?? 0) > 0 ? 'Primary' : 'Supporting'} evidence: it ${outcome.action === 'write' ? 'wrote' : 'edited'} ${matchedPaths.length === 1 ? 'the matched file' : 'matched files'}${(outcome.generatedObservationIds?.length ?? 0) > 0 ? ` and generated ${outcome.generatedObservationIds!.length} exact linked observation${outcome.generatedObservationIds!.length === 1 ? '' : 's'}` : ''}${sequencedRead ? ', after a same-target read' : ''}${commandFollowUp ? ', with a same-target command follow-up afterward' : ''}.`;
        },
        (outcome, matchedPaths) => matchedPaths.length > 0
          ? `Ignored by verdict because only edit/write overlap counted here${(outcome.generatedObservationIds?.length ?? 0) > 0 ? ', even though this tool action generated exact linked observations' : ''}.`
          : `Ignored by verdict because it did not overlap with the injected memory paths${(outcome.generatedObservationIds?.length ?? 0) > 0 ? ', even though it generated exact linked observations' : ''}.`
      ),
    });
  }

  if (terminalFollowUpCommands > 0) {
    return finalizeJudgeResult(decision, {
      verdict: 'likely_helped',
      confidence: 0.83,
      reasons: [
        `${terminalFollowUpCommands} same-target command follow-up${terminalFollowUpCommands === 1 ? '' : 's'} landed after an edit/write action on the matched files.`,
        'That is weaker than direct trace reuse, but stronger than plain overlap because the command followed work on the same target.',
      ],
      evidence: buildEvidence(
        decision,
        outcomes,
        overlapPathSet,
        (outcome, matchedPaths) =>
          outcome.action === 'command'
          && matchedPaths.length > 0
          && hasPriorSameTargetAction(outcome, outcomes, matchedPaths, ['edit', 'write']),
        (_outcome, matchedPaths) => `Supporting evidence: this command followed an edit/write on ${matchedPaths.length === 1 ? 'the matched file' : 'matched files'} and stayed on the same target set.`,
        (outcome, matchedPaths) => matchedPaths.length > 0
          ? 'Ignored by verdict because only same-target command follow-ups counted in this branch.'
          : 'Ignored by verdict because it did not stay on the injected memory target set.'
      ),
    });
  }

  // Read-only overlap without any exact trace-linked observation is a weak
  // signal — file_context injection fires precisely when Claude reads a file,
  // so a subsequent re-read on the same path is more likely workflow continuity
  // than adoption of the injected memory. Empirical audit: 100% of this-tier
  // hits had exactly 1 matched read against 6+ ignored outcomes (purity 14%),
  // and the 48% global "help rate" was being inflated by this circular signal.
  // Require either >1 reads on matched files (repeated revisits, less
  // explicable as incidental) or an exact-observation link; otherwise downgrade
  // to unclear.
  const readOnlyStrongEnough =
    touchedFiles > 0 &&
    readActions > 0 &&
    (readActions >= 2 || exactLinkedOverlap > 0 || exactTraceMatches > 0);
  if (readOnlyStrongEnough) {
    return finalizeJudgeResult(decision, {
      verdict: 'likely_helped',
      confidence: exactTraceMatches > 0 ? 0.84 : exactLinkedOverlap > 0 ? 0.78 : 0.74,
      reasons: [
        `Injected memory overlapped with ${touchedFiles} file path${touchedFiles === 1 ? '' : 's'} revisited afterward.`,
        `${readActions} follow-up read action${readActions === 1 ? '' : 's'} revisited the same files.`,
        ...(exactLinkedOverlap > 0
          ? [`${exactLinkedOverlap} matching follow-up action${exactLinkedOverlap === 1 ? '' : 's'} produced exact linked observation${exactLinkedOverlap === 1 ? '' : 's'}.`]
          : []),
        ...(exactTraceMatches > 0
          ? [`${exactTraceMatches} follow-up action${exactTraceMatches === 1 ? '' : 's'} generated observations that were reused directly in the trace.`]
          : []),
      ],
      evidence: buildEvidence(
        decision,
        outcomes,
        overlapPathSet,
        (outcome, matchedPaths) => matchedPaths.length > 0 && outcome.action === 'read',
        (outcome, matchedPaths) => `${(outcome.generatedObservationIds?.length ?? 0) > 0 ? 'Primary' : 'Supporting'} evidence: it reread ${matchedPaths.length === 1 ? 'the matched file' : 'matched files'}${(outcome.generatedObservationIds?.length ?? 0) > 0 ? ` and generated ${outcome.generatedObservationIds!.length} exact linked observation${outcome.generatedObservationIds!.length === 1 ? '' : 's'}` : ''}.`,
        (outcome, matchedPaths) => matchedPaths.length > 0
          ? `Ignored by verdict because only read overlap counted in this branch${(outcome.generatedObservationIds?.length ?? 0) > 0 ? ', even though this tool action generated exact linked observations' : ''}.`
          : `Ignored by verdict because it did not overlap with the injected memory paths${(outcome.generatedObservationIds?.length ?? 0) > 0 ? ', even though it generated exact linked observations' : ''}.`
      ),
    });
  }

  if (browserActions > 0) {
    return finalizeJudgeResult(decision, {
      verdict: 'unclear',
      confidence: 0.46,
      reasons: ['The follow-up signal was mostly browser/UI activity, which is weaker evidence than file overlap.'],
      evidence: buildEvidence(
        decision,
        outcomes,
        overlapPathSet,
        (outcome) => outcome.action === 'browser',
        () => 'Context-only evidence: browser/UI follow-up was the only available signal.',
        (_outcome, matchedPaths) => matchedPaths.length > 0
          ? 'Ignored by verdict because browser/UI activity took precedence in this branch.'
          : 'Ignored by verdict because it did not overlap with the injected memory paths.'
      ),
    });
  }

  return finalizeJudgeResult(decision, {
    verdict: 'likely_not_helped',
    confidence: 0.62,
    reasons: ['The injection was not followed by related file overlap or a concrete follow-up action.'],
    evidence: buildEvidence(
      decision,
      outcomes,
      overlapPathSet,
      () => false,
      () => 'Unused.',
      (_outcome, matchedPaths) => matchedPaths.length > 0
        ? 'Ignored by verdict because there was overlap, but no qualifying follow-up action.'
        : 'Ignored by verdict because it did not overlap with the injected memory paths.'
    ),
  });
}
