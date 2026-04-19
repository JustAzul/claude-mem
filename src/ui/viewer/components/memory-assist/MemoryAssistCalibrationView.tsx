import React from 'react';
import type { FeedbackStats } from './shared';
import { formatTokenCount, sourceHeading } from './shared';

type MemorySourceFilter = 'all' | 'semantic_prompt' | 'file_context';

interface MemoryAssistCalibrationViewProps {
  dashboard: FeedbackStats | null;
  windowDays: number;
  onWindowDaysChange: (days: number) => void;
  defaultProject?: string | null;
}

function projectSourceKey(project: string, source: Exclude<MemorySourceFilter, 'all'>): string {
  return `${project}::${source}`;
}

function mergeTopSkipReasons(
  reasons: Array<Array<{ reason: string; count: number }>>
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const group of reasons) {
    for (const item of group) {
      counts.set(item.reason, (counts.get(item.reason) ?? 0) + item.count);
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
}

function formatRecommendationLabel(kind: string): string {
  switch (kind) {
    case 'raise_threshold':
      return 'Raise threshold';
    case 'lower_threshold':
      return 'Lower threshold';
    case 'keep_threshold':
      return 'Keep threshold';
    default:
      return 'Insufficient data';
  }
}

/**
 * Banner rendered in place of the prescriptive recommendation card while the
 * recommender is paused (awaiting Probe B content-reuse signal). Keeps the
 * surrounding raw telemetry (verdicts, injectRate) visible.
 */
function RecommenderPausedBanner({ style }: { style?: React.CSSProperties }) {
  const bannerStyle: React.CSSProperties = {
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px dashed color-mix(in srgb, var(--color-text-muted) 55%, var(--color-border-primary))',
    background: 'color-mix(in srgb, var(--color-text-muted) 8%, var(--color-bg-card))',
    display: 'grid',
    gap: 4,
    ...style,
  };

  return (
    <div style={bannerStyle} role="status" aria-live="polite">
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600, letterSpacing: 0.3 }}>
        RECOMMENDER PAUSED
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
        Recommender paused: awaiting content-reuse signal (Probe B). Treat verdicts/injectRate below as raw telemetry, not prescriptions.
      </div>
    </div>
  );
}

function formatRecommendationScope(stats: { recommendation: FeedbackStats['recommendation'] }) {
  const slice = stats.recommendation.slice;
  switch (slice.scope) {
    case 'global':
      return 'Applies to all projects and memory sources';
    case 'source':
      return `Applies to ${sourceHeading(slice.source!)} across all projects`;
    case 'project':
      return `Applies to project ${slice.project}`;
    case 'project_source':
      return `Applies to ${sourceHeading(slice.source!)} in ${slice.project}`;
    default:
      return 'Applies to the current slice';
  }
}

