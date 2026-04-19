import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionStore memory assist persistence', () => {
  let store: SessionStore;

  function createStoredObservation(input: {
    contentSessionId: string;
    memorySessionId: string;
    filePath: string;
    promptNumber?: number;
    project?: string;
    createdAtEpoch?: number;
  }): { sessionDbId: number; observationId: number } {
    const project = input.project ?? 'claude-mem';
    const promptNumber = input.promptNumber ?? 1;
    const createdAtEpoch = input.createdAtEpoch ?? Date.now();
    const sessionDbId = store.createSDKSession(input.contentSessionId, project, 'trace the exact tool action');
    store.ensureMemorySessionIdRegistered(sessionDbId, input.memorySessionId);

    const imported = store.importObservation({
      memory_session_id: input.memorySessionId,
      project,
      text: 'Synthetic observation for traceability tests',
      type: 'discovery',
      title: `Observed ${input.filePath.split('/').pop()}`,
      subtitle: 'Synthetic trace fixture',
      facts: JSON.stringify(['exact tool action generated this observation']),
      narrative: `Observation captured for ${input.filePath}`,
      concepts: JSON.stringify(['traceability']),
      files_read: JSON.stringify([input.filePath]),
      files_modified: JSON.stringify([input.filePath]),
      prompt_number: promptNumber,
      discovery_tokens: 12,
      created_at: new Date(createdAtEpoch).toISOString(),
      created_at_epoch: createdAtEpoch,
    });

    return { sessionDbId, observationId: imported.id };
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('persists decisions, attaches outcome signals, and updates the system verdict', () => {
    const decision = store.recordMemoryAssistDecision({
      source: 'semantic_prompt',
      status: 'injected',
      reason: 'semantic_match',
      promptNumber: 1,
      contentSessionId: 'content-1',
      sessionDbId: 72,
      project: 'claude-mem',
      selectedCount: 1,
      candidateCount: 3,
      traceItems: [
        {
          observationId: 101,
          title: 'Reuse score pill tone mapping',
          filePath: 'workspace/ui/score-pill.tsx',
          relatedFilePaths: ['workspace/ui/score-pill.tsx', 'workspace/ui/hero-banner.tsx'],
        },
      ],
    });

    expect(decision.id).toBeGreaterThan(0);
    expect(decision.systemVerdict).toBe('unclear');

    const signal = store.recordMemoryAssistOutcomeSignal({
      contentSessionId: 'content-1',
      promptNumber: 1,
      sessionDbId: 72,
      project: 'claude-mem',
      pendingMessageId: 7001,
      signalType: 'tool_use',
      toolName: 'Edit',
      action: 'edit',
      filePath: 'workspace/ui/score-pill.tsx',
      relatedFilePaths: ['workspace/ui/score-pill.tsx'],
    });

    const attached = store.attachGeneratedObservationsToOutcomeSignal(signal.pendingMessageId!, [901, 902]);
    expect(attached?.generatedObservationIds).toEqual([901, 902]);

    const [updated] = store.getRecentMemoryAssistDecisions({ limit: 1, contentSessionId: 'content-1' });
    expect(updated.systemVerdict).toBe('likely_helped');
    expect(updated.systemConfidence).toBeGreaterThan(0.7);
    expect(updated.systemEvidence?.usedOutcomes).toHaveLength(1);
    expect(updated.systemEvidence?.usedOutcomes[0]?.filePath).toBe('workspace/ui/score-pill.tsx');
    expect(updated.systemEvidence?.usedOutcomes[0]?.pendingMessageId).toBe(7001);
    expect(updated.systemEvidence?.usedOutcomes[0]?.generatedObservationIds).toEqual([901, 902]);
    expect(updated.systemEvidence?.ignoredOutcomes).toHaveLength(0);

    store.attachMemoryAssistDecisionFeedback(updated.id, 'not_helpful');

    const [afterFeedback] = store.getRecentMemoryAssistDecisions({ limit: 1, contentSessionId: 'content-1' });
    expect(afterFeedback.userFeedback).toBe('not_helpful');
    expect(afterFeedback.systemVerdict).toBe('likely_not_helped');
  });

  it('attributes outcome signals to the matching prompt decision instead of the latest session decision', () => {
    const earlier = store.recordMemoryAssistDecision({
      source: 'file_context',
      status: 'injected',
      reason: 'timeline_injected',
      promptNumber: 1,
      contentSessionId: 'content-2',
      sessionDbId: 90,
      project: 'claude-mem',
      traceItems: [
        {
          observationId: 201,
          title: 'Primary file',
          filePath: 'workspace/service/primary-file.py',
        },
      ],
    });

    const later = store.recordMemoryAssistDecision({
      source: 'file_context',
      status: 'injected',
      reason: 'timeline_injected',
      promptNumber: 2,
      contentSessionId: 'content-2',
      sessionDbId: 90,
      project: 'claude-mem',
      traceItems: [
        {
          observationId: 202,
          title: 'Secondary file',
          filePath: 'workspace/service/secondary-file.py',
        },
      ],
    });

    const signal = store.recordMemoryAssistOutcomeSignal({
      contentSessionId: 'content-2',
      promptNumber: 1,
      sessionDbId: 90,
      project: 'claude-mem',
      signalType: 'tool_use',
      toolName: 'Edit',
      action: 'edit',
      filePath: 'workspace/service/primary-file.py',
      relatedFilePaths: ['workspace/service/primary-file.py'],
    });

    expect(signal.decisionId).toBe(earlier.id);
    expect(signal.decisionId).not.toBe(later.id);
  });

  it('persists exact observation origins and exposes the reverse lookup', () => {
    const contentSessionId = 'content-origin-1';
    const filePath = 'workspace/service/primary-file.py';
    const { sessionDbId, observationId } = createStoredObservation({
      contentSessionId,
      memorySessionId: 'memory-origin-1',
      filePath,
      promptNumber: 1,
    });

    const decision = store.recordMemoryAssistDecision({
      source: 'file_context',
      status: 'injected',
      reason: 'timeline_injected',
      promptNumber: 1,
      contentSessionId,
      sessionDbId,
      project: 'claude-mem',
      traceItems: [
        {
          observationId,
          title: 'Primary file',
          filePath,
        },
      ],
    });

    const signal = store.recordMemoryAssistOutcomeSignal({
      decisionId: decision.id,
      contentSessionId,
      promptNumber: 1,
      sessionDbId,
      project: 'claude-mem',
      pendingMessageId: 8101,
      signalType: 'tool_use',
      toolName: 'Edit',
      action: 'edit',
      filePath,
      relatedFilePaths: [filePath],
    });

    store.attachGeneratedObservationsToOutcomeSignal(signal.pendingMessageId!, [observationId]);
    const attached = store.attachObservationOriginsToPendingMessage(signal.pendingMessageId!, [observationId]);

    expect(attached).toHaveLength(1);
    expect(attached[0]?.observationId).toBe(observationId);
    expect(attached[0]?.pendingMessageId).toBe(8101);
    expect(attached[0]?.decisionId).toBe(decision.id);
    expect(attached[0]?.toolName).toBe('Edit');
    expect(attached[0]?.action).toBe('edit');
    expect(attached[0]?.filePath).toBe(filePath);

    const origin = store.getObservationOrigin(observationId);
    expect(origin).not.toBeNull();
    expect(origin?.pendingMessageId).toBe(8101);
    expect(origin?.decisionId).toBe(decision.id);
    expect(origin?.toolName).toBe('Edit');
    expect(origin?.action).toBe('edit');
    expect(origin?.promptNumber).toBe(1);
    expect(origin?.filePath).toBe(filePath);
  });

  it('separates injection, system likely-helped, and user-confirmed rates in the dashboard', () => {
    const injectedLikelyHelped = store.recordMemoryAssistDecision({
      source: 'file_context',
      status: 'injected',
      reason: 'timeline_injected',
      promptNumber: 1,
      contentSessionId: 'content-3',
      sessionDbId: 91,
      project: 'claude-mem',
      traceItems: [
        {
          observationId: 301,
          title: 'Score pill mapping',
          filePath: 'workspace/ui/score-pill.tsx',
        },
      ],
    });

    store.recordMemoryAssistOutcomeSignal({
      contentSessionId: 'content-3',
      promptNumber: 1,
      sessionDbId: 91,
      project: 'claude-mem',
      signalType: 'tool_use',
      toolName: 'Edit',
      action: 'edit',
      filePath: 'workspace/ui/score-pill.tsx',
      relatedFilePaths: ['workspace/ui/score-pill.tsx'],
    });

    store.recordMemoryAssistDecision({
      source: 'semantic_prompt',
      status: 'injected',
      reason: 'semantic_match',
      promptNumber: 1,
      contentSessionId: 'content-4',
      sessionDbId: 92,
      project: 'claude-mem',
      selectedCount: 1,
      candidateCount: 2,
    });

    store.recordMemoryAssistDecision({
      source: 'semantic_prompt',
      status: 'skipped',
      reason: 'below_threshold',
      promptNumber: 1,
      contentSessionId: 'content-5',
      sessionDbId: 93,
      project: 'claude-mem',
      candidateCount: 3,
      selectedCount: 0,
    });

    store.attachMemoryAssistDecisionFeedback(injectedLikelyHelped.id, 'helpful');

    const dashboard = store.getMemoryAssistDashboard(30);
    expect(dashboard.injected).toBe(2);
    expect(dashboard.injectRate).toBe(67);
    expect(dashboard.likelyHelped).toBe(1);
    expect(dashboard.likelyHelpedRate).toBe(33);
    expect(dashboard.userConfirmedHelpfulRate).toBe(100);
    expect(dashboard.sourceStats.file_context.likelyHelped).toBe(1);
    expect(dashboard.sourceStats.file_context.userConfirmedHelpful).toBe(1);
  });

  it('recommends raising the threshold for sparse semantic slices dominated by below-threshold skips', () => {
    for (let index = 0; index < 20; index += 1) {
      store.recordMemoryAssistDecision({
        source: 'semantic_prompt',
        status: 'skipped',
        reason: 'below_threshold',
        promptNumber: index + 1,
        contentSessionId: `content-recommend-${index}`,
        sessionDbId: 300 + index,
        project: 'claude-mem',
        shadowRanking: {
          productionRankerId: 'production_v1',
          experimentalRankerId: 'experimental_v1',
          productionCandidates: [],
          experimentalCandidates: [],
          productionSelectedObservationIds: [],
          experimentalSelectedObservationIds: [8000 + index],
        },
      });
    }

    const dashboard = store.getMemoryAssistDashboard(30);
    expect(dashboard.sourceStats.semantic_prompt.recommendation.kind).toBe('raise_threshold');
    expect(dashboard.sourceStats.semantic_prompt.recommendation.suggestedDelta).toBe(0.05);
    expect(dashboard.sourceStats.semantic_prompt.recommendation.slice).toEqual({
      scope: 'source',
      key: 'semantic_prompt',
      source: 'semantic_prompt',
    });
  });

  it('aggregates calibration slices by project/source and shadow ranking', () => {
    store.recordMemoryAssistDecision({
      source: 'semantic_prompt',
      status: 'injected',
      reason: 'semantic_match',
      promptNumber: 3,
      contentSessionId: 'content-shadow-1',
      sessionDbId: 111,
      project: 'alpha',
      platformSource: 'claude',
      selectedCount: 1,
      candidateCount: 3,
      estimatedInjectedTokens: 120,
      traceItems: [
        {
          observationId: 9001,
          title: 'Primary alpha recall',
          filePath: 'workspace/src/alpha-primary.ts',
        },
      ],
      shadowRanking: {
        productionRankerId: 'production_v1',
        experimentalRankerId: 'experimental_v1',
        productionCandidates: [
          { observationId: 9001, distance: 0.12, score: 0.91, title: 'Primary alpha recall' },
        ],
        experimentalCandidates: [
          { observationId: 9001, distance: 0.11, score: 0.88, title: 'Primary alpha recall' },
        ],
        productionSelectedObservationIds: [9001],
        experimentalSelectedObservationIds: [9001],
      },
    });

    store.recordMemoryAssistOutcomeSignal({
      contentSessionId: 'content-shadow-1',
      promptNumber: 3,
      sessionDbId: 111,
      project: 'alpha',
      platformSource: 'claude',
      signalType: 'tool_use',
      toolName: 'Edit',
      action: 'edit',
      filePath: 'workspace/src/alpha-primary.ts',
      relatedFilePaths: ['workspace/src/alpha-primary.ts'],
    });

    store.recordMemoryAssistDecision({
      source: 'semantic_prompt',
      status: 'skipped',
      reason: 'below_threshold',
      promptNumber: 4,
      contentSessionId: 'content-shadow-2',
      sessionDbId: 112,
      project: 'beta',
      platformSource: 'codex',
      candidateCount: 2,
      selectedCount: 0,
      estimatedInjectedTokens: 40,
      shadowRanking: {
        productionRankerId: 'production_v1',
        experimentalRankerId: 'experimental_v1',
        productionCandidates: [
          { observationId: 9101, distance: 0.41, score: 0.51, title: 'Beta candidate A' },
        ],
        experimentalCandidates: [
          { observationId: 9102, distance: 0.38, score: 0.62, title: 'Beta candidate B' },
        ],
        productionSelectedObservationIds: [9101],
        experimentalSelectedObservationIds: [9102],
      },
    });

    store.recordObservationTypeCorrection({
      modeId: 'code',
      originalType: 'code-path-inspection',
      normalizedType: 'discovery',
      fallbackType: 'bugfix',
      strategy: 'alias',
      correlationId: 'alpha-1',
      project: 'alpha',
      platformSource: 'claude',
    });

    const dashboard = store.getMemoryAssistDashboard(30);
    expect(dashboard.availableProjects).toEqual(['alpha', 'beta']);
    expect(dashboard.projectStats.alpha.injected).toBe(1);
    expect(dashboard.projectStats.alpha.likelyHelped).toBe(1);
    expect(dashboard.projectStats.alpha.estimatedInjectedTokens).toBe(120);
    expect(dashboard.projectStats.alpha.taxonomyCorrectionCount).toBe(1);
    expect(dashboard.sourceStats.semantic_prompt.taxonomyCorrectionCount).toBeNull();
    expect(dashboard.sourceStats.file_context.taxonomyCorrectionCount).toBeNull();
    expect(dashboard.projectSourceStats['alpha::semantic_prompt'].injectRate).toBe(100);
    expect(dashboard.projectSourceStats['beta::semantic_prompt'].injectRate).toBe(0);
    expect(dashboard.projectSourceStats['alpha::semantic_prompt'].taxonomyCorrectionCount).toBeNull();
    expect(dashboard.projectSourceStats['beta::semantic_prompt'].taxonomyCorrectionCount).toBeNull();
    expect(dashboard.projectStats.alpha.recommendation.slice).toEqual({
      scope: 'project',
      key: 'alpha',
      project: 'alpha',
    });
    expect(dashboard.projectSourceStats['alpha::semantic_prompt'].recommendation.slice).toEqual({
      scope: 'project_source',
      key: 'alpha::semantic_prompt',
      project: 'alpha',
      source: 'semantic_prompt',
    });
    expect(dashboard.shadowRanking?.totalCompared).toBe(2);
    expect(dashboard.shadowRanking?.exactMatches).toBe(1);
    expect(dashboard.shadowRanking?.divergentSelections).toBe(1);
    expect(dashboard.shadowRanking?.likelyHelpedWithExperimentalOverlap).toBe(1);
    expect(dashboard.sourceStats.semantic_prompt.shadowRanking?.totalCompared).toBe(2);
  });

  it('includes taxonomy correction counts in the dashboard payload', () => {
    store.recordObservationTypeCorrection({
      modeId: 'code',
      originalType: 'code-path-inspection',
      normalizedType: 'discovery',
      fallbackType: 'bugfix',
      strategy: 'alias',
      correlationId: 'session-1',
      project: 'claude-mem',
      platformSource: 'claude',
    });

    const dashboard = store.getMemoryAssistDashboard(30);
    expect(dashboard.taxonomyCorrections.total).toBe(1);
    expect(dashboard.taxonomyCorrections.aliases[0]).toEqual({
      originalType: 'code-path-inspection',
      normalizedType: 'discovery',
      count: 1,
    });
  });

  it('backfills missing system evidence for recent injected decisions', () => {
    const decision = store.recordMemoryAssistDecision({
      source: 'file_context',
      status: 'injected',
      reason: 'timeline_injected',
      promptNumber: 1,
      contentSessionId: 'content-6',
      sessionDbId: 94,
      project: 'claude-mem',
      traceItems: [
        {
          observationId: 401,
          title: 'Primary file',
          filePath: 'workspace/service/primary-file.py',
        },
      ],
    });

    store.recordMemoryAssistOutcomeSignal({
      contentSessionId: 'content-6',
      promptNumber: 1,
      sessionDbId: 94,
      project: 'claude-mem',
      signalType: 'tool_use',
      toolName: 'Edit',
      action: 'edit',
      filePath: 'workspace/service/primary-file.py',
      relatedFilePaths: ['workspace/service/primary-file.py'],
    });

    (store as any).db.run(
      'UPDATE memory_assist_decisions SET system_evidence_json = NULL WHERE id = ?',
      decision.id
    );

    const [backfilled] = store.backfillRecentMemoryAssistEvidence({
      limit: 10,
      windowDays: 30,
    });

    expect(backfilled.id).toBe(decision.id);
    expect(backfilled.systemEvidence?.usedOutcomes).toHaveLength(1);
    expect(backfilled.systemEvidence?.usedOutcomes[0]?.filePath).toBe('workspace/service/primary-file.py');
  });

  it('backfills recent observation origins only when exact generated ids are available', () => {
    const contentSessionId = 'content-origin-2';
    const filePath = 'workspace/service/secondary-file.py';
    const { sessionDbId, observationId } = createStoredObservation({
      contentSessionId,
      memorySessionId: 'memory-origin-2',
      filePath,
      promptNumber: 2,
    });

    const decision = store.recordMemoryAssistDecision({
      source: 'file_context',
      status: 'injected',
      reason: 'timeline_injected',
      promptNumber: 2,
      contentSessionId,
      sessionDbId,
      project: 'claude-mem',
      traceItems: [
        {
          observationId,
          title: 'Secondary file',
          filePath,
        },
      ],
    });

    const signal = store.recordMemoryAssistOutcomeSignal({
      decisionId: decision.id,
      contentSessionId,
      promptNumber: 2,
      sessionDbId,
      project: 'claude-mem',
      pendingMessageId: 8102,
      signalType: 'tool_use',
      toolName: 'Read',
      action: 'read',
      filePath,
      relatedFilePaths: [filePath],
    });

    store.attachGeneratedObservationsToOutcomeSignal(signal.pendingMessageId!, [observationId]);
    expect(store.getObservationOrigin(observationId)).toBeNull();

    const backfill = store.backfillRecentObservationOrigins({
      limit: 10,
      windowDays: 30,
    });

    expect(backfill.resolvedCount).toBeGreaterThanOrEqual(1);
    expect(backfill.unresolvedCount).toBe(0);

    const origin = store.getObservationOrigin(observationId);
    expect(origin).not.toBeNull();
    expect(origin?.pendingMessageId).toBe(8102);
    expect(origin?.toolName).toBe('Read');
    expect(origin?.action).toBe('read');
    expect(origin?.decisionId).toBe(decision.id);
    expect(origin?.filePath).toBe(filePath);
  });

  it('backfills recent file-context token estimates from persisted trace items', () => {
    const decision = store.recordMemoryAssistDecision({
      source: 'file_context',
      status: 'injected',
      reason: 'timeline_injected',
      promptNumber: 1,
      contentSessionId: 'content-file-tokens',
      sessionDbId: 95,
      project: 'claude-mem',
      filePath: 'workspace/ui/score-pill.tsx',
      traceItems: [
        {
          observationId: 6101,
          title: 'Score pill styling reuse',
          type: 'discovery',
          createdAtEpoch: Date.now(),
          filePath: 'workspace/ui/score-pill.tsx',
        },
      ],
    });

    expect(decision.estimatedInjectedTokens).toBeUndefined();

    const result = store.backfillRecentFileContextTokenEstimates({
      limit: 10,
      windowDays: 30,
    });

    expect(result.updatedCount).toBe(1);

    const [updated] = store.getRecentMemoryAssistDecisions({
      limit: 1,
      contentSessionId: 'content-file-tokens',
    });
    expect(updated?.estimatedInjectedTokens).toBeGreaterThan(0);
  });

  describe('outcome-signal → decision resolver (multi-candidate)', () => {
    function injectFileContextDecision(input: {
      contentSessionId: string;
      promptNumber: number;
      filePath: string;
      createdAtEpoch: number;
    }) {
      return store.recordMemoryAssistDecision({
        source: 'file_context',
        status: 'injected',
        reason: 'timeline_injected',
        promptNumber: input.promptNumber,
        contentSessionId: input.contentSessionId,
        sessionDbId: 42,
        project: 'claude-mem',
        timestamp: input.createdAtEpoch,
        traceItems: [
          { observationId: Math.floor(Math.random() * 1e6), title: 'x', filePath: input.filePath },
        ],
      });
    }

    it('#1 with 5 injected file_context decisions and signal path overlapping 3 of them, links to the MOST RECENT overlapping', () => {
      const session = 'resolver-overlap-multi';
      const now = Date.now();
      const overlappingPath = 'workspace/shared/target.ts';

      const overlap1 = injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: overlappingPath, createdAtEpoch: now - 10_000 });
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'workspace/other/a.ts', createdAtEpoch: now - 9_000 });
      const overlap2 = injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: overlappingPath, createdAtEpoch: now - 8_000 });
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'workspace/other/b.ts', createdAtEpoch: now - 7_000 });
      const overlap3 = injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: overlappingPath, createdAtEpoch: now - 6_000 });

      const signal = store.recordMemoryAssistOutcomeSignal({
        contentSessionId: session,
        promptNumber: 1,
        sessionDbId: 42,
        project: 'claude-mem',
        signalType: 'tool_use',
        toolName: 'Read',
        action: 'read',
        filePath: overlappingPath,
        relatedFilePaths: [overlappingPath],
      });

      expect(signal.decisionId).toBe(overlap3.id);
      expect(signal.decisionId).not.toBe(overlap1.id);
      expect(signal.decisionId).not.toBe(overlap2.id);
    });

    it('#2 with 5 injected file_context decisions and a Bash tool call (no file path), links to the nearest-in-time injected decision at-or-before the signal', () => {
      const session = 'resolver-bash-nearest';
      const now = Date.now();

      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'a.ts', createdAtEpoch: now - 20_000 });
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'b.ts', createdAtEpoch: now - 15_000 });
      const preceding = injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'c.ts', createdAtEpoch: now - 10_000 });
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'd.ts', createdAtEpoch: now + 5_000 });
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'e.ts', createdAtEpoch: now + 10_000 });

      const signal = store.recordMemoryAssistOutcomeSignal({
        contentSessionId: session,
        promptNumber: 1,
        sessionDbId: 42,
        project: 'claude-mem',
        signalType: 'tool_use',
        toolName: 'Bash',
        action: 'command',
        filePath: null,
        relatedFilePaths: [],
        timestamp: now,
      });

      expect(signal.decisionId).toBe(preceding.id);
    });

    it('#3 with mixed injected sources and a signal that overlaps none, links to the nearest-in-time injected decision', () => {
      const session = 'resolver-mixed-sources';
      const now = Date.now();

      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'workspace/file.ts', createdAtEpoch: now - 20_000 });

      const earlierSemantic = store.recordMemoryAssistDecision({
        source: 'semantic_prompt',
        status: 'injected',
        reason: 'semantic_match',
        promptNumber: 1,
        contentSessionId: session,
        sessionDbId: 42,
        project: 'claude-mem',
        timestamp: now - 15_000,
        traceItems: [{ observationId: 501, title: 'sem-1' }],
      });

      const laterSemantic = store.recordMemoryAssistDecision({
        source: 'semantic_prompt',
        status: 'injected',
        reason: 'semantic_match',
        promptNumber: 1,
        contentSessionId: session,
        sessionDbId: 42,
        project: 'claude-mem',
        timestamp: now - 5_000,
        traceItems: [{ observationId: 502, title: 'sem-2' }],
      });

      const signal = store.recordMemoryAssistOutcomeSignal({
        contentSessionId: session,
        promptNumber: 1,
        sessionDbId: 42,
        project: 'claude-mem',
        signalType: 'tool_use',
        toolName: 'Edit',
        action: 'edit',
        filePath: 'workspace/unrelated.ts',
        relatedFilePaths: ['workspace/unrelated.ts'],
        timestamp: now,
      });

      // Semantic branch runs before the nearest-in-time fallback because both
      // semantic candidates are in the window; most-recent semantic wins.
      expect(signal.decisionId).toBe(laterSemantic.id);
      expect(signal.decisionId).not.toBe(earlierSemantic.id);
    });

    it('#4 with no injected candidates in window, returns null (skipped decisions do not match)', () => {
      const session = 'resolver-skipped-only';

      store.recordMemoryAssistDecision({
        source: 'file_context',
        status: 'skipped',
        reason: 'below_threshold',
        promptNumber: 1,
        contentSessionId: session,
        sessionDbId: 42,
        project: 'claude-mem',
        traceItems: [{ observationId: 601, title: 'x', filePath: 'workspace/skipped.ts' }],
      });

      const signal = store.recordMemoryAssistOutcomeSignal({
        contentSessionId: session,
        promptNumber: 1,
        sessionDbId: 42,
        project: 'claude-mem',
        signalType: 'tool_use',
        toolName: 'Read',
        action: 'read',
        filePath: 'workspace/skipped.ts',
        relatedFilePaths: ['workspace/skipped.ts'],
      });

      expect(signal.decisionId).toBeFalsy();
    });

    it('#5 returns null when contentSessionId is missing', () => {
      const session = 'resolver-no-session';
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'a.ts', createdAtEpoch: Date.now() });

      const signal = store.recordMemoryAssistOutcomeSignal({
        promptNumber: 1,
        sessionDbId: 42,
        project: 'claude-mem',
        signalType: 'tool_use',
        toolName: 'Read',
        action: 'read',
        filePath: 'a.ts',
        relatedFilePaths: ['a.ts'],
      });

      expect(signal.decisionId).toBeFalsy();
    });

    it('#6 returns null when promptNumber is missing', () => {
      const session = 'resolver-no-prompt';
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath: 'a.ts', createdAtEpoch: Date.now() });

      const signal = store.recordMemoryAssistOutcomeSignal({
        contentSessionId: session,
        sessionDbId: 42,
        project: 'claude-mem',
        signalType: 'tool_use',
        toolName: 'Read',
        action: 'read',
        filePath: 'a.ts',
        relatedFilePaths: ['a.ts'],
      });

      expect(signal.decisionId).toBeFalsy();
    });

    it('#7 regression: single overlapping candidate still links (pre-existing behavior preserved)', () => {
      const session = 'resolver-single-overlap';
      const filePath = 'workspace/only.ts';
      const only = injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath, createdAtEpoch: Date.now() });

      const signal = store.recordMemoryAssistOutcomeSignal({
        contentSessionId: session,
        promptNumber: 1,
        sessionDbId: 42,
        project: 'claude-mem',
        signalType: 'tool_use',
        toolName: 'Read',
        action: 'read',
        filePath,
        relatedFilePaths: [filePath],
      });

      expect(signal.decisionId).toBe(only.id);
    });

    it('relinkOrphanOutcomeSignal retroactively links a signal inserted with decision_id=NULL', () => {
      const session = 'resolver-relink';
      const filePath = 'workspace/retro.ts';
      const now = Date.now();
      injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath, createdAtEpoch: now - 5_000 });
      const target = injectFileContextDecision({ contentSessionId: session, promptNumber: 1, filePath, createdAtEpoch: now - 1_000 });

      // Insert a signal directly as orphan (simulate the old-resolver NULL path)
      const insertedId = store.db.prepare(`
        INSERT INTO memory_assist_outcome_signals (
          decision_id, content_session_id, session_db_id, project, signal_type,
          tool_name, action, file_path, related_file_paths_json, created_at_epoch, prompt_number
        ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session, 42, 'claude-mem', 'tool_use', 'Read', 'read', filePath,
        JSON.stringify([filePath]), now, 1).lastInsertRowid as number;

      const linkedDecisionId = store.relinkOrphanOutcomeSignal(insertedId);
      expect(linkedDecisionId).toBe(target.id);

      const row = store.db.prepare(`SELECT decision_id FROM memory_assist_outcome_signals WHERE id = ?`)
        .get(insertedId) as { decision_id: number };
      expect(row.decision_id).toBe(target.id);
    });

    it('listOrphanOutcomeSignalIds returns only rows with NULL decision_id and non-null session/prompt', () => {
      const session = 'resolver-list-orphans';
      const filePath = 'workspace/list.ts';
      const now = Date.now();

      // Orphan row within window
      store.db.prepare(`
        INSERT INTO memory_assist_outcome_signals (
          decision_id, content_session_id, session_db_id, project, signal_type,
          tool_name, action, file_path, created_at_epoch, prompt_number
        ) VALUES (NULL, ?, 42, 'claude-mem', 'tool_use', 'Read', 'read', ?, ?, 1)
      `).run(session, filePath, now);

      // Unlinkable (no content_session_id) — should NOT appear
      store.db.prepare(`
        INSERT INTO memory_assist_outcome_signals (
          decision_id, content_session_id, session_db_id, project, signal_type,
          tool_name, action, created_at_epoch, prompt_number
        ) VALUES (NULL, NULL, 42, 'claude-mem', 'tool_use', 'Read', 'read', ?, 1)
      `).run(now);

      const ids = store.listOrphanOutcomeSignalIds(now - 60_000);
      expect(ids.length).toBe(1);
    });
  });
});
