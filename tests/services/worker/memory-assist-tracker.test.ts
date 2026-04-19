import { describe, expect, it } from 'bun:test';
import { MemoryAssistTracker } from '../../../src/services/worker/MemoryAssistTracker.js';
import type { MemoryAssistEvent } from '../../../src/shared/memory-assist.js';

function createEvent(overrides: Partial<MemoryAssistEvent> = {}): MemoryAssistEvent {
  return {
    id: overrides.id ?? 1,
    source: overrides.source ?? 'semantic_prompt',
    status: overrides.status ?? 'injected',
    reason: overrides.reason ?? 'matched',
    timestamp: overrides.timestamp ?? Date.now(),
    ...overrides,
  };
}

describe('MemoryAssistTracker', () => {
  it('hydrates recent events from persisted decisions in descending timestamp order', () => {
    const broadcasts: unknown[] = [];
    const tracker = new MemoryAssistTracker({
      broadcast(event: unknown) {
        broadcasts.push(event);
      },
    } as any, 3);

    tracker.hydrate([
      createEvent({ id: 10, timestamp: 1000 }),
      createEvent({ id: 30, timestamp: 3000 }),
      createEvent({ id: 20, timestamp: 2000 }),
      createEvent({ id: 30, timestamp: 3000 }),
    ]);

    expect(tracker.getRecent().map((event) => event.id)).toEqual([30, 20, 10]);
    expect(broadcasts.length).toBe(0);
  });

  it('keeps hydrated history and prepends newly recorded events', () => {
    const tracker = new MemoryAssistTracker({
      broadcast() {
        return;
      },
    } as any, 5);

    tracker.hydrate([
      createEvent({ id: 1, timestamp: 1000 }),
      createEvent({ id: 2, timestamp: 2000 }),
    ]);

    tracker.record(createEvent({ id: 3, timestamp: 3000 }));

    expect(tracker.getRecent().map((event) => event.id)).toEqual([3, 2, 1]);
  });
});
