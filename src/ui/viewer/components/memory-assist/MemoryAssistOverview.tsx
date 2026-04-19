import React from 'react';
import { createPortal } from 'react-dom';
import type { MemoryAssistEvent } from '../../../../shared/memory-assist';
import type { FeedbackStats, SourceAssistStats } from './shared';
import type { TokenEconomicsStats } from '../../types';
import {
  badgeLabel,
  detailPills,
  distanceAssessment,
  formatReasonLabel,
  formatTokenCount,
  reasonSummary,
  sourceHeading,
  toneFor,
} from './shared';

interface MemoryAssistOverviewProps {
  latest?: MemoryAssistEvent;
  semanticInjectEnabled: boolean;
  semanticThreshold: string;
  safeThreshold: number;
  windowDays: number;
  overallStats: {
    total: number;
    injected: number;
    injectRate: number | null;
    likelyHelped: number;
    likelyHelpedRate: number | null;
    userConfirmedHelpful: number;
    userConfirmedHelpfulRate: number | null;
    helped: number;
    checkedNoHelp: number;
    helpRate: number | null;
  };
  promptStats: SourceAssistStats;
  summaryStats: SourceAssistStats;
  fileStats: SourceAssistStats;
  feedbackStats: FeedbackStats | null;
  tokenEconomics: TokenEconomicsStats | null;
  howToReadDismissed: boolean;
  onHowToReadDismissedChange: (dismissed: boolean) => void;
  onTraceLatest: () => void;
  implicitUseRate?: number | null;
  implicitUseCounts?: {
    file_reuse: number;
    content_cited: number;
    no_overlap: number;
    not_yet_computed: number;
  } | null;
  recentTrend?: {
    sinceEpoch: number;
    totalDecisions: number;
    injectRate: number | null;
    likelyHelpedRate: number | null;
    injected: number;
    actionable: number;
  } | null;
}

function SectionLabel({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
        {title}
      </div>
      {subtitle && (
        <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  meta,
  accent,
  info,
  tooltipId,
  onToggleTooltip,
}: {
  title: string;
  value: string;
  meta: string;
  accent?: string;
  info?: string;
  tooltipId: string;
  onToggleTooltip: (tooltipId: string, info: string, anchor: HTMLButtonElement) => void;
}) {
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 12,
        background: 'var(--color-bg-stat)',
        border: '1px solid var(--color-border-primary)',
        display: 'grid',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{title}</span>
        {info && (
          <button
            type="button"
            aria-label={info}
            onClick={(event) => onToggleTooltip(tooltipId, info, event.currentTarget)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: '1px solid var(--color-border-primary)',
              color: 'var(--color-accent-primary)',
              background: 'var(--color-bg-card-hover)',
              fontSize: 10,
              lineHeight: 1,
              fontWeight: 700,
              cursor: 'pointer',
              flex: '0 0 auto',
            }}
          >
            ?
          </button>
        )}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: accent ?? 'var(--color-text-primary)' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--color-text-secondary)' }}>
        {meta}
      </div>
    </div>
  );
}

function RatioBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const percent = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        <span>{label}</span>
        <strong style={{ color: 'var(--color-text-primary)' }}>{value}/{total}</strong>
      </div>
      <div style={{ height: 10, borderRadius: 999, background: 'var(--color-border-secondary)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 999,
            background: color,
          }}
        />
      </div>
    </div>
  );
}

