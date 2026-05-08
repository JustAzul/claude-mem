// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'events';
import { Database } from 'bun:sqlite';
import { SessionQueueProcessor, type CreateIteratorOptions } from '../../services/queue/SessionQueueProcessor.js';
import { PendingMessageStore } from '../../services/sqlite/PendingMessageStore.js';
import type { PendingMessage, PendingMessageWithId } from '../../services/worker-types.js';

export interface ObservationQueueEngine {
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number>;
  createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId>;
  confirmProcessed(messageId: number): Promise<number>;
  clearPendingForSession(sessionDbId: number): Promise<number>;
  resetProcessingToPending(sessionDbId: number): Promise<number>;
  getPendingCount(sessionDbId: number): Promise<number>;
  getTotalQueueDepth(): Promise<number>;
  close(): Promise<void>;
}

export interface ObservationQueueHealth {
  engine: 'bullmq';
  redis: {
    status: 'ok' | 'error';
    mode: string;
    host: string;
    port: number;
    prefix: string;
    error?: string;
  };
}

export interface ObservationQueueInspection {
  peekPendingTypes(sessionDbId: number): Promise<Array<{ message_type: string; tool_name: string | null }>>;
  tryClaimObservationBatch(sessionDbId: number, maxItems: number): Promise<PendingMessageWithId[]>;
}

export type InspectableObservationQueueEngine = ObservationQueueEngine & ObservationQueueInspection;
export type HealthCheckedObservationQueueEngine = InspectableObservationQueueEngine & {
  getHealth(): Promise<ObservationQueueHealth>;
  assertHealthy(): Promise<void>;
};

export class SqliteObservationQueueEngine implements InspectableObservationQueueEngine {
  private readonly store: PendingMessageStore;
  private readonly db: Database;
  private readonly eventsBySession = new Map<number, EventEmitter>();

  constructor(db: Database) {
    this.db = db;
    this.store = new PendingMessageStore(db);
  }

  async enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number> {
    const id = this.store.enqueue(sessionDbId, contentSessionId, message);
    if (id > 0) {
      this.emit(sessionDbId);
    }
    return id;
  }

  createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const processor = new SessionQueueProcessor(this.store, this.getEvents(options.sessionDbId));
    return processor.createIterator(options);
  }

  async confirmProcessed(messageId: number): Promise<number> {
    this.store.confirmProcessed(messageId);
    return 1;
  }

  async clearPendingForSession(sessionDbId: number): Promise<number> {
    const rows = this.store.clearPendingForSession(sessionDbId);
    if (rows > 0) {
      this.emit(sessionDbId);
    }
    return rows;
  }

  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const rows = this.store.resetProcessingToPending(sessionDbId);
    if (rows > 0) {
      this.emit(sessionDbId);
    }
    return rows;
  }

  async getPendingCount(sessionDbId: number): Promise<number> {
    return this.store.getPendingCount(sessionDbId);
  }

  async getTotalQueueDepth(): Promise<number> {
    return this.store.getTotalQueueDepth();
  }

  async peekPendingTypes(sessionDbId: number): Promise<Array<{ message_type: string; tool_name: string | null }>> {
    return this.store.peekPendingTypes(sessionDbId);
  }

  markAllSessionMessagesAbandoned(sessionDbId: number): number {
    return this.store.markAllSessionMessagesAbandoned(sessionDbId);
  }

  requeueInFlightForSession(sessionDbId: number): number {
    return this.store.requeueInFlightForSession(sessionDbId);
  }

  async tryClaimObservationBatch(sessionDbId: number, maxItems: number): Promise<PendingMessageWithId[]> {
    if (maxItems <= 0) return [];
    const msgs = this.store.claimObservationBatch(sessionDbId, maxItems);
    return msgs.map(msg => ({
      ...this.store.toPendingMessage(msg),
      _persistentId: msg.id,
      _originalTimestamp: msg.created_at_epoch,
    }));
  }

  async close(): Promise<void> {
    for (const events of this.eventsBySession.values()) {
      events.removeAllListeners();
    }
    this.eventsBySession.clear();
  }

  private getEvents(sessionDbId: number): EventEmitter {
    let events = this.eventsBySession.get(sessionDbId);
    if (!events) {
      events = new EventEmitter();
      this.eventsBySession.set(sessionDbId, events);
    }
    return events;
  }

  private emit(sessionDbId: number): void {
    this.eventsBySession.get(sessionDbId)?.emit('message');
  }
}
