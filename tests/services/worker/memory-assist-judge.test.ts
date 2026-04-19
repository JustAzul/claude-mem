import { describe, expect, it } from 'bun:test';
import { judgeMemoryAssistDecision } from '../../../src/services/worker/MemoryAssistJudge.js';
import type { MemoryAssistDecisionRecord, MemoryAssistOutcomeSignal } from '../../../src/shared/memory-assist.js';

function baseDecision(): MemoryAssistDecisionRecord {
  const targetPath = 'workspace/src/example/primary-file.py';
  return {
    id: 1,
    source: 'file_context',
    status: 'injected',
    reason: 'timeline_injected',
    timestamp: Date.now(),
    createdAtEpoch: Date.now(),
    updatedAtEpoch: Date.now(),
    contentSessionId: 'content-judge',
    promptNumber: 1,
    traceItems: [
      {
        observationId: 501,
        title: 'Primary file',
        filePath: targetPath,
        concepts: ['timeout-handling'],
      },
    ],
  };
}

describe('MemoryAssistJudge', () => {
  it('counts only overlap-scoped edit/write actions in likely-helped reasons', () => {
    const decision = baseDecision();
    const outcomes: MemoryAssistOutcomeSignal[] = [
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        signalType: 'tool_use',
        toolName: 'Read',
        action: 'read',
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
      },
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
        concepts: ['timeout-handling'],
      },
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        filePath: 'workspace/src/example/unrelated-file.py',
        relatedFilePaths: ['workspace/src/example/unrelated-file.py'],
      },
    ];

    const result = judgeMemoryAssistDecision(decision, outcomes);
    expect(result.verdict).toBe('likely_helped');
    expect(result.reasons[1]).toContain('1 follow-up edit/write action');
    expect(result.evidence.matchedTracePaths).toEqual(['workspace/src/example/primary-file.py']);
    expect(result.evidence.usedOutcomes).toHaveLength(1);
    expect(result.evidence.usedOutcomes[0]?.action).toBe('edit');
    expect(result.evidence.usedOutcomes[0]?.matchedPaths).toEqual(['workspace/src/example/primary-file.py']);
    expect(result.evidence.usedOutcomes[0]?.signalSource).toBe('sequence_only');
    expect(result.evidence.usedOutcomes[0]?.evidenceStrength).toBe('supporting');
    expect(result.evidence.usedOutcomes[0]?.sequenceRole).toBe('follow_up_edit');
    expect(result.evidence.usedOutcomes[0]?.matchedTraceObservationIds).toEqual([501]);
    expect(result.evidence.usedOutcomes[0]?.conceptOverlapCount).toBe(1);
    expect(result.evidence.ignoredOutcomes).toHaveLength(2);
    expect(result.evidence.ignoredOutcomes[0]?.reason).toContain('only edit/write overlap counted');
    expect(result.evidence.ignoredOutcomes[1]?.reason).toContain('did not overlap');
  });

  it('treats exact linked observations as primary evidence when the matching action is used', () => {
    const decision = baseDecision();
    const outcomes: MemoryAssistOutcomeSignal[] = [
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        pendingMessageId: 1201,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
        generatedObservationIds: [501],
      },
    ];

    const result = judgeMemoryAssistDecision(decision, outcomes);
    expect(result.verdict).toBe('likely_helped');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.evidence.usedOutcomes[0]?.signalSource).toBe('exact_observation_link');
    expect(result.evidence.usedOutcomes[0]?.evidenceStrength).toBe('primary');
    expect(result.evidence.usedOutcomes[0]?.matchedTraceObservationIds).toEqual([501]);
    expect(result.evidence.usedOutcomes[0]?.reason).toContain('Primary evidence');
  });

  it('does not promote exact linked observations without overlap to likely helped', () => {
    const decision = baseDecision();
    const outcomes: MemoryAssistOutcomeSignal[] = [
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        pendingMessageId: 1202,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        filePath: 'workspace/src/example/unrelated-file.py',
        relatedFilePaths: ['workspace/src/example/unrelated-file.py'],
        generatedObservationIds: [7002],
      },
    ];

    const result = judgeMemoryAssistDecision(decision, outcomes);
    expect(result.verdict).toBe('likely_not_helped');
    expect(result.evidence.ignoredOutcomes[0]?.signalSource).toBe('exact_observation_link');
    expect(result.evidence.ignoredOutcomes[0]?.evidenceStrength).toBe('supporting');
  });

  it('promotes exact trace reuse on edit actions even without plain file overlap', () => {
    const decision = baseDecision();
    const outcomes: MemoryAssistOutcomeSignal[] = [
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        pendingMessageId: 1203,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        filePath: 'workspace/src/example/renamed-file.py',
        relatedFilePaths: ['workspace/src/example/renamed-file.py'],
        generatedObservationIds: [501],
      },
    ];

    const result = judgeMemoryAssistDecision(decision, outcomes);
    expect(result.verdict).toBe('likely_helped');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.reasons[0]).toContain('generated observations that were reused directly in the trace');
    expect(result.evidence.usedOutcomes[0]?.signalSource).toBe('exact_observation_link');
    expect(result.evidence.usedOutcomes[0]?.evidenceStrength).toBe('primary');
  });

  it('upgrades same-target read -> edit chains above plain file overlap', () => {
    const decision = baseDecision();
    const outcomes: MemoryAssistOutcomeSignal[] = [
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        pendingMessageId: 1301,
        signalType: 'tool_use',
        toolName: 'Read',
        action: 'read',
        timestamp: 100,
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
      },
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        pendingMessageId: 1302,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        timestamp: 200,
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
      },
    ];

    const result = judgeMemoryAssistDecision(decision, outcomes);
    expect(result.verdict).toBe('likely_helped');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.reasons.join(' ')).toContain('followed a prior read on the same file');
    expect(result.evidence.usedOutcomes[0]?.sequenceRole).toBe('follow_up_edit');
    expect(result.evidence.usedOutcomes[0]?.signalSource).toBe('sequence_only');
  });

  it('uses same-target edit -> command follow-ups as supporting adoption evidence', () => {
    const decision = baseDecision();
    const outcomes: MemoryAssistOutcomeSignal[] = [
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        pendingMessageId: 1401,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        timestamp: 100,
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
      },
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        pendingMessageId: 1402,
        signalType: 'tool_use',
        toolName: 'Bash',
        action: 'command',
        timestamp: 200,
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
      },
    ];

    const result = judgeMemoryAssistDecision(decision, outcomes);
    expect(result.verdict).toBe('likely_helped');
    expect(result.reasons.join(' ')).toContain('same-target command follow-up');
    expect(result.evidence.usedOutcomes[0]?.action).toBe('edit');
    expect(result.evidence.ignoredOutcomes[0]?.sequenceRole).toBe('terminal_follow_up');
  });

  it('lets explicit user feedback override heuristic evidence', () => {
    const decision = baseDecision();
    const outcomes: MemoryAssistOutcomeSignal[] = [
      {
        decisionId: 1,
        contentSessionId: 'content-judge',
        promptNumber: 1,
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        filePath: 'workspace/src/example/primary-file.py',
        relatedFilePaths: ['workspace/src/example/primary-file.py'],
      },
    ];

    const result = judgeMemoryAssistDecision(decision, outcomes, 'not_helpful');
    expect(result.verdict).toBe('likely_not_helped');
    expect(result.confidence).toBe(0.98);
    expect(result.reasons[0]).toContain('User marked');
  });
});