function SourceSummaryCard({
  stats,
  windowDays,
  color,
}: {
  stats: SourceAssistStats;
  windowDays: number;
  color: string;
}) {
  const dominantSkip = stats.topSkipReasons[0];
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 12,
        background: 'var(--color-bg-stat)',
        border: '1px solid var(--color-border-primary)',
        display: 'grid',
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{sourceHeading(stats.source)}</div>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          {stats.likelyHelped} likely-helped decisions out of {stats.actionable || 0} checked recalls in the last {windowDays} days.
        </div>
      </div>

      <RatioBar
        label="Likely helped"
        value={stats.likelyHelped}
        total={stats.actionable || 0}
        color={color}
      />

      <RatioBar
        label="Injected at all"
        value={stats.injected}
        total={stats.actionable || 0}
        color="var(--color-accent-primary)"
      />

      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
        {dominantSkip
          ? `Most common skip: ${formatReasonLabel(dominantSkip.reason)} (${dominantSkip.count})`
          : 'No skip reasons were recorded for this source in the selected window.'}
      </div>
    </div>
  );
}

export function MemoryAssistOverview({
  latest,
  semanticInjectEnabled,
  semanticThreshold,
  safeThreshold,
  windowDays,
  overallStats,
  promptStats,
  summaryStats,
  fileStats,
  feedbackStats,
  tokenEconomics,
  howToReadDismissed,
  onHowToReadDismissedChange,
  onTraceLatest,
  implicitUseRate,
  implicitUseCounts,
  recentTrend,
}: MemoryAssistOverviewProps) {
  // Bimodal workload hint — 30d aggregate hides the fact that rates
  // can swing 1.6% → 75% within a day. Surface "last 1h" alongside the
  // main number so the user sees the trend direction, not just the mean.
  const lastHourHelpfulBadge = recentTrend && recentTrend.likelyHelpedRate != null && recentTrend.actionable > 0
    ? ` · Last 1h: ${recentTrend.likelyHelpedRate}% (${recentTrend.injected}/${recentTrend.actionable})`
    : '';
  const lastHourInjectBadge = recentTrend && recentTrend.injectRate != null && recentTrend.actionable > 0
    ? ` · Last 1h inject: ${recentTrend.injectRate}%`
    : '';
  const tone = toneFor(latest);
  const [openTooltip, setOpenTooltip] = React.useState<{
    id: string;
    info: string;
    top: number;
    left: number;
  } | null>(null);

  const overallActionable = overallStats.injected + overallStats.checkedNoHelp;
  const manualVoteCount = feedbackStats ? feedbackStats.helpful + feedbackStats.notHelpful : 0;

  React.useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-memory-assist-tooltip-popover="true"]')) return;
      setOpenTooltip(null);
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  function toggleTooltip(
    tooltipId: string,
    info: string,
    anchor: HTMLButtonElement
  ) {
    setOpenTooltip((current) => {
      if (current?.id === tooltipId) return null;

      const rect = anchor.getBoundingClientRect();
      return {
        id: tooltipId,
        info,
        top: Math.min(rect.bottom + 10, window.innerHeight - 120),
        left: Math.min(Math.max(rect.left - 120, 16), window.innerWidth - 296),
      };
    });
  }

  const latestSummary = latest
    ? reasonSummary(latest, safeThreshold)
    : 'No memory-assist decision has been captured yet.';

  const fileContribution = overallStats.likelyHelped > 0
    ? Math.round((fileStats.likelyHelped / overallStats.likelyHelped) * 100)
    : 0;
  const promptContribution = overallStats.likelyHelped > 0
    ? Math.round((promptStats.likelyHelped / overallStats.likelyHelped) * 100)
    : 0;
  const summaryContribution = overallStats.likelyHelped > 0
    ? Math.round((summaryStats.likelyHelped / overallStats.likelyHelped) * 100)
    : 0;

  // Build the LIVE STATE chip values once, used in the chip strip below.
  const liveStateChips: Array<{ label: string; value: string; muted?: boolean }> = [
    {
      label: 'Semantic assist',
      value: semanticInjectEnabled ? 'on' : 'off',
      muted: !semanticInjectEnabled,
    },
    {
      label: 'Max distance',
      value: semanticThreshold || '0.35',
    },
    ...(latest?.source === 'semantic_prompt' && latest.bestDistance != null
      ? (() => {
          const verdict = distanceAssessment(latest.bestDistance, safeThreshold);
          return [
            { label: 'Best match', value: latest.bestDistance.toFixed(3) },
            { label: verdict.withinLimit ? 'Within limit' : 'Above limit', value: verdict.subline, muted: true },
          ];
        })()
      : []),
  ];

  return (
    <>
      <div style={{ display: 'grid', gap: 16 }}>
        {/* Memory assist status card — full width now that LIVE STATE moved to chip strip */}
        <div
          style={{
            padding: '14px 16px',
            borderRadius: 12,
            border: `1px solid ${tone.border}`,
            background: 'var(--color-bg-card-hover)',
            display: 'grid',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>Memory assist</strong>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                borderRadius: 999,
                background: tone.badge,
                color: 'var(--color-text-button)',
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'capitalize',
              }}
            >
              {badgeLabel(latest)}
            </span>
            {latest?.status === 'injected' && latest.traceItems && latest.traceItems.length > 0 && (
              <button
                type="button"
                onClick={onTraceLatest}
                style={{
                  border: '1px solid #3b82f6',
                  borderRadius: 999,
                  padding: '5px 10px',
                  background: 'rgba(59, 130, 246, 0.12)',
                  color: '#3b82f6',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Trace what was used
              </button>
            )}
          </div>

          <div style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--color-text-primary)' }}>
            {latestSummary}
          </div>

          {/* HOW TO READ THIS — dismissible; stays visible for first-time users */}
          {!howToReadDismissed && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: 'var(--color-bg-card)',
                border: '1px solid var(--color-border-primary)',
                display: 'grid',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <SectionLabel
                  title="How to read this"
                  subtitle="The top row separates scopes so the numbers stop fighting each other."
                />
                <button
                  type="button"
                  onClick={() => onHowToReadDismissedChange(true)}
                  aria-label="Dismiss how to read this"
                  style={{
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    border: '1px solid var(--color-border-primary)',
                    background: 'var(--color-bg-card-hover)',
                    color: 'var(--color-text-muted)',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    lineHeight: 1,
                  }}
                >
                  x
                </button>
              </div>
              <div style={{ display: 'grid', gap: 4, fontSize: 13, color: 'var(--color-text-secondary)' }}>
                <div><strong style={{ color: 'var(--color-text-primary)' }}>Overall likely helpful</strong> combines prompt memory and file memory.</div>
                <div><strong style={{ color: 'var(--color-text-primary)' }}>File memory</strong> and <strong style={{ color: 'var(--color-text-primary)' }}>Prompt memory</strong> are slices of that overall total, so they should not be read as separate totals.</div>
                <div><strong style={{ color: 'var(--color-text-primary)' }}>If a slice repeats the overall total</strong>, it usually means the other slice contributed zero likely-helpful recalls in this window.</div>
                <div><strong style={{ color: 'var(--color-text-primary)' }}>Manual confirmations</strong> only count explicit votes, so they can stay blank even when the system judge is positive.</div>
              </div>
            </div>
          )}

          {latest && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {detailPills(latest, safeThreshold).map((pill) => (
                <span
                  key={`${pill.label}:${pill.value}`}
                  style={{
                    display: 'inline-flex',
                    gap: 6,
                    alignItems: 'center',
                    padding: '6px 10px',
                    borderRadius: 999,
                    background: 'var(--color-bg-card)',
                    border: '1px solid var(--color-border-primary)',
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: 'var(--color-text-muted)' }}>{pill.label}</span>
                  <strong>{pill.value}</strong>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* LIVE STATE — compact chip strip replacing the right-column card */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--color-text-muted)', marginRight: 2 }}>
            Live state
          </span>
          {liveStateChips.map((chip) => (
            <span
              key={chip.label}
              style={{
                display: 'inline-flex',
                gap: 5,
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 6,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-bg-stat)',
                fontSize: 11,
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ color: 'var(--color-text-muted)' }}>{chip.label}:</span>
              <strong style={{ color: chip.muted ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}>
                {chip.value}
              </strong>
            </span>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <StatCard
            title={`Overall likely helpful (${windowDays}d)`}
            value={overallStats.likelyHelpedRate == null ? '—' : `${overallStats.likelyHelpedRate}%`}
            meta={`${overallStats.likelyHelped}/${overallActionable || 0} checked recalls looked helpful overall. ${fileStats.likelyHelped} from file memory, ${promptStats.likelyHelped} from prompt memory, ${summaryStats.likelyHelped} from session summaries.${lastHourHelpfulBadge}`}
            accent="var(--color-accent-success)"
            info="This is the combined system-judged likely-helpful rate across prompt memory and file memory. The 'Last 1h' badge shows the most recent hour so you can see whether the aggregate is trending up or down."
            tooltipId="overall-likely-helpful"
            onToggleTooltip={toggleTooltip}
          />
          <StatCard
            title={`File memory likely helpful (${windowDays}d)`}
            value={fileStats.likelyHelpedRate == null ? '—' : `${fileStats.likelyHelpedRate}%`}
            meta={`${fileStats.likelyHelped}/${fileStats.actionable || 0} file-based checks were judged likely helpful. That is ${fileContribution}% of the overall likely-helpful recalls.`}
            accent="var(--color-accent-success)"
            info="This card only measures file timeline memory. It is a slice of the overall total, not a separate total."
            tooltipId="file-likely-helpful"
            onToggleTooltip={toggleTooltip}
          />
          <StatCard
            title={`Prompt memory likely helpful (${windowDays}d)`}
            value={promptStats.likelyHelpedRate == null ? '—' : `${promptStats.likelyHelpedRate}%`}
            meta={`${promptStats.likelyHelped}/${promptStats.actionable || 0} prompt-memory checks were judged likely helpful. That is ${promptContribution}% of the overall likely-helpful recalls.`}
            accent="var(--color-accent-primary)"
            info="This card only measures semantic prompt recall. It is a slice of the overall total, not a separate total."
            tooltipId="prompt-likely-helpful"
            onToggleTooltip={toggleTooltip}
          />
          <StatCard
            title={`Session summary likely helpful (${windowDays}d)`}
            value={summaryStats.likelyHelpedRate == null ? '—' : `${summaryStats.likelyHelpedRate}%`}
            meta={`${summaryStats.likelyHelped}/${summaryStats.actionable || 0} session-summary recalls were judged likely helpful. That is ${summaryContribution}% of the overall likely-helpful recalls.`}
            accent="var(--color-accent-primary)"
            info="This card only measures session-summary recall (investigated / completed / learned fields). It is a slice of the overall total, not a separate total."
            tooltipId="summary-likely-helpful"
            onToggleTooltip={toggleTooltip}
          />
          <StatCard
            title={`Manual helpful votes (${windowDays}d)`}
            value={String(feedbackStats?.helpful ?? 0)}
            meta={
              feedbackStats
                ? `${feedbackStats.helpful} helpful votes and ${feedbackStats.notHelpful} not-helpful votes. Manual votes confirm recalls, but they do not cover every recall attempt.`
                : 'No manual feedback recorded yet.'
            }
            info="Manual confirmations use only explicit user votes. They can stay blank even when the system judge shows likely-helpful recalls."
            tooltipId="manual-confirmations"
            onToggleTooltip={toggleTooltip}
          />
          <StatCard
            title={`Implicit use rate (${windowDays}d)`}
            value={implicitUseRate == null ? '—' : `${implicitUseRate}%`}
            meta={
              implicitUseCounts
                ? `${implicitUseCounts.file_reuse} used · ${implicitUseCounts.content_cited} cited · ${implicitUseCounts.no_overlap} unused · ${implicitUseCounts.not_yet_computed} pending (signals compute at session end)${lastHourInjectBadge}`
                : `Signals compute at session end.${lastHourInjectBadge}`
            }
            accent="var(--color-accent-primary)"
            info="% of injected memories where Claude actually touched a suggested file or cited its content. Computed only for sessions that have ended — 'pending' injections are excluded from the rate."
            tooltipId="implicit-use-rate"
            onToggleTooltip={toggleTooltip}
          />
        </div>

        <div
          style={{
            padding: '14px 16px',
            borderRadius: 12,
            background: 'var(--color-bg-stat)',
            border: '1px solid var(--color-border-primary)',
            display: 'grid',
            gap: 12,
          }}
        >
          <SectionLabel
            title="Recall funnel"
            subtitle="Read top to bottom. Fewer items should survive each stage."
          />
          <RatioBar
            label="Checked recalls"
            value={overallActionable}
            total={overallActionable || 1}
            color="var(--color-accent-primary)"
          />
          <RatioBar
            label="Injected at all"
            value={overallStats.injected}
            total={overallActionable || 1}
            color="var(--color-accent-primary)"
          />
          <RatioBar
            label="Likely helpful"
            value={overallStats.likelyHelped}
            total={overallActionable || 1}
            color="var(--color-accent-success)"
          />
          <RatioBar
            label="Manually confirmed"
            value={manualVoteCount}
            total={overallActionable || 1}
            color="var(--color-accent-warning)"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
          <SourceSummaryCard
            stats={fileStats}
            windowDays={windowDays}
            color="var(--color-accent-success)"
          />
          <SourceSummaryCard
            stats={promptStats}
            windowDays={windowDays}
            color="var(--color-accent-primary)"
          />
          <SourceSummaryCard
            stats={summaryStats}
            windowDays={windowDays}
            color="var(--color-accent-primary)"
          />
        </div>

        {tokenEconomics && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <span style={{ fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', fontSize: 11, color: 'var(--color-text-muted)' }}>
              Token efficiency
            </span>
            <button
              type="button"
              aria-label="Processed: tokens claude-mem spent reading tool use and sessions to build observations (the discovery cost). Stored: compressed size of all observations in the knowledge base. Compression: how much smaller the stored form is vs what was processed."
              onClick={(event) => toggleTooltip(
                'efficiency-info',
                'Processed = tokens claude-mem consumed reading raw sessions to build observations (your AI spend on memory creation). Stored = compressed token footprint of all observations. Compression = processed / stored.',
                event.currentTarget
              )}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                height: 16,
                borderRadius: '50%',
                border: '1px solid var(--color-border-primary)',
                color: 'var(--color-accent-primary)',
                background: 'var(--color-bg-card-hover)',
                fontSize: 9,
                lineHeight: 1,
                fontWeight: 700,
                cursor: 'pointer',
                flex: '0 0 auto',
              }}
            >
              ?
            </button>
            <span>
              Processed: {formatTokenCount(tokenEconomics.totalDiscoveryTokens)}
            </span>
            <span style={{ color: 'var(--color-text-muted)' }}>·</span>
            <span>
              Stored: {formatTokenCount(tokenEconomics.totalReadTokens)}
            </span>
            <span style={{ color: 'var(--color-text-muted)' }}>·</span>
            <span style={{ color: 'var(--color-accent-success)', fontWeight: 600 }}>
              {tokenEconomics.savingsPercent}% compression
            </span>
          </div>
        )}

      </div>

      {openTooltip && createPortal(
        <div
          data-memory-assist-tooltip-popover="true"
          role="tooltip"
          style={{
            position: 'fixed',
            top: openTooltip.top,
            left: openTooltip.left,
            width: 280,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--color-border-primary)',
            background: 'var(--color-bg-card)',
            color: 'var(--color-text-secondary)',
            fontSize: 12,
            lineHeight: 1.45,
            boxShadow: '0 16px 36px rgba(0,0,0,0.22)',
            zIndex: 9999,
          }}
        >
          {openTooltip.info}
        </div>,
        document.body
      )}
    </>
  );
}
