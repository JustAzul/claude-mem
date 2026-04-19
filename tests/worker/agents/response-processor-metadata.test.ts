import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

// Mock modules that cause import chain issues - MUST be before imports
mock.module('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'discovery' },
          { id: 'feature' },
          { id: 'bugfix' },
          { id: 'refactor' },
          { id: 'change' },
          { id: 'decision' },
        ],
        observation_concepts: [
          { id: 'how-it-works' },
          { id: 'why-it-exists' },
          { id: 'what-changed' },
          { id: 'problem-solution' },
          { id: 'gotcha' },
          { id: 'pattern' },
          { id: 'trade-off' },
        ],
      }),
    }),
  },
}));

import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { ToolContext } from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

// Minimal XML observation with a deliberate LLM type that post-processing should override.
// Includes <why> so the OBS_GATE gate (bugfix/decision require <why>) does not downgrade
// the type unexpectedly — these tests target metadata override, not the gate.
function makeObsXml(type: string = 'feature', concepts: string[] = ['how-it-works']): string {
  const conceptsXml = concepts.map(c => `<concept>${c}</concept>`).join('\n    ');
  return `<observation>
  <type>${type}</type>
  <title>Test observation</title>
  <narrative>Some narrative text.</narrative>
  <why>Test rationale to satisfy OBS_GATE gate</why>
  <facts><fact>A fact</fact></facts>
  <concepts>
    ${conceptsXml}
  </concepts>
</observation>`;
}