export function MemoryAssistCalibrationView({
  dashboard,
  windowDays,
  onWindowDaysChange,
  defaultProject,
}: MemoryAssistCalibrationViewProps) {
  const [selectedProject, setSelectedProject] = React.useState<string>(defaultProject || 'all');
  const [selectedSource, setSelectedSource] = React.useState<MemorySourceFilter>('all');

  React.useEffect(() => {
    if (!defaultProject) return;
    setSelectedProject((current) => (current === 'all' ? defaultProject : current));
  }, [defaultProject]);

  React.useEffect(() => {
    if (!dashboard) return;
    if (selectedProject !== 'all' && !dashboard.availableProjects.includes(selectedProject)) {
      setSelectedProject('all');
    }
  }, [dashboard, selectedProject]);

  const selectedStats = React.useMemo(() => {
    if (!dashboard) return null;

    if (selectedProject !== 'all' && selectedSource !== 'all') {
      return dashboard.projectSourceStats[projectSourceKey(selectedProject, selectedSource)] ?? null;
    }
    if (selectedProject !== 'all') {
      return dashboard.projectStats[selectedProject] ?? null;
    }
    if (selectedSource !== 'all') {
      return dashboard.sourceStats[selectedSource] ?? null;
    }

    return {
      total: dashboard.totalDecisions,
      actionable: dashboard.injected + dashboard.checkedNoHelp,
      injected: dashboard.injected,
      injectRate: dashboard.injectRate,
      likelyHelped: dashboard.likelyHelped,
      likelyHelpedRate: dashboard.likelyHelpedRate,
      userConfirmedHelpful: dashboard.helpful,
      userConfirmedHelpfulRate: dashboard.userConfirmedHelpfulRate,
      helped: dashboard.helped,
      checkedNoHelp: dashboard.checkedNoHelp,
      disabled: 0,
      errors: 0,
      helpRate: dashboard.helpRate,
      topSkipReasons: [
        ...mergeTopSkipReasons([
          dashboard.sourceStats.semantic_prompt.topSkipReasons,
          dashboard.sourceStats.file_context.topSkipReasons,
        ]),
      ],
      verdicts: {
        likely_helped: dashboard.sourceStats.semantic_prompt.verdicts.likely_helped + dashboard.sourceStats.file_context.verdicts.likely_helped,
        unclear: dashboard.sourceStats.semantic_prompt.verdicts.unclear + dashboard.sourceStats.file_context.verdicts.unclear,
        likely_not_helped: dashboard.sourceStats.semantic_prompt.verdicts.likely_not_helped + dashboard.sourceStats.file_context.verdicts.likely_not_helped,
      },
      estimatedInjectedTokens: dashboard.estimatedInjectedTokens,
      helpfulRecallsPer1kInjectedTokens: dashboard.helpfulRecallsPer1kInjectedTokens,
      injectedTokensPerLikelyHelpedRecall: dashboard.injectedTokensPerLikelyHelpedRecall,
      taxonomyCorrectionCount: dashboard.taxonomyCorrections.total,
      taxonomyCorrectionRate: dashboard.taxonomyCorrectionRate,
      shadowRanking: dashboard.shadowRanking,
      recommendation: dashboard.recommendation,
    };
  }, [dashboard, selectedProject, selectedSource]);

  const heading = React.useMemo(() => {
    if (selectedProject !== 'all' && selectedSource !== 'all') {
      return `${selectedProject} · ${sourceHeading(selectedSource)}`;
    }
    if (selectedProject !== 'all') {
      return `${selectedProject} · all memory sources`;
    }
    if (selectedSource !== 'all') {
      return `${sourceHeading(selectedSource)} · all projects`;
    }
    return 'All projects · all memory sources';
  }, [selectedProject, selectedSource]);

  const cardStyle: React.CSSProperties = {
    padding: '10px 12px',
    borderRadius: 10,
    background: 'var(--color-bg-stat)',
    border: '1px solid var(--color-border-primary)',
  };

  const recommendationStyle: React.CSSProperties = {
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid color-mix(in srgb, var(--color-accent-primary) 28%, var(--color-border-primary))',
    background: 'color-mix(in srgb, var(--color-accent-primary) 10%, var(--color-bg-card))',
    display: 'grid',
    gap: 6,
  };

  if (!dashboard || !selectedStats) {
    return null;
  }

  const taxonomyIsMeaningfullyScoped = selectedSource === 'all';

  return (
    <section
      style={{
        marginTop: 12,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-card-hover)',
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--color-text-header)' }}>Calibration</div>
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-secondary)' }}>
            Persistent tuning metrics for <strong>{heading}</strong>. Use this tab when you want to tune thresholds or inspect ranking behavior, not when you just want to understand whether memory is helping day to day.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
            Window
            <select
              value={String(windowDays)}
              onChange={(event) => onWindowDaysChange(parseInt(event.target.value, 10))}
              style={{
                minWidth: 96,
                padding: '6px 8px',
                borderRadius: 8,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-bg-card)',
                color: 'var(--color-text-primary)',
              }}
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
            Project
            <select
              value={selectedProject}
              onChange={(event) => setSelectedProject(event.target.value)}
              style={{
                minWidth: 140,
                padding: '6px 8px',
                borderRadius: 8,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-bg-card)',
                color: 'var(--color-text-primary)',
              }}
            >
              <option value="all">All projects</option>
              {dashboard.availableProjects.map((project) => (
                <option key={project} value={project}>{project}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
            Memory source
            <select
              value={selectedSource}
              onChange={(event) => setSelectedSource(event.target.value as MemorySourceFilter)}
              style={{
                minWidth: 160,
                padding: '6px 8px',
                borderRadius: 8,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-bg-card)',
                color: 'var(--color-text-primary)',
              }}
            >
              <option value="all">All memory sources</option>
              <option value="semantic_prompt">Prompt memory</option>
              <option value="file_context">File memory</option>
            </select>
          </label>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 10,
        }}
      >
        {selectedStats.recommendation.kind === 'paused' ? (
          <RecommenderPausedBanner style={{ gridColumn: '1 / -1' }} />
        ) : (
          <div style={{ ...recommendationStyle, gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Recommended next move</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--color-text-header)' }}>
                  {formatRecommendationLabel(selectedStats.recommendation.kind)}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'right' }}>
                <div>{formatRecommendationScope(selectedStats)}</div>
                <div>
                  Confidence {Math.round(selectedStats.recommendation.confidence * 100)}% · {selectedStats.recommendation.actionable} actionable decision{selectedStats.recommendation.actionable === 1 ? '' : 's'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
              {selectedStats.recommendation.reason}
              {selectedStats.recommendation.suggestedDelta != null && selectedStats.recommendation.suggestedDelta !== 0
                ? ` Suggested delta: ${selectedStats.recommendation.suggestedDelta > 0 ? '+' : ''}${selectedStats.recommendation.suggestedDelta.toFixed(2)}.`
                : ''}
            </div>
          </div>
        )}
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Injected at all</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{selectedStats.injectRate == null ? '—' : `${selectedStats.injectRate}%`}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {selectedStats.injected}/{selectedStats.actionable || 0} actionable decisions injected memory.
          </div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>System-judged likely helpful</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{selectedStats.likelyHelpedRate == null ? '—' : `${selectedStats.likelyHelpedRate}%`}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {selectedStats.likelyHelped}/{selectedStats.actionable || 0} decisions were judged likely helpful.
          </div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Helpful votes</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{selectedStats.userConfirmedHelpful}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Explicit “This helped” votes in this slice. Treat this as confirmation, not coverage.
          </div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Estimated injected tokens</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{formatTokenCount(selectedStats.estimatedInjectedTokens)}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Approximate context budget spent on injected memory in this slice.
          </div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Helpful recalls / 1k injected tokens</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {selectedStats.helpfulRecallsPer1kInjectedTokens == null ? '—' : selectedStats.helpfulRecallsPer1kInjectedTokens.toFixed(1)}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Higher is better: more likely-helped recalls per 1k injected tokens.
          </div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Tokens per likely-helped recall</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {selectedStats.injectedTokensPerLikelyHelpedRecall == null ? '—' : formatTokenCount(Math.round(selectedStats.injectedTokensPerLikelyHelpedRecall))}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Lower is better: injected tokens needed to produce one likely-helpful recall.
          </div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Parser type corrections</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {taxonomyIsMeaningfullyScoped && selectedStats.taxonomyCorrectionCount != null
              ? selectedStats.taxonomyCorrectionCount.toLocaleString()
              : '—'}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {!taxonomyIsMeaningfullyScoped
              ? 'Parser corrections are tracked at the project/global level, not split cleanly by memory source.'
              : selectedStats.taxonomyCorrectionRate == null || selectedStats.taxonomyCorrectionCount == null
              ? 'No parser type corrections were recorded in this slice.'
              : `About ${(selectedStats.taxonomyCorrectionCount / Math.max(selectedStats.total, 1)).toFixed(2)} corrections per decision in this slice (${selectedStats.taxonomyCorrectionRate} per 100 decisions).`}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 10,
        }}
      >
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>Top skip reasons</div>
          {selectedStats.topSkipReasons.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>No skip reasons recorded in this slice.</div>
          ) : (
            <div style={{ display: 'grid', gap: 4 }}>
              {selectedStats.topSkipReasons.map((item) => (
                <div key={`${item.reason}:${item.count}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                  <span>{item.reason.replace(/_/g, ' ')}</span>
                  <strong>{item.count}</strong>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>Verdict mix</div>
          <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Likely helped</span>
              <strong>{selectedStats.verdicts.likely_helped}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Unclear</span>
              <strong>{selectedStats.verdicts.unclear}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Likely not helped</span>
              <strong>{selectedStats.verdicts.likely_not_helped}</strong>
            </div>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>Shadow ranking</div>
          {selectedStats.shadowRanking ? (
            <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Compared decisions</span>
                <strong>{selectedStats.shadowRanking.totalCompared}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Exact selection match</span>
                <strong>{selectedStats.shadowRanking.exactMatchRate == null ? '—' : `${selectedStats.shadowRanking.exactMatchRate}%`}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Average overlap</span>
                <strong>{selectedStats.shadowRanking.avgSelectionOverlapRate == null ? '—' : `${selectedStats.shadowRanking.avgSelectionOverlapRate}%`}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Divergent selections</span>
                <strong>{selectedStats.shadowRanking.divergentSelections}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>Experimental overlap on likely-helped recalls</span>
                <strong>{selectedStats.shadowRanking.likelyHelpedWithExperimentalOverlapRate == null ? '—' : `${selectedStats.shadowRanking.likelyHelpedWithExperimentalOverlapRate}%`}</strong>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              No semantic shadow-ranking data was recorded in this slice yet.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
