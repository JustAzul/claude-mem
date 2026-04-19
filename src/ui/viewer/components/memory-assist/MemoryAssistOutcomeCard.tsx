import React from 'react';
import type { MemoryAssistJudgedOutcome } from '../../../../shared/memory-assist';
import type { ObservationTraceDetail } from './shared';
import {
  formatEvidenceStrength,
  formatDateTime,
  formatSignalSource,
  normalizeTraceBody,
  redactPathForDisplay,
} from './shared';

interface RelatedObservationSummary {
  id: number;
  title?: string | null;
  type?: string | null;
  created_at_epoch?: number;
}

interface MemoryAssistOutcomeCardProps {
  outcome: MemoryAssistJudgedOutcome;
  outcomeKey: string;
  kind: 'used' | 'ignored';
  project?: string;
  excludedObservationIds: Set<number>;
  isFocused: boolean;
  headingColor: string;
  bodyColor: string;
  mutedColor: string;
  helperColor: string;
  outcomeCardBg: string;
  outcomeChipBg: string;
  registerNode: (key: string, node: HTMLDivElement | null) => void;
  openObservationId: number | null;
  detailCache: Record<number, ObservationTraceDetail | null>;
  loadingObservationId: number | null;
  detailError: string | null;
  onToggleObservation: (observationId: number) => void;
}

