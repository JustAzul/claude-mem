import React from 'react';
import type { MemoryAssistEvent } from '../../../../shared/memory-assist';
import { eventKey, eventListSummary, formatTimestamp } from './shared';

interface MemoryAssistActivityListProps {
  events: MemoryAssistEvent[];
  safeThreshold: number;
  selectedTraceKey: string | null;
  onToggleTrace: (key: string) => void;
}

export function MemoryAssistActivityList({
  events,
  safeThreshold,
  selectedTraceKey,
  onToggleTrace,
}: MemoryAssistActivityListProps) {
  const traceLinkColor = '#3b82f6';
  if (events.length === 0) return null;

  return (
    <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
        Recent activity · last 30d
      </div>
      {events.slice(0, 8).map((event, index) => {
        const key = eventKey(event, index);
        const traceable = !!event.traceItems?.length;
        const selected = selectedTraceKey === key;

        return (
          <div
            key={key}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
              fontSize: 13,
              color: 'var(--color-text-primary)',
              paddingTop: index === 0 ? 4 : 8,
              paddingBottom: 2,
              borderTop: index === 0 ? 'none' : '1px solid var(--color-border-primary)',
            }}
          >
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={{ color: 'var(--color-text-primary)' }}>{eventListSummary(event, safeThreshold)}</span>
              {traceable && (
                <button
                  type="button"
                  onClick={() => onToggleTrace(key)}
                  style={{
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 12,
                    color: traceLinkColor,
                    WebkitTextFillColor: traceLinkColor,
                    opacity: 1,
                    textDecoration: 'underline',
                    textUnderlineOffset: 2,
                    fontWeight: 700,
                    fontFamily: 'inherit',
                  }}
                >
                  {selected ? 'Hide trace' : 'Trace what was used'}
                </button>
              )}
            </div>
            <span style={{ color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>{formatTimestamp(event.timestamp)}</span>
          </div>
        );
      })}
    </div>
  );
}
