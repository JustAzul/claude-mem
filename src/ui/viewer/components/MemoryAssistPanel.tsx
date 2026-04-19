import React, { useEffect, useMemo, useState } from 'react';
import type { MemoryAssistEvent } from '../../../shared/memory-assist';
import type { Stats } from '../types';
import { MemoryAssistOverview } from './memory-assist/MemoryAssistOverview';
import { MemoryAssistCalibrationView } from './memory-assist/MemoryAssistCalibrationView';
import { MemoryAssistTrace } from './memory-assist/MemoryAssistTrace';
import { MemoryAssistActivityList } from './memory-assist/MemoryAssistActivityList';
import { MemoryAssistMcpUsage } from './memory-assist/MemoryAssistMcpUsage';
import type { FeedbackLabel, FeedbackStats, ObservationTraceDetail } from './memory-assist/shared';
import {
  DEBUG_REASONS,
  SCORECARD_WINDOW,
  eventKey,
  getSourceStats,
} from './memory-assist/shared';

const COLLAPSED_STORAGE_KEY = 'claude-mem.memoryAssistPanel.collapsed';
const HOW_TO_READ_DISMISSED_KEY = 'claude-mem.memoryAssistPanel.howToReadDismissed';

function readCollapsedFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (raw === null) return true; // default: collapsed for new users
    return raw === 'true';
  } catch (error: unknown) {
    // Private browsing or quota issue — fall back to default
    return true;
  }
}

function writeCollapsedToStorage(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch (error: unknown) {
    // Quota exceeded or storage unavailable — collapse state is ephemeral this session
  }
}

function readHowToReadDismissedFromStorage(): boolean {
  try {
    return localStorage.getItem(HOW_TO_READ_DISMISSED_KEY) === 'true';
  } catch (error: unknown) {
    // Private browsing or quota issue — fall back to visible
    return false;
  }
}

function writeHowToReadDismissedToStorage(dismissed: boolean): void {
  try {
    if (dismissed) {
      localStorage.setItem(HOW_TO_READ_DISMISSED_KEY, 'true');
    } else {
      localStorage.removeItem(HOW_TO_READ_DISMISSED_KEY);
    }
  } catch (error: unknown) {
    // Quota exceeded or storage unavailable — dismiss state is ephemeral this session
  }
}

interface MemoryAssistPanelProps {
  events: MemoryAssistEvent[];
  semanticInjectEnabled: boolean;
  semanticThreshold: string;
  stats: Stats;
  activeProject?: string;
  activePlatformSource?: string;
  onOpenTrace?: (observationId: number) => void;
}

