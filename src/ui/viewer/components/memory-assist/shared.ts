import type {
  MemoryAssistCalibrationRecommendation,
  MemoryAssistDashboard,
  MemoryAssistEvent,
  MemoryAssistFeedbackStats,
  MemoryAssistTraceItem,
} from '../../../../shared/memory-assist';

export interface ObservationTraceDetail {
  id: number;
  title?: string | null;
  subtitle?: string | null;
  type?: string | null;
  narrative?: string | null;
  text?: string | null;
  facts?: string | null;
  created_at?: string | null;
  origin?: {
    pendingMessageId?: number | null;
    decisionId?: number | null;
    promptNumber?: number;
    toolName: string;
    action: string;
    filePath?: string | null;
    createdAtEpoch: number;
  } | null;
}

export type FeedbackStats = MemoryAssistDashboard & MemoryAssistFeedbackStats;

export type FeedbackLabel = 'helpful' | 'not_helpful';

export interface SourceAssistStats {
  source: 'semantic_prompt' | 'file_context';
  total: number;
  actionable: number;
  injected: number;
  injectRate: number | null;
  likelyHelped: number;
  likelyHelpedRate: number | null;
  userConfirmedHelpful: number;
  userConfirmedHelpfulRate: number | null;
  estimatedInjectedTokens?: number;
  helpfulRecallsPer1kInjectedTokens?: number | null;
  injectedTokensPerLikelyHelpedRecall?: number | null;
  taxonomyCorrectionCount?: number;
  taxonomyCorrectionRate?: number | null;
  shadowRanking?: {
    totalCompared: number;
    exactMatches: number;
    exactMatchRate: number | null;
    divergentSelections: number;
    avgSelectionOverlapRate: number | null;
    likelyHelpedWithExperimentalOverlap: number;
    likelyHelpedWithExperimentalOverlapRate: number | null;
  } | null;
  recommendation?: MemoryAssistCalibrationRecommendation;
  helped: number;
  checkedNoHelp: number;
  disabled: number;
  errors: number;
  helpRate: number | null;
  topSkipReasons: Array<{ reason: string; count: number }>;
}

export const DEBUG_REASONS = new Set(['manual_probe']);
export const SCORECARD_WINDOW = 30;

export function eventKey(event: MemoryAssistEvent, index = 0): string {
  return `${event.timestamp}:${event.source}:${event.reason}:${event.status}:${index}`;
}