export function MemoryAssistOutcomeCard({
  outcome,
  outcomeKey,
  kind,
  project,
  excludedObservationIds,
  isFocused,
  headingColor,
  bodyColor,
  mutedColor,
  helperColor,
  outcomeCardBg,
  outcomeChipBg,
  registerNode,
  openObservationId,
  detailCache,
  loadingObservationId,
  detailError,
  onToggleObservation,
}: MemoryAssistOutcomeCardProps) {
  const [relatedObservations, setRelatedObservations] = React.useState<RelatedObservationSummary[] | null>(null);
  const [relatedOpen, setRelatedOpen] = React.useState(false);
  const [relatedLoading, setRelatedLoading] = React.useState(false);
  const [relatedError, setRelatedError] = React.useState<string | null>(null);
  const generatedObservationIds = outcome.generatedObservationIds ?? [];
  const matchedTraceObservationIds = outcome.matchedTraceObservationIds ?? [];
  const generatedUsedCount = generatedObservationIds.filter((id) => matchedTraceObservationIds.includes(id)).length;
  const generatedIgnoredCount = Math.max(generatedObservationIds.length - generatedUsedCount, 0);

  const canLookupRelated = !!outcome.filePath;

  async function toggleRelatedMemory(): Promise<void> {
    if (!canLookupRelated) return;
    if (relatedOpen) {
      setRelatedOpen(false);
      return;
    }

    setRelatedOpen(true);
    if (relatedObservations != null || relatedLoading) return;

    setRelatedLoading(true);
    setRelatedError(null);
    try {
      const params = new URLSearchParams({
        path: outcome.filePath!,
        limit: '6',
      });
      if (project) {
        params.set('projects', project);
      }
      const response = await fetch(`/api/observations/by-file?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`status:${response.status}`);
      }

      const payload = await response.json() as { observations?: RelatedObservationSummary[] };
      const filtered = (payload.observations ?? []).filter(
        (item) => !excludedObservationIds.has(item.id)
      );
      setRelatedObservations(filtered);
    } catch (error) {
      setRelatedError(error instanceof Error ? error.message : String(error));
    } finally {
      setRelatedLoading(false);
    }
  }

  return (
    <div
      ref={(node) => registerNode(outcomeKey, node)}
      style={{
        padding: '8px 10px',
        borderRadius: 8,
        background: outcomeCardBg,
        border: isFocused
          ? '1px solid var(--color-accent-primary)'
          : '1px solid var(--color-border-primary)',
        boxShadow: isFocused ? '0 0 0 2px color-mix(in srgb, var(--color-accent-primary) 22%, transparent)' : 'none',
        display: 'grid',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: kind === 'used'
              ? outcomeChipBg
              : 'color-mix(in srgb, var(--color-text-muted) 18%, transparent)',
            color: headingColor,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
          }}
        >
          {outcome.action}
        </span>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: kind === 'used'
              ? 'color-mix(in srgb, var(--color-accent-success) 14%, transparent)'
              : 'color-mix(in srgb, var(--color-accent-error) 14%, transparent)',
            color: headingColor,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
          }}
        >
          {kind === 'used' ? 'Used' : 'Ignored'}
        </span>
        {generatedObservationIds.length > 0 && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-accent-primary) 10%, transparent)',
              color: headingColor,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Generated {generatedObservationIds.length}
          </span>
        )}
        {generatedObservationIds.length > 0 && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-accent-success) 12%, transparent)',
              color: headingColor,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Used {generatedUsedCount}
          </span>
        )}
        {generatedObservationIds.length > 0 && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-accent-error) 12%, transparent)',
              color: headingColor,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Ignored {generatedIgnoredCount}
          </span>
        )}
        {outcome.signalSource && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-text-muted) 18%, transparent)',
              color: mutedColor,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {formatSignalSource(outcome.signalSource)}
          </span>
        )}
        {outcome.evidenceStrength && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-accent-primary) 10%, transparent)',
              color: mutedColor,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {formatEvidenceStrength(outcome.evidenceStrength)}
          </span>
        )}
        {outcome.sequenceRole && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-text-muted) 18%, transparent)',
              color: mutedColor,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {outcome.sequenceRole.replace(/_/g, ' ')}
          </span>
        )}
        <span style={{ fontSize: 12, color: mutedColor }}>
          {outcome.toolName}
          {outcome.timestamp ? ` · ${formatDateTime(outcome.timestamp)}` : ''}
        </span>
      </div>
      {outcome.filePath && (
        <div style={{ fontSize: 12, color: bodyColor }}>
          File: {redactPathForDisplay(outcome.filePath)}
        </div>
      )}
      {outcome.matchedPaths?.length ? (
        <div style={{ fontSize: 12, color: mutedColor }}>
          Matched: {outcome.matchedPaths.map((path) => redactPathForDisplay(path)).filter(Boolean).join(', ')}
        </div>
      ) : null}
      {matchedTraceObservationIds.length > 0 && (
        <div style={{ fontSize: 12, color: mutedColor }}>
          Matched trace observations: {matchedTraceObservationIds.map((id) => `#${id}`).join(', ')}
        </div>
      )}
      {typeof outcome.conceptOverlapCount === 'number' && outcome.conceptOverlapCount > 0 && (
        <div style={{ fontSize: 12, color: mutedColor }}>
          Concept overlap: {outcome.conceptOverlapCount}
        </div>
      )}
      <div style={{ fontSize: 12, color: bodyColor }}>{outcome.reason}</div>

      {generatedObservationIds.length > 0 && (
        <div
          style={{
            marginTop: 4,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'var(--color-bg-card)',
            border: '1px solid var(--color-border-primary)',
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, color: helperColor }}>
            {kind === 'used'
              ? 'Generated by this tool action'
              : 'Generated by this tool action, but ignored by the verdict'}
          </div>
          {generatedObservationIds.map((observationId) => {
            const isOpen = openObservationId === observationId;
            const detail = detailCache[observationId];
            const body = normalizeTraceBody(detail);
            return (
              <div
                key={observationId}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'color-mix(in srgb, var(--color-bg-card-hover) 72%, var(--color-bg-card))',
                  border: '1px solid var(--color-border-primary)',
                  display: 'grid',
                  gap: 6,
                }}
              >
                <button
                  type="button"
                  onClick={() => onToggleObservation(observationId)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: bodyColor,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, color: bodyColor }}>
                      #{observationId} {detail?.title || 'Generated observation'}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 12, color: mutedColor }}>
                      {detail?.type || 'observation'}
                      {detail?.created_at_epoch ? ` · ${formatDateTime(detail.created_at_epoch)}` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--color-accent-primary)', fontWeight: 700 }}>
                    {isOpen ? 'Hide source' : 'View source'}
                  </span>
                </button>
                {isOpen && (
                  <div style={{ display: 'grid', gap: 6 }}>
                    {loadingObservationId === observationId && (
                      <div style={{ fontSize: 12, color: helperColor }}>Loading observation…</div>
                    )}
                    {loadingObservationId !== observationId && detailError && detail == null && (
                      <div style={{ fontSize: 12, color: 'var(--color-accent-error)' }}>
                        Could not load this observation: {detailError}
                      </div>
                    )}
                    {loadingObservationId !== observationId && detail != null && (
                      <>
                        {detail.origin && (
                          <div style={{ fontSize: 12, color: mutedColor }}>
                            Origin: {detail.origin.toolName} · {detail.origin.action}
                            {detail.origin.promptNumber ? ` · prompt ${detail.origin.promptNumber}` : ''}
                            {detail.origin.filePath ? ` · ${redactPathForDisplay(detail.origin.filePath)}` : ''}
                          </div>
                        )}
                        <div
                          style={{
                            fontSize: 12,
                            lineHeight: 1.5,
                            color: bodyColor,
                            whiteSpace: 'pre-wrap',
                            maxHeight: 180,
                            overflow: 'auto',
                          }}
                        >
                          {body || 'No narrative/text stored for this observation.'}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canLookupRelated && (
        <div style={{ marginTop: 2 }}>
          <button
            type="button"
            onClick={() => void toggleRelatedMemory()}
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 12,
              color: 'var(--color-accent-primary)',
              WebkitTextFillColor: 'var(--color-accent-primary)',
              opacity: 1,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              fontWeight: 700,
              fontFamily: 'inherit',
            }}
          >
            {relatedOpen ? 'Hide other saved memory on this file' : 'Show other saved memory on this file'}
          </button>
        </div>
      )}

      {relatedOpen && (
        <div
          style={{
            marginTop: 6,
            paddingTop: 8,
            borderTop: '1px solid var(--color-border-primary)',
            display: 'grid',
            gap: 8,
          }}
        >
          {relatedLoading && (
            <div style={{ fontSize: 12, color: helperColor }}>Loading saved memory for this file…</div>
          )}
          {!relatedLoading && relatedError && (
            <div style={{ fontSize: 12, color: 'var(--color-accent-error)' }}>
              Could not load related memory: {relatedError}
            </div>
          )}
          {!relatedLoading && !relatedError && relatedObservations != null && relatedObservations.length === 0 && (
            <div style={{ fontSize: 12, color: helperColor }}>
              No additional saved memory was found for this file.
            </div>
          )}
          {!relatedLoading && !relatedError && (relatedObservations?.length ?? 0) > 0 && (
            <>
              <div style={{ fontSize: 12, color: helperColor }}>
                Other saved memory on this file
              </div>
              {relatedObservations!.map((observation) => {
                const isOpen = openObservationId === observation.id;
                const detail = detailCache[observation.id];
                const body = normalizeTraceBody(detail);
                return (
                  <div
                    key={observation.id}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'var(--color-bg-card)',
                      border: '1px solid var(--color-border-primary)',
                      display: 'grid',
                      gap: 6,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onToggleObservation(observation.id)}
                      style={{
                        display: 'flex',
                        width: '100%',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 12,
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: bodyColor,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, color: bodyColor }}>
                          #{observation.id} {observation.title || 'Untitled observation'}
                        </div>
                        <div style={{ marginTop: 2, fontSize: 12, color: mutedColor }}>
                          {observation.type || 'observation'}
                          {observation.created_at_epoch ? ` · ${formatDateTime(observation.created_at_epoch)}` : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--color-accent-primary)', fontWeight: 700 }}>
                        {isOpen ? 'Hide source' : 'View source'}
                      </span>
                    </button>
                    {isOpen && (
                      <div style={{ display: 'grid', gap: 6 }}>
                        {loadingObservationId === observation.id && (
                          <div style={{ fontSize: 12, color: helperColor }}>Loading observation…</div>
                        )}
                        {loadingObservationId !== observation.id && detailError && detail == null && (
                          <div style={{ fontSize: 12, color: 'var(--color-accent-error)' }}>
                            Could not load this observation: {detailError}
                          </div>
                        )}
                        {loadingObservationId !== observation.id && detail != null && (
                          <>
                            {detail.origin && (
                              <div style={{ fontSize: 12, color: mutedColor }}>
                                Origin: {detail.origin.toolName} · {detail.origin.action}
                                {detail.origin.promptNumber ? ` · prompt ${detail.origin.promptNumber}` : ''}
                                {detail.origin.filePath ? ` · ${redactPathForDisplay(detail.origin.filePath)}` : ''}
                              </div>
                            )}
                            <div
                              style={{
                                fontSize: 12,
                                lineHeight: 1.5,
                                color: bodyColor,
                                whiteSpace: 'pre-wrap',
                                maxHeight: 180,
                                overflow: 'auto',
                              }}
                            >
                              {body || 'No narrative/text stored for this observation.'}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
