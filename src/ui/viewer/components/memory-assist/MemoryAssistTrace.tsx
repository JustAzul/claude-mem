import React from 'react';
import type { MemoryAssistEvent } from '../../../../shared/memory-assist';
import type { FeedbackLabel, ObservationTraceDetail } from './shared';
import { MemoryAssistOutcomeCard } from './MemoryAssistOutcomeCard';
import {
  distanceAssessment,
  formatEvidenceStrength,
  formatDateTime,
  formatSignalSource,
  formatTimestamp,
  normalizeTraceBody,
  outcomeKeyFromParts,
  redactPathForDisplay,
  sourceLabel,
  traceSummary,
} from './shared';

interface MemoryAssistTraceProps {
  event: MemoryAssistEvent;
  safeThreshold: number;
  selectedFeedback: FeedbackLabel | null;
  submittingFeedback: FeedbackLabel | null;
  feedbackError: string | null;
  openObservationId: number | null;
  detailCache: Record<number, ObservationTraceDetail | null>;
  loadingObservationId: number | null;
  detailError: string | null;
  onSubmitFeedback: (label: FeedbackLabel) => void;
  onClose: () => void;
  onToggleObservation: (observationId: number) => void;
  onOpenTrace?: (observationId: number) => void;
}

export function MemoryAssistTrace({
  event,
  safeThreshold,
  selectedFeedback,
  submittingFeedback,
  feedbackError,
  openObservationId,
  detailCache,
  loadingObservationId,
  detailError,
  onSubmitFeedback,
  onClose,
  onToggleObservation,
  onOpenTrace,
}: MemoryAssistTraceProps) {
  if (!event.traceItems?.length) return null;

  const traceCardBg = 'var(--color-bg-card)';
  const traceCardBorder = 'var(--color-border-primary)';
  const headingColor = 'var(--color-text-header)';
  const bodyColor = 'var(--color-text-primary)';
  const mutedColor = 'var(--color-text-secondary)';
  const helperColor = 'var(--color-text-muted)';
  const linkColor = 'var(--color-accent-primary)';
  const outcomeChipBg = 'color-mix(in srgb, var(--color-accent-primary) 10%, transparent)';
  const outcomeCardBg = 'color-mix(in srgb, var(--color-bg-card-hover) 72%, var(--color-bg-card))';
  const excludedObservationIds = React.useMemo(
    () => new Set(event.traceItems.map((item) => item.observationId)),
    [event.traceItems]
  );
  const [focusedOutcomeKey, setFocusedOutcomeKey] = React.useState<string | null>(null);
  const outcomeNodesRef = React.useRef<Record<string, HTMLDivElement | null>>({});
  const outcomeEntries = React.useMemo(() => {
    const used = (event.systemEvidence?.usedOutcomes ?? []).map((outcome, index) => ({
      kind: 'used' as const,
      outcome,
      key: outcomeKeyFromParts({
        outcomeId: outcome.outcomeId,
        pendingMessageId: outcome.pendingMessageId,
        toolName: outcome.toolName,
        action: outcome.action,
        filePath: outcome.filePath,
        timestamp: outcome.timestamp,
      }) || `used:${index}`,
    }));
    const ignored = (event.systemEvidence?.ignoredOutcomes ?? []).map((outcome, index) => ({
      kind: 'ignored' as const,
      outcome,
      key: outcomeKeyFromParts({
        outcomeId: outcome.outcomeId,
        pendingMessageId: outcome.pendingMessageId,
        toolName: outcome.toolName,
        action: outcome.action,
        filePath: outcome.filePath,
        timestamp: outcome.timestamp,
      }) || `ignored:${index}`,
    }));
    return [...used, ...ignored];
  }, [event.systemEvidence?.ignoredOutcomes, event.systemEvidence?.usedOutcomes]);
  const exactLinkedOutcomeCount = React.useMemo(
    () => outcomeEntries.filter((entry) => entry.outcome.signalSource === 'exact_observation_link').length,
    [outcomeEntries]
  );

  React.useEffect(() => {
    setFocusedOutcomeKey(null);
  }, [event.id, event.timestamp]);

  React.useEffect(() => {
    if (!focusedOutcomeKey) return;
    const node = outcomeNodesRef.current[focusedOutcomeKey];
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedOutcomeKey]);

  function registerOutcomeNode(key: string, node: HTMLDivElement | null): void {
    if (node) {
      outcomeNodesRef.current[key] = node;
      return;
    }
    delete outcomeNodesRef.current[key];
  }

  function matchOutcomeKeyForOrigin(origin: NonNullable<ObservationTraceDetail['origin']>): string | null {
    if (!event.systemEvidence) return null;
    const byPending = outcomeEntries.find((entry) => {
      return origin.pendingMessageId != null
        && entry.outcome.pendingMessageId != null
        && entry.outcome.pendingMessageId === origin.pendingMessageId;
    });
    if (byPending) return byPending.key;

    const normalizedOriginFile = origin.filePath?.replace(/\\/g, '/').trim().toLowerCase();
    const byShape = outcomeEntries.find((entry) => {
      const normalizedOutcomeFile = entry.outcome.filePath?.replace(/\\/g, '/').trim().toLowerCase();
      return entry.outcome.toolName === origin.toolName
        && entry.outcome.action === origin.action
        && normalizedOutcomeFile === normalizedOriginFile;
    });
    return byShape?.key ?? null;
  }

  return (
    <div
      style={{
        marginTop: 14,
        padding: '12px 14px',
        borderRadius: 10,
        background: 'var(--color-bg-card-hover)',
        border: '1px solid var(--color-border-primary)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 4, color: headingColor }}>Trace</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            {traceSummary(event.traceItems)} from {sourceLabel(event).toLowerCase()} at {formatTimestamp(event.timestamp)}.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => onSubmitFeedback('helpful')}
            disabled={submittingFeedback != null || selectedFeedback === 'helpful'}
            style={{
              border: '1px solid var(--color-accent-success)',
              borderRadius: 999,
              padding: '5px 10px',
              background: selectedFeedback === 'helpful'
                ? 'color-mix(in srgb, var(--color-accent-success) 12%, var(--color-bg-card))'
                : 'var(--color-bg-card)',
              color: bodyColor,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {selectedFeedback === 'helpful' ? 'Marked helpful' : 'This helped'}
          </button>
          <button
            type="button"
            onClick={() => onSubmitFeedback('not_helpful')}
            disabled={submittingFeedback != null || selectedFeedback === 'not_helpful'}
            style={{
              border: '1px solid var(--color-accent-error)',
              borderRadius: 999,
              padding: '5px 10px',
              background: selectedFeedback === 'not_helpful'
                ? 'color-mix(in srgb, var(--color-accent-error) 12%, var(--color-bg-card))'
                : 'var(--color-bg-card)',
              color: bodyColor,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {selectedFeedback === 'not_helpful' ? 'Marked not helpful' : 'This did not help'}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: '1px solid var(--color-border-primary)',
              borderRadius: 999,
              padding: '5px 10px',
              background: 'var(--color-bg-card)',
              color: bodyColor,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Close trace
          </button>
        </div>
      </div>

      {feedbackError && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--color-accent-error)' }}>
          Could not record feedback: {feedbackError}
        </div>
      )}

      {event.systemVerdict && (
        <div
          style={{
            marginTop: 10,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--color-border-primary)',
            background: 'var(--color-bg-card)',
          }}
        >
          <div style={{ fontSize: 12, color: helperColor, marginBottom: 4 }}>System verdict</div>
          <div style={{ fontWeight: 700, color: headingColor, textTransform: 'capitalize' }}>
            {event.systemVerdict.replace(/_/g, ' ')}
            {event.systemConfidence != null ? ` · ${Math.round(event.systemConfidence * 100)}% confidence` : ''}
          </div>
          {event.systemReasons?.length ? (
            <ul style={{ margin: '8px 0 0 18px', padding: 0, color: mutedColor, fontSize: 13, lineHeight: 1.5 }}>
              {event.systemReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}

          {event.systemEvidence && (
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 12, color: helperColor }}>
                Judge evidence
                {event.systemEvidence.matchedTracePaths.length > 0
                  ? ` · matched ${event.systemEvidence.matchedTracePaths.length} trace path${event.systemEvidence.matchedTracePaths.length === 1 ? '' : 's'}`
                  : ' · no trace path overlap'}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: outcomeChipBg,
                    fontSize: 11,
                    fontWeight: 700,
                    color: headingColor,
                  }}
                >
                  Used {event.systemEvidence.usedOutcomes.length}
                </span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--color-text-muted) 18%, transparent)',
                    fontSize: 11,
                    fontWeight: 700,
                    color: headingColor,
                  }}
                >
                  Ignored {event.systemEvidence.ignoredOutcomes.length}
                </span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--color-accent-primary) 12%, transparent)',
                    fontSize: 11,
                    fontWeight: 700,
                    color: headingColor,
                  }}
                >
                  Exact links {exactLinkedOutcomeCount}
                </span>
              </div>

              {event.systemEvidence.usedOutcomes.length > 0 ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: headingColor }}>Used in verdict</div>
                  {event.systemEvidence.usedOutcomes.map((outcome, index) => (
                    <MemoryAssistOutcomeCard
                      key={outcomeEntries.find((entry) => entry.kind === 'used' && entry.outcome === outcome)?.key ?? `used-${outcome.outcomeId ?? `${outcome.toolName}-${index}`}`}
                      outcome={outcome}
                      outcomeKey={outcomeEntries.find((entry) => entry.kind === 'used' && entry.outcome === outcome)?.key ?? `used-${index}`}
                      kind="used"
                      project={event.project}
                      excludedObservationIds={excludedObservationIds}
                      isFocused={focusedOutcomeKey === (outcomeEntries.find((entry) => entry.kind === 'used' && entry.outcome === outcome)?.key ?? `used-${index}`)}
                      headingColor={headingColor}
                      bodyColor={bodyColor}
                      mutedColor={mutedColor}
                      helperColor={helperColor}
                      outcomeCardBg={outcomeCardBg}
                      outcomeChipBg={outcomeChipBg}
                      registerNode={registerOutcomeNode}
                      openObservationId={openObservationId}
                      detailCache={detailCache}
                      loadingObservationId={loadingObservationId}
                      detailError={detailError}
                      onToggleObservation={onToggleObservation}
                    />
                  ))}
                </div>
              ) : null}

              {event.systemEvidence.ignoredOutcomes.length > 0 ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: headingColor }}>Ignored by verdict</div>
                  {event.systemEvidence.ignoredOutcomes.map((outcome, index) => (
                    <MemoryAssistOutcomeCard
                      key={outcomeEntries.find((entry) => entry.kind === 'ignored' && entry.outcome === outcome)?.key ?? `ignored-${outcome.outcomeId ?? `${outcome.toolName}-${index}`}`}
                      outcome={outcome}
                      outcomeKey={outcomeEntries.find((entry) => entry.kind === 'ignored' && entry.outcome === outcome)?.key ?? `ignored-${index}`}
                      kind="ignored"
                      project={event.project}
                      excludedObservationIds={excludedObservationIds}
                      isFocused={focusedOutcomeKey === (outcomeEntries.find((entry) => entry.kind === 'ignored' && entry.outcome === outcome)?.key ?? `ignored-${index}`)}
                      headingColor={headingColor}
                      bodyColor={bodyColor}
                      mutedColor={mutedColor}
                      helperColor={helperColor}
                      outcomeCardBg={outcomeCardBg}
                      outcomeChipBg={outcomeChipBg}
                      registerNode={registerOutcomeNode}
                      openObservationId={openObservationId}
                      detailCache={detailCache}
                      loadingObservationId={loadingObservationId}
                      detailError={detailError}
                      onToggleObservation={onToggleObservation}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
        {event.traceItems.map((item) => {
          const detail = detailCache[item.observationId];
          const isOpen = openObservationId === item.observationId;
          const body = normalizeTraceBody(detail);
          const verdict = item.distance != null ? distanceAssessment(item.distance, safeThreshold) : null;
          const matchedOutcomeKey = detail?.origin ? matchOutcomeKeyForOrigin(detail.origin) : null;
          const matchedOutcome = matchedOutcomeKey
            ? outcomeEntries.find((entry) => entry.key === matchedOutcomeKey)?.outcome
            : null;

          return (
            <div
              key={item.observationId}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: traceCardBg,
                border: `1px solid ${traceCardBorder}`,
                boxShadow: isOpen ? '0 10px 25px rgba(0,0,0,0.12)' : 'none',
                color: bodyColor,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  width: '100%',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                  color: bodyColor,
                }}
              >
                <button
                  type="button"
                  onClick={() => onToggleObservation(item.observationId)}
                  style={{
                    flex: 1,
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: bodyColor,
                  }}
                >
                  <div style={{ fontWeight: 700, color: bodyColor }}>
                    #{item.observationId} {item.title || 'Untitled observation'}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: mutedColor }}>
                    {item.type || 'observation'}
                    {formatDateTime(item.createdAtEpoch) ? ` · ${formatDateTime(item.createdAtEpoch)}` : ''}
                    {item.filePath ? ` · ${redactPathForDisplay(item.filePath)}` : ''}
                  </div>
                </button>
                <div style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                  {item.distance != null && verdict && (
                    <>
                      <strong style={{ fontSize: 12, color: bodyColor }}>{item.distance.toFixed(3)}</strong>
                      <span style={{ fontSize: 12, color: helperColor }}>{verdict.headline}</span>
                    </>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={() => onToggleObservation(item.observationId)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                        fontSize: 12,
                        color: linkColor,
                        fontWeight: 700,
                      }}
                    >
                      {isOpen ? 'Hide source' : 'View source'}
                    </button>
                    {onOpenTrace && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenTrace(item.observationId); }}
                        title="Open full trace for this observation"
                        style={{
                          border: `1px solid ${traceCardBorder}`,
                          background: 'var(--color-bg-card-hover)',
                          padding: '2px 8px',
                          borderRadius: 999,
                          cursor: 'pointer',
                          fontSize: 11,
                          color: helperColor,
                          fontWeight: 700,
                        }}
                      >
                        Debug trace
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {isOpen && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${traceCardBorder}` }}>
                  {loadingObservationId === item.observationId && (
                    <div style={{ fontSize: 13, color: helperColor }}>Loading observation…</div>
                  )}
                  {loadingObservationId !== item.observationId && detailError && detail == null && (
                    <div style={{ fontSize: 13, color: 'var(--color-accent-error)' }}>
                      Could not load this observation: {detailError}
                    </div>
                  )}
                  {loadingObservationId !== item.observationId && detail != null && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {detail.subtitle && (
                        <div style={{ fontSize: 13, color: mutedColor }}>{detail.subtitle}</div>
                      )}
                      {detail.origin && (
                        <div style={{ display: 'grid', gap: 6 }}>
                          <div style={{ fontSize: 12, color: helperColor }}>
                            Origin: {detail.origin.toolName} · {detail.origin.action}
                            {detail.origin.promptNumber ? ` · prompt ${detail.origin.promptNumber}` : ''}
                            {detail.origin.filePath ? ` · ${redactPathForDisplay(detail.origin.filePath)}` : ''}
                          </div>
                          {matchedOutcomeKey && matchedOutcome && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                onClick={() => setFocusedOutcomeKey(matchedOutcomeKey)}
                                style={{
                                  border: '1px solid var(--color-accent-primary)',
                                  borderRadius: 999,
                                  padding: '4px 9px',
                                  background: 'color-mix(in srgb, var(--color-accent-primary) 12%, transparent)',
                                  color: linkColor,
                                  cursor: 'pointer',
                                  fontSize: 12,
                                  fontWeight: 700,
                                }}
                              >
                                Jump to tool action
                              </button>
                              <span style={{ fontSize: 12, color: helperColor }}>
                                {formatSignalSource(matchedOutcome.signalSource)} · {formatEvidenceStrength(matchedOutcome.evidenceStrength)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: 13,
                          lineHeight: 1.5,
                          color: bodyColor,
                          whiteSpace: 'pre-wrap',
                          maxHeight: 240,
                          overflow: 'auto',
                        }}
                      >
                        {body || 'No narrative/text stored for this observation.'}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