export function formatTimestamp(epoch: number): string {
  return new Date(epoch).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDateTime(epoch?: number): string | null {
  if (!epoch) return null;
  return new Date(epoch).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function sourceLabel(event: MemoryAssistEvent): string {
  return event.source === 'semantic_prompt' ? 'Prompt memory' : 'File memory';
}

export function sourceHeading(source: 'semantic_prompt' | 'file_context'): string {
  return source === 'semantic_prompt' ? 'Prompt memory' : 'File memory';
}

export function badgeLabel(event?: MemoryAssistEvent): string {
  if (!event) return 'idle';
  if (event.status === 'injected') return 'helped';
  if (event.status === 'error') return 'error';
  if (event.status === 'disabled') return 'off';
  return 'checked';
}

export function toneFor(event?: MemoryAssistEvent): { border: string; bg: string; badge: string } {
  if (!event) {
    return {
      border: 'var(--color-border-primary)',
      bg: 'var(--color-bg-card-hover)',
      badge: 'var(--color-text-secondary)',
    };
  }

  if (event.status === 'injected') {
    return {
      border: 'var(--color-accent-success)',
      bg: 'color-mix(in srgb, var(--color-accent-success) 14%, transparent)',
      badge: 'var(--color-accent-success)',
    };
  }

  if (event.status === 'error') {
    return {
      border: 'var(--color-accent-error)',
      bg: 'color-mix(in srgb, var(--color-accent-error) 14%, transparent)',
      badge: 'var(--color-accent-error)',
    };
  }

  return {
    border: 'var(--color-accent-primary)',
    bg: 'color-mix(in srgb, var(--color-accent-primary) 10%, transparent)',
    badge: 'var(--color-accent-primary)',
  };
}

export function semanticThresholdCopy(source: MemoryAssistEvent['source']): string {
  return source === 'semantic_prompt' ? 'semantic recall' : 'file timeline';
}

export function distanceAssessment(bestDistance: number, threshold: number): {
  delta: number;
  percentage: number;
  withinLimit: boolean;
  headline: string;
  subline: string;
} {
  const delta = bestDistance - threshold;
  const withinLimit = delta <= 0;
  const base = threshold > 0 ? Math.abs(delta) / threshold : 0;
  const percentage = Math.round(base * 100);

  if (withinLimit) {
    return {
      delta: Math.abs(delta),
      percentage,
      withinLimit: true,
      headline: `${percentage}% inside the limit`,
      subline: `${bestDistance.toFixed(3)} vs limit ${threshold.toFixed(3)}`,
    };
  }

  return {
    delta,
    percentage,
    withinLimit: false,
    headline: `${percentage}% worse than the limit`,
    subline: `${bestDistance.toFixed(3)} vs limit ${threshold.toFixed(3)}`,
  };
}

export function reasonSummary(event: MemoryAssistEvent, threshold: number): string {
  const label = sourceLabel(event);

  if (event.status === 'injected') {
    const selected = event.selectedCount ?? 0;
    if (event.source === 'semantic_prompt') {
      return `${label} added ${selected} relevant memory item${selected === 1 ? '' : 's'} to this prompt.`;
    }
    return `${label} added ${selected} timeline item${selected === 1 ? '' : 's'} for this file read.`;
  }

  if (event.status === 'disabled') {
    return `${label} is turned off, so no memory was considered here.`;
  }

  if (event.status === 'error') {
    return `${label} hit an error and could not contribute context.`;
  }

  switch (event.reason) {
    case 'below_threshold': {
      if (event.bestDistance == null) {
        return `${label} checked memory, but none of the matches were strong enough to inject.`;
      }
      const verdict = distanceAssessment(event.bestDistance, threshold);
      return `${label} checked memory, but the closest match was still too weak: ${verdict.headline.toLowerCase()} (${verdict.subline}).`;
    }
    case 'query_too_short':
      return `${label} skipped because the prompt was too short to search confidently.`;
    case 'file_too_small':
      return `${label} skipped because reading the file directly is cheaper than injecting memory.`;
    case 'file_newer_than_memory':
      return `${label} skipped because the file is newer than the saved memory about it.`;
    case 'no_observations':
    case 'no_matches':
      return `${label} checked memory, but there was nothing relevant yet.`;
    case 'semantic_search_unavailable':
      return `${label} skipped because semantic search is unavailable right now.`;
    case 'project_excluded':
      return `${label} skipped because this project is excluded from memory tracking.`;
    case 'media_prompt':
      return `${label} skipped because this was a media-only prompt.`;
    default:
      return `${label} did not inject anything for this step.`;
  }
}

export function eventListSummary(event: MemoryAssistEvent, threshold: number): string {
  const label = sourceLabel(event);

  if (event.status === 'injected') {
    const selected = event.selectedCount ?? event.traceItems?.length ?? 0;
    return `${label} helped with ${selected} item${selected === 1 ? '' : 's'}`;
  }

  if (event.reason === 'below_threshold' && event.bestDistance != null) {
    const verdict = distanceAssessment(event.bestDistance, threshold);
    return `${label} checked memory, but the best match was ${verdict.headline.toLowerCase()}`;
  }

  if (event.reason === 'query_too_short') {
    return `${label} skipped because the prompt was too short`;
  }

  if (event.status === 'disabled') {
    return `${label} is turned off`;
  }

  if (event.status === 'error') {
    return `${label} errored`;
  }

  return `${label} skipped: ${formatReasonLabel(event.reason)}`;
}

export function detailPills(event: MemoryAssistEvent, threshold: number): Array<{ label: string; value: string }> {
  const pills: Array<{ label: string; value: string }> = [
    { label: 'Mode', value: semanticThresholdCopy(event.source) },
  ];

  if (event.bestDistance != null && event.source === 'semantic_prompt') {
    const verdict = distanceAssessment(event.bestDistance, threshold);
    pills.push({ label: 'Best match', value: event.bestDistance.toFixed(3) });
    pills.push({ label: 'Your limit', value: threshold.toFixed(3) });
    pills.push({
      label: verdict.withinLimit ? 'Inside limit' : 'Above limit',
      value: `${verdict.percentage}%`,
    });
  }

  if (event.candidateCount != null) {
    pills.push({ label: 'Candidates seen', value: String(event.candidateCount) });
  }

  if (event.selectedCount != null) {
    pills.push({ label: 'Injected', value: String(event.selectedCount) });
  }

  return pills;
}

export function meterMax(threshold: number, bestDistance?: number | null, worstDistance?: number | null): number {
  const ceiling = Math.max(threshold, bestDistance ?? 0, worstDistance ?? 0, 1);
  return Math.min(Math.max(ceiling, 0.5), 1.5);
}

export function markerLeft(value: number, max: number): string {
  return `${Math.min(Math.max((value / max) * 100, 0), 100)}%`;
}

export function formatTokenCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value.toLocaleString();
}

export function redactPathForDisplay(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/').trim();
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function formatSignalSource(value?: string | null): string {
  if (!value) return 'unknown';
  return value.replace(/_/g, ' ');
}

export function formatEvidenceStrength(value?: string | null): string {
  if (!value) return 'context';
  return value.replace(/_/g, ' ');
}

export function outcomeKeyFromParts(input: {
  outcomeId?: number;
  pendingMessageId?: number | null;
  toolName: string;
  action: string;
  filePath?: string | null;
  timestamp?: number;
}): string {
  return [
    input.outcomeId ?? 'no-id',
    input.pendingMessageId ?? 'no-pending',
    input.toolName,
    input.action,
    input.filePath ?? 'no-file',
    input.timestamp ?? 'no-ts',
  ].join(':');
}

export function traceSummary(traceItems: MemoryAssistTraceItem[]): string {
  if (traceItems.length === 0) return 'No trace available';
  if (traceItems.length === 1) return '1 memory item was injected';
  return `${traceItems.length} memory items were injected`;
}

export function normalizeTraceBody(detail?: ObservationTraceDetail | null): string | null {
  if (!detail) return null;
  return detail.narrative || detail.text || detail.facts || null;
}

export function formatReasonLabel(reason: string): string {
  return reason.replace(/_/g, ' ');
}

export function topSkipReasons(events: MemoryAssistEvent[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.status !== 'skipped') continue;
    counts.set(event.reason, (counts.get(event.reason) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([reason, count]) => ({ reason, count }));
}

export function getSourceStats(
  events: MemoryAssistEvent[],
  source: 'semantic_prompt' | 'file_context'
): SourceAssistStats {
  const sourceEvents = events.filter((event) => event.source === source);
  const injected = sourceEvents.filter((event) => event.status === 'injected').length;
  const checkedNoHelp = sourceEvents.filter((event) => event.status === 'skipped').length;
  const disabled = sourceEvents.filter((event) => event.status === 'disabled').length;
  const errors = sourceEvents.filter((event) => event.status === 'error').length;
  const actionable = injected + checkedNoHelp;
  const injectRate = actionable > 0 ? Math.round((injected / actionable) * 100) : null;
  const likelyHelped = sourceEvents.filter((event) => event.systemVerdict === 'likely_helped').length;
  const likelyHelpedRate = actionable > 0 ? Math.round((likelyHelped / actionable) * 100) : null;
  const userConfirmedHelpful = sourceEvents.filter((event) => event.userFeedback === 'helpful').length;
  const userConfirmedNotHelpful = sourceEvents.filter((event) => event.userFeedback === 'not_helpful').length;
  const userConfirmedHelpfulRate = (userConfirmedHelpful + userConfirmedNotHelpful) > 0
    ? Math.round((userConfirmedHelpful / (userConfirmedHelpful + userConfirmedNotHelpful)) * 100)
    : null;

  return {
    source,
    total: sourceEvents.length,
    actionable,
    injected,
    injectRate,
    likelyHelped,
    likelyHelpedRate,
    userConfirmedHelpful,
    userConfirmedHelpfulRate,
    helped: injected,
    checkedNoHelp,
    disabled,
    errors,
    helpRate: injectRate,
    topSkipReasons: topSkipReasons(sourceEvents),
  };
}
