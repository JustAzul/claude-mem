import { describe, expect, it } from 'bun:test';
import { PromptSemanticAssistService } from '../../../src/services/worker/context/PromptSemanticAssistService.js';

describe('PromptSemanticAssistService', () => {
  it('skips injection when best match is above threshold', async () => {
    const service = new PromptSemanticAssistService(
      {
        getObservationsByIds: () => [],
      } as any,
      {
        queryChroma: async () => ({
          ids: [101, 202],
          distances: [0.52, 0.61],
          metadatas: [{}, {}],
        }),
      } as any
    );

    const result = await service.evaluate({
      query: 'Investigate how the scheduler and web appointment flow interact.',
      project: 'kb-server',
      threshold: 0.35,
      limit: 5,
    });

    expect(result.context).toBe('');
    expect(result.count).toBe(0);
    expect(result.decision.status).toBe('skipped');
    expect(result.decision.reason).toBe('below_threshold');
    expect(result.decision.bestDistance).toBe(0.52);
  });

  it('injects only hydrated matches that pass the threshold', async () => {
    const service = new PromptSemanticAssistService(
      {
        getObservationsByIds: (ids: number[]) => ids.map((id) => ({
          id,
          title: `Observation ${id}`,
          narrative: `Narrative ${id}`,
          text: null,
          facts: null,
          concepts: JSON.stringify(['pattern']),
          files_read: JSON.stringify([`src/${id}.ts`]),
          files_modified: JSON.stringify(id === 303 ? ['src/target.ts'] : []),
          relevance_count: id === 303 ? 2 : 0,
          created_at_epoch: Date.now(),
          created_at: '2026-04-17T21:00:00.000Z',
        })),
      } as any,
      {
        queryChroma: async () => ({
          ids: [303, 404, 505],
          distances: [0.18, 0.29, 0.47],
          metadatas: [{}, {}, {}],
        }),
      } as any
    );

    const result = await service.evaluate({
      query: 'Summarize the recent websocket session lifecycle fixes and failure handling.',
      project: 'llm-gateway',
      threshold: 0.35,
      limit: 5,
      sessionDbId: 72,
    });

    expect(result.count).toBe(2);
    expect(result.context).toContain('Observation 303');
    expect(result.context).toContain('Observation 404');
    expect(result.context).not.toContain('Observation 505');
    expect(result.decision.status).toBe('injected');
    expect(result.decision.selectedCount).toBe(2);
    expect(result.decision.candidateCount).toBe(3);
    expect(result.decision.bestDistance).toBe(0.18);
    expect(result.decision.worstDistance).toBe(0.29);
    expect(result.decision.estimatedInjectedTokens).toBeGreaterThan(0);
    expect(result.decision.shadowRanking?.productionRankerId).toBe('production_v1');
    expect(result.decision.shadowRanking?.experimentalRankerId).toBe('experimental_v1');
    expect(result.decision.shadowRanking?.productionCandidates).toHaveLength(2);
    expect(result.decision.traceItems?.[0]?.relatedFilePaths).toContain('src/target.ts');
  });

  it('skips cleanly when semantic search is unavailable', async () => {
    const service = new PromptSemanticAssistService(
      {
        getObservationsByIds: () => [],
      } as any,
      null
    );

    const result = await service.evaluate({
      query: 'Need background on the memory assist pipeline to explain it in the UI.',
      project: 'claude-mem',
    });

    expect(result.context).toBe('');
    expect(result.decision.status).toBe('skipped');
    expect(result.decision.reason).toBe('semantic_search_unavailable');
  });
});
