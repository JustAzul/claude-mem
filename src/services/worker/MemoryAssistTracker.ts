import type { SSEBroadcaster } from './SSEBroadcaster.js';
import type { MemoryAssistEvent, MemoryAssistReport } from '../../shared/memory-assist.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_RECENT_EVENT_LIMIT = 100;

export class MemoryAssistTracker {
  private readonly events: MemoryAssistEvent[] = [];

  constructor(
    private readonly sseBroadcaster: SSEBroadcaster,
    private readonly recentLimit = DEFAULT_RECENT_EVENT_LIMIT
  ) {}

  private normalizeAndTrim(events: MemoryAssistEvent[]): MemoryAssistEvent[] {
    const seen = new Set<string>();
    const normalized = events
      .map((event) => ({
        ...event,
        timestamp: event.timestamp ?? Date.now(),
      }))
      .sort((left, right) => right.timestamp - left.timestamp)
      .filter((event) => {
        const key = event.id != null
          ? `id:${event.id}`
          : `${event.source}:${event.status}:${event.reason}:${event.timestamp}:${event.contentSessionId ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    return normalized.slice(0, this.recentLimit);
  }

  hydrate(events: MemoryAssistEvent[]): void {
    logger.debug('WORKER', 'Hydrating memory assist tracker from persisted decisions', {
      count: events.length,
    });
    const hydrated = this.normalizeAndTrim(events);
    this.events.splice(0, this.events.length, ...hydrated);
  }

  record(event: MemoryAssistReport): MemoryAssistEvent {
    logger.debug('WORKER', 'Recording memory assist event', {
      decisionId: event.id ?? null,
      source: event.source,
      status: event.status,
      reason: event.reason,
    });

    const normalized = this.normalizeAndTrim([
      event as MemoryAssistEvent,
      ...this.events,
    ])[0]!;

    this.events.splice(0, this.events.length, ...this.normalizeAndTrim([
      normalized,
      ...this.events,
    ]));

    this.sseBroadcaster.broadcast({
      type: 'memory_assist_status',
      memoryAssist: normalized,
    });

    return normalized;
  }

  getRecent(limit = this.recentLimit): MemoryAssistEvent[] {
    return this.events.slice(0, Math.max(limit, 0));
  }
}