describe('ResponseProcessor — deterministic metadata override', () => {
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let mockWorker: WorkerRef;

  function buildDbManager(storeFn: ReturnType<typeof mock>): DatabaseManager {
    return {
      getSessionStore: () => ({
        storeObservations: storeFn,
        attachGeneratedObservationsToOutcomeSignal: mock(() => null),
        attachObservationOriginsToPendingMessage: mock(() => []),
        ensureMemorySessionIdRegistered: mock(() => {}),
        recordObservationTypeCorrection: mock(() => {}),
        insertContextOrigin: mock(() => null),
      }),
      getChromaSync: () => null,
    } as unknown as DatabaseManager;
  }

  function createMockSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
    return {
      sessionDbId: 1,
      contentSessionId: 'content-session-test',
      memorySessionId: 'memory-session-test',
      project: 'test-project',
      platformSource: 'claude-code',
      userPrompt: 'test prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: 'claude',
      consecutiveRestarts: 0,
      lastGeneratorActivity: Date.now(),
      processingMessageIds: [],
      ...overrides,
    };
  }

  async function run(
    xml: string,
    toolContext: ToolContext | undefined
  ): Promise<Parameters<typeof mockStoreObservations.mock.calls[0]>> {
    await processAgentResponse(
      xml,
      createMockSession(),
      mockDbManager,
      mockSessionManager,
      mockWorker,
      0,
      null,
      'Test',
      undefined,
      undefined,
      toolContext
    );
    return mockStoreObservations.mock.calls[0] as any;
  }

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: 1700000000000,
    } as StorageResult));

    mockDbManager = buildDbManager(mockStoreObservations);

    mockSessionManager = {
      getPendingMessageStore: () => ({
        confirmProcessed: mock(() => {}),
      }),
    } as unknown as SessionManager;

    mockWorker = {
      sseBroadcaster: { broadcast: mock(() => {}) },
      broadcastProcessingStatus: mock(() => {}),
    };
  });

  afterEach(() => {
    loggerSpies.forEach(s => s.mockRestore());
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // Read tool
  // -------------------------------------------------------------------------

  it('Read tool: files_read=[file_path], files_modified=[], type=discovery even if LLM said feature', async () => {
    const xml = makeObsXml('feature');
    const [, , observations] = await run(xml, {
      tool_name: 'Read',
      tool_input: { file_path: 'src/auth.ts' },
    });

    expect(observations).toHaveLength(1);
    expect(observations[0].files_read).toEqual(['src/auth.ts']);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('discovery');
  });

  it('Read tool with null file_path: files_read=[], no crash', async () => {
    const [, , observations] = await run(makeObsXml('feature'), {
      tool_name: 'Read',
      tool_input: { file_path: null },
    });

    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('discovery');
  });

  it('Read tool with missing file_path key: files_read=[], no crash', async () => {
    const [, , observations] = await run(makeObsXml('feature'), {
      tool_name: 'Read',
      tool_input: {},
    });

    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].files_modified).toEqual([]);
  });

  it('Read tool with tool_input as JSON string: extracts file_path via parse', async () => {
    const [, , observations] = await run(makeObsXml('feature'), {
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: 'src/queued.ts' }) as unknown as Record<string, unknown>,
    });

    expect(observations[0].files_read).toEqual(['src/queued.ts']);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('discovery');
  });

  it('Read tool with malformed JSON string: files_read=[], no crash', async () => {
    const [, , observations] = await run(makeObsXml('feature'), {
      tool_name: 'Read',
      tool_input: '{not valid json' as unknown as Record<string, unknown>,
    });

    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('discovery');
  });

  // -------------------------------------------------------------------------
  // Grep tool
  // -------------------------------------------------------------------------

  it('Grep tool with path: files_read=[path], type=discovery', async () => {
    const [, , observations] = await run(makeObsXml('feature'), {
      tool_name: 'Grep',
      tool_input: { pattern: 'auth', path: 'src/' },
    });

    expect(observations[0].files_read).toEqual(['src/']);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('discovery');
  });

  it('Grep tool without path: files_read=[], type=discovery', async () => {
    const [, , observations] = await run(makeObsXml('bugfix'), {
      tool_name: 'Grep',
      tool_input: { pattern: 'auth' },
    });

    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].type).toBe('discovery');
  });

  // -------------------------------------------------------------------------
  // Edit tool
  // -------------------------------------------------------------------------

  it('Edit tool: files_modified=[file_path], files_read=[], type preserved from LLM', async () => {
    const [, , observations] = await run(makeObsXml('bugfix'), {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts' },
    });

    expect(observations[0].files_modified).toEqual(['src/auth.ts']);
    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].type).toBe('bugfix');
  });

  // -------------------------------------------------------------------------
  // Write tool
  // -------------------------------------------------------------------------

  it('Write tool: files_modified=[file_path], type preserved', async () => {
    const [, , observations] = await run(makeObsXml('feature'), {
      tool_name: 'Write',
      tool_input: { file_path: 'src/newfile.ts' },
    });

    expect(observations[0].files_modified).toEqual(['src/newfile.ts']);
    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].type).toBe('feature');
  });

  // -------------------------------------------------------------------------
  // MultiEdit tool
  // -------------------------------------------------------------------------

  it('MultiEdit tool: files_modified=[file_path], type preserved', async () => {
    const [, , observations] = await run(makeObsXml('refactor'), {
      tool_name: 'MultiEdit',
      tool_input: { file_path: 'src/big.ts' },
    });

    expect(observations[0].files_modified).toEqual(['src/big.ts']);
    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].type).toBe('refactor');
  });

  // -------------------------------------------------------------------------
  // Bash tool
  // -------------------------------------------------------------------------

  it('Bash tool: files_read=[], files_modified=[], type preserved', async () => {
    const [, , observations] = await run(makeObsXml('change'), {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('change');
  });

  // -------------------------------------------------------------------------
  // Unknown tool
  // -------------------------------------------------------------------------

  it('Unknown tool: files stay empty, type preserved, warning logged', async () => {
    const [, , observations] = await run(makeObsXml('discovery'), {
      tool_name: 'UnknownTool',
      tool_input: {},
    });

    expect(observations[0].files_read).toEqual([]);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('discovery');
    expect(logger.warn).toHaveBeenCalledWith(
      'TOOL_CONTEXT',
      'Unknown tool name; file metadata left empty',
      expect.objectContaining({ toolName: 'UnknownTool' })
    );
  });

  // -------------------------------------------------------------------------
  // Multiple observations from a single tool call
  // -------------------------------------------------------------------------

  it('Read tool with 2 observations: both get same deterministic metadata applied', async () => {
    // Production regularly returns 2-3 <observation> blocks per tool call.
    // The for-loop in ResponseProcessor must apply the same metadata to every one.
    const xml = `${makeObsXml('feature', ['how-it-works'])}
${makeObsXml('bugfix', ['gotcha'])}`;

    const multiStoreFn = mock(() => ({
      observationIds: [1, 2],
      summaryId: null,
      createdAtEpoch: 1700000000000,
    } as StorageResult));
    const multiDbManager = buildDbManager(multiStoreFn);

    await processAgentResponse(
      xml,
      createMockSession(),
      multiDbManager,
      mockSessionManager,
      mockWorker,
      0,
      null,
      'Test',
      undefined,
      undefined,
      {
        tool_name: 'Read',
        tool_input: { file_path: 'src/multi.ts' },
      }
    );

    const [, , observations] = multiStoreFn.mock.calls[0] as any;

    expect(observations).toHaveLength(2);
    expect(observations[0].files_read).toEqual(['src/multi.ts']);
    expect(observations[0].files_modified).toEqual([]);
    expect(observations[0].type).toBe('discovery');
    expect(observations[1].files_read).toEqual(['src/multi.ts']);
    expect(observations[1].files_modified).toEqual([]);
    expect(observations[1].type).toBe('discovery');
  });

  // -------------------------------------------------------------------------
  // No tool context (undefined) — baseline: no post-processing applied
  // -------------------------------------------------------------------------

  it('No toolContext: LLM-provided files_read and type are preserved unchanged', async () => {
    const xml = `<observation>
  <type>discovery</type>
  <title>Test</title>
  <narrative>narrative</narrative>
  <facts><fact>A fact</fact></facts>
  <concepts><concept>how-it-works</concept></concepts>
  <files_read><file>src/from-llm.ts</file></files_read>
  <files_modified></files_modified>
</observation>`;

    const [, , observations] = await run(xml, undefined);

    expect(observations[0].files_read).toEqual(['src/from-llm.ts']);
    expect(observations[0].type).toBe('discovery');
  });
});