export function MemoryAssistPanel({
  events,
  semanticInjectEnabled,
  semanticThreshold,
  stats,
  activeProject,
  activePlatformSource,
  onOpenTrace,
}: MemoryAssistPanelProps) {
  type MemoryAssistPanelTab = 'overview' | 'activity' | 'calibration' | 'mcpUsage';
  const threshold = parseFloat(semanticThreshold || '0.35');
  const safeThreshold = Number.isFinite(threshold) ? threshold : 0.35;
  const scopedEvents = useMemo(
    () => events.filter((event) => {
      const matchesProject = !activeProject || event.project === activeProject;
      const matchesPlatformSource = !activePlatformSource || activePlatformSource === 'all' || event.platformSource === activePlatformSource;
      return matchesProject && matchesPlatformSource;
    }),
    [activePlatformSource, activeProject, events]
  );
  const visibleEvents = useMemo(
    () => scopedEvents.filter((event) => !DEBUG_REASONS.has(event.reason)),
    [scopedEvents]
  );
  const latest = visibleEvents[0];
  const scorecardEvents = visibleEvents.slice(0, SCORECARD_WINDOW);
  const recentOverallStats = useMemo(() => {
    const injected = scorecardEvents.filter((event) => event.status === 'injected').length;
    const checkedNoHelp = scorecardEvents.filter((event) => event.status === 'skipped').length;
    const actionable = injected + checkedNoHelp;
    const likelyHelped = scorecardEvents.filter((event) => event.systemVerdict === 'likely_helped').length;
    const userConfirmedHelpful = scorecardEvents.filter((event) => event.userFeedback === 'helpful').length;
    const userConfirmedNotHelpful = scorecardEvents.filter((event) => event.userFeedback === 'not_helpful').length;
    return {
      total: scorecardEvents.length,
      injected,
      injectRate: actionable > 0 ? Math.round((injected / actionable) * 100) : null,
      likelyHelped,
      likelyHelpedRate: actionable > 0 ? Math.round((likelyHelped / actionable) * 100) : null,
      userConfirmedHelpful,
      userConfirmedHelpfulRate: (userConfirmedHelpful + userConfirmedNotHelpful) > 0
        ? Math.round((userConfirmedHelpful / (userConfirmedHelpful + userConfirmedNotHelpful)) * 100)
        : null,
      helped: injected,
      checkedNoHelp,
      helpRate: actionable > 0 ? Math.round((injected / actionable) * 100) : null,
    };
  }, [scorecardEvents]);
  const recentPromptStats = useMemo(
    () => getSourceStats(scorecardEvents, 'semantic_prompt'),
    [scorecardEvents]
  );
  const recentSummaryStats = useMemo(
    () => getSourceStats(scorecardEvents, 'semantic_summary'),
    [scorecardEvents]
  );
  const recentFileStats = useMemo(
    () => getSourceStats(scorecardEvents, 'file_context'),
    [scorecardEvents]
  );

  const [isCollapsed, setIsCollapsed] = useState<boolean>(readCollapsedFromStorage);
  const [howToReadDismissed, setHowToReadDismissed] = useState<boolean>(readHowToReadDismissedFromStorage);
  const [selectedTraceKey, setSelectedTraceKey] = useState<string | null>(null);
  const [openObservationId, setOpenObservationId] = useState<number | null>(null);
  const [detailCache, setDetailCache] = useState<Record<number, ObservationTraceDetail | null>>({});
  const [loadingObservationId, setLoadingObservationId] = useState<number | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [feedbackStats, setFeedbackStats] = useState<FeedbackStats | null>(null);
  const [submittingFeedback, setSubmittingFeedback] = useState<FeedbackLabel | null>(null);
  const [feedbackByEventKey, setFeedbackByEventKey] = useState<Record<string, FeedbackLabel>>({});
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [activeTab, setActiveTab] = useState<MemoryAssistPanelTab>('overview');

  function toggleCollapsed(): void {
    setIsCollapsed((prev) => {
      const next = !prev;
      writeCollapsedToStorage(next);
      return next;
    });
  }

  function handleHowToReadDismissedChange(dismissed: boolean): void {
    writeHowToReadDismissedToStorage(dismissed);
    setHowToReadDismissed(dismissed);
  }
  const overallStats = feedbackStats
    ? {
        total: feedbackStats.totalDecisions,
        injected: feedbackStats.injected,
        injectRate: feedbackStats.injectRate,
        likelyHelped: feedbackStats.likelyHelped,
        likelyHelpedRate: feedbackStats.likelyHelpedRate,
        userConfirmedHelpful: feedbackStats.helpful,
        userConfirmedHelpfulRate: feedbackStats.userConfirmedHelpfulRate,
        estimatedInjectedTokens: feedbackStats.estimatedInjectedTokens,
        helpfulRecallsPer1kInjectedTokens: feedbackStats.helpfulRecallsPer1kInjectedTokens,
        injectedTokensPerLikelyHelpedRecall: feedbackStats.injectedTokensPerLikelyHelpedRecall,
        taxonomyCorrectionRate: feedbackStats.taxonomyCorrectionRate,
        helped: feedbackStats.helped,
        checkedNoHelp: feedbackStats.checkedNoHelp,
        helpRate: feedbackStats.helpRate,
      }
    : recentOverallStats;
  const promptStats = feedbackStats?.sourceStats?.semantic_prompt ?? recentPromptStats;
  const summaryStats = feedbackStats?.sourceStats?.semantic_summary ?? recentSummaryStats;
  const fileStats = feedbackStats?.sourceStats?.file_context ?? recentFileStats;

  const selectedTraceEvent = useMemo(() => {
    if (!selectedTraceKey) return null;
    return visibleEvents.find((event, index) => eventKey(event, index) === selectedTraceKey) ?? null;
  }, [selectedTraceKey, visibleEvents]);

  useEffect(() => {
    let cancelled = false;

    async function loadFeedbackStats() {
      try {
        const response = await fetch(`/api/memory-assist/stats?days=${windowDays}`);
        if (!response.ok) throw new Error(`status:${response.status}`);
        const payload = await response.json() as FeedbackStats;
        if (!cancelled) {
          setFeedbackStats(payload);
        }
      } catch {
        if (!cancelled) {
          setFeedbackStats(null);
        }
      }
    }

    void loadFeedbackStats();
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  useEffect(() => {
    if (!latest) return;

    let cancelled = false;
    async function refreshDashboard() {
      try {
        const response = await fetch(`/api/memory-assist/stats?days=${windowDays}`);
        if (!response.ok) throw new Error(`status:${response.status}`);
        const payload = await response.json() as FeedbackStats;
        if (!cancelled) {
          setFeedbackStats(payload);
        }
      } catch {
        // Keep the last successful dashboard snapshot.
      }
    }

    void refreshDashboard();
    return () => {
      cancelled = true;
    };
  }, [latest?.id, latest?.timestamp, windowDays]);

  useEffect(() => {
    if (!latest?.traceItems?.length || latest.status !== 'injected') {
      return;
    }

    setSelectedTraceKey(eventKey(latest, 0));
  }, [latest?.id, latest?.timestamp, latest?.status, latest?.traceItems]);

  useEffect(() => {
    if (!selectedTraceEvent?.traceItems?.length) {
      setOpenObservationId(null);
      setDetailError(null);
      setFeedbackError(null);
      return;
    }

    setOpenObservationId(null);
    setDetailError(null);
    setFeedbackError(null);
  }, [selectedTraceEvent?.timestamp, selectedTraceEvent?.traceItems]);

  useEffect(() => {
    let cancelled = false;

    async function loadObservationDetail(observationId: number) {
      if (detailCache[observationId] !== undefined) return;

      setLoadingObservationId(observationId);
      setDetailError(null);

      try {
        const response = await fetch(`/api/observation/${observationId}`);
        if (!response.ok) {
          throw new Error(`status:${response.status}`);
        }
        const detail = await response.json() as ObservationTraceDetail;
        if (!cancelled) {
          setDetailCache((prev) => ({ ...prev, [observationId]: detail }));
        }
      } catch (error) {
        if (!cancelled) {
          setDetailCache((prev) => ({ ...prev, [observationId]: null }));
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoadingObservationId((current) => (current === observationId ? null : current));
        }
      }
    }

    if (openObservationId != null) {
      void loadObservationDetail(openObservationId);
    }

    return () => {
      cancelled = true;
    };
  }, [openObservationId, detailCache]);

  async function submitFeedback(label: FeedbackLabel): Promise<void> {
    if (!selectedTraceEvent?.traceItems?.length || !selectedTraceKey) return;

    setSubmittingFeedback(label);
    setFeedbackError(null);
    try {
      const response = await fetch('/api/memory-assist/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          observationIds: selectedTraceEvent.traceItems.map((item) => item.observationId),
          label,
          sessionDbId: selectedTraceEvent.sessionDbId,
          metadata: {
            source: selectedTraceEvent.source,
            project: selectedTraceEvent.project,
            contentSessionId: selectedTraceEvent.contentSessionId,
            eventTimestamp: selectedTraceEvent.timestamp,
            reason: selectedTraceEvent.reason,
          },
          decisionId: selectedTraceEvent.id,
        }),
      });
      if (!response.ok) {
        throw new Error(`status:${response.status}`);
      }

      setFeedbackByEventKey((prev) => ({ ...prev, [selectedTraceKey]: label }));

      const statsResponse = await fetch(`/api/memory-assist/stats?days=${windowDays}`);
      if (statsResponse.ok) {
        const payload = await statsResponse.json() as FeedbackStats;
        setFeedbackStats(payload);
      }
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmittingFeedback(null);
    }
  }

  const selectedFeedback = selectedTraceKey ? feedbackByEventKey[selectedTraceKey] : null;

  // --- Compact strip metric helpers ---
  // likelyHelpedRate: % of actionable decisions where memory likely helped
  const stripLikelyHelpedRate: number | null = overallStats.likelyHelpedRate ?? null;
  // helpRate: % of actionable decisions that were injected
  const stripHelpRate: number | null = overallStats.helpRate ?? null;
  // checked counter: how many were injected out of total actionable
  const stripInjected: number = overallStats.injected ?? 0;
  const stripTotal: number = (overallStats.injected ?? 0) + (overallStats.checkedNoHelp ?? 0);

  if (isCollapsed) {
    return (
      <div
        style={{
          margin: '12px 24px 0',
          padding: '0 16px',
          height: 56,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          borderRadius: 10,
          border: '1px solid var(--color-border-primary)',
          background: 'var(--color-bg-card)',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
          cursor: 'default',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
          Memory Assist
        </span>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'nowrap', overflow: 'hidden' }}>
          {stripLikelyHelpedRate !== null && (
            <span style={{
              padding: '3px 8px',
              borderRadius: 6,
              background: 'color-mix(in srgb, var(--color-accent-primary) 12%, transparent)',
              color: 'var(--color-accent-primary)',
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}>
              {stripLikelyHelpedRate}% likely helped
            </span>
          )}
          {stripHelpRate !== null && (
            <span style={{
              padding: '3px 8px',
              borderRadius: 6,
              background: 'var(--color-bg-card-hover)',
              color: 'var(--color-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}>
              {stripHelpRate}% inject rate
            </span>
          )}
          {stripTotal > 0 && (
            <span style={{
              padding: '3px 8px',
              borderRadius: 6,
              background: 'var(--color-bg-card-hover)',
              color: 'var(--color-text-muted)',
              fontSize: 11,
              fontWeight: 500,
              whiteSpace: 'nowrap',
            }}>
              {stripInjected}/{stripTotal} helped
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Expand Memory Assist panel"
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid var(--color-border-primary)',
            background: 'var(--color-bg-card-hover)',
            color: 'var(--color-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          Expand
        </button>
      </div>
    );
  }

  const tabButtonStyle = (tab: MemoryAssistPanelTab): React.CSSProperties => ({
    padding: '8px 12px',
    borderRadius: 999,
    border: tab === activeTab
      ? '1px solid var(--color-accent-primary)'
      : '1px solid var(--color-border-primary)',
    background: tab === activeTab
      ? 'color-mix(in srgb, var(--color-accent-primary) 12%, transparent)'
      : 'var(--color-bg-card-hover)',
    color: tab === activeTab ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  });

  return (
    <section
      style={{
        margin: '16px 24px 16px',
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-card)',
        color: 'var(--color-text-primary)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.08)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          style={tabButtonStyle('overview')}
        >
          Overview
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('activity')}
          style={tabButtonStyle('activity')}
        >
          Trace & activity
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('calibration')}
          style={tabButtonStyle('calibration')}
        >
          Calibration
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('mcpUsage')}
          style={tabButtonStyle('mcpUsage')}
        >
          MCP Usage
        </button>
        {howToReadDismissed && activeTab === 'overview' && (
          <button
            type="button"
            onClick={() => handleHowToReadDismissedChange(false)}
            aria-label="Show how to read this panel"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 10px',
              borderRadius: 999,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-card-hover)',
              color: 'var(--color-text-muted)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ? Help
          </button>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Collapse Memory Assist panel"
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 10px',
            borderRadius: 999,
            border: '1px solid var(--color-border-primary)',
            background: 'var(--color-bg-card-hover)',
            color: 'var(--color-text-secondary)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
          Collapse
        </button>
      </div>

      {activeTab === 'overview' && (
      <MemoryAssistOverview
        latest={latest}
        semanticInjectEnabled={semanticInjectEnabled}
        semanticThreshold={semanticThreshold}
        safeThreshold={safeThreshold}
        windowDays={windowDays}
        overallStats={overallStats}
        promptStats={promptStats}
        summaryStats={summaryStats}
        fileStats={fileStats}
        feedbackStats={feedbackStats}
        tokenEconomics={stats.tokenEconomics ?? null}
        howToReadDismissed={howToReadDismissed}
        onHowToReadDismissedChange={handleHowToReadDismissedChange}
        onTraceLatest={() => {
          if (!latest) return;
          setSelectedTraceKey(eventKey(latest, 0));
          setActiveTab('activity');
        }}
        implicitUseRate={stats.implicitUseRate ?? null}
        implicitUseCounts={stats.implicitUseCounts ?? null}
        recentTrend={stats.recentTrend ?? null}
      />
      )}

      {activeTab === 'calibration' && (
        <MemoryAssistCalibrationView
          dashboard={feedbackStats}
          windowDays={windowDays}
          onWindowDaysChange={setWindowDays}
          defaultProject={activeProject ?? null}
        />
      )}

      {activeTab === 'mcpUsage' && (
        <MemoryAssistMcpUsage />
      )}

      {activeTab === 'activity' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            This tab is for auditing specific recalls. Open a trace when you want to inspect what memory was used, what follow-up actions happened, and how the judge reached its verdict.
          </div>

          {selectedTraceEvent?.traceItems && selectedTraceEvent.traceItems.length > 0 ? (
            <MemoryAssistTrace
              event={selectedTraceEvent}
              safeThreshold={safeThreshold}
              selectedFeedback={selectedFeedback}
              submittingFeedback={submittingFeedback}
              feedbackError={feedbackError}
              openObservationId={openObservationId}
              detailCache={detailCache}
              loadingObservationId={loadingObservationId}
              detailError={detailError}
              onSubmitFeedback={(label) => void submitFeedback(label)}
              onClose={() => setSelectedTraceKey(null)}
              onToggleObservation={(observationId) => {
                setOpenObservationId((current) => current === observationId ? null : observationId);
                setDetailError(null);
              }}
              onOpenTrace={onOpenTrace}
            />
          ) : (
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                border: '1px dashed var(--color-border-primary)',
                background: 'var(--color-bg-card-hover)',
                color: 'var(--color-text-secondary)',
                fontSize: 13,
              }}
            >
              Pick a recent helped item below to open its trace.
            </div>
          )}

          <MemoryAssistActivityList
            events={visibleEvents}
            safeThreshold={safeThreshold}
            selectedTraceKey={selectedTraceKey}
            onToggleTrace={(key) => setSelectedTraceKey((current) => current === key ? null : key)}
          />
        </div>
      )}
    </section>
  );
}
