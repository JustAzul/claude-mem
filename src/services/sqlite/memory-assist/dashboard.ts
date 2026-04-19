import { Database } from 'bun:sqlite';
import type {
  MemoryAssistCalibrationRecommendation,
  MemoryAssistDashboard,
  MemoryAssistDecisionRecord,
  MemoryAssistProjectSourceStats,
  MemoryAssistProjectStats,
  MemoryAssistRecommendationSlice,
  MemoryAssistSegmentStats,
  MemoryAssistShadowRankingStats,
  MemoryAssistSourceStats,
  MemoryAssistSystemVerdict,
} from '../../../shared/memory-assist.js';
import type { ObservationFeedbackStats } from '../observations/feedback.js';
import { getObservationFeedbackStats } from '../observations/feedback.js';
import { getObservationTypeCorrectionStats } from './taxonomy.js';
import { isRecommenderPaused, RECOMMENDER_PAUSED_REASON } from './recommender-gate.js';
import { logger } from '../../../utils/logger.js';

function roundPercent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

function buildSkipReasons(decisions: MemoryAssistDecisionRecord[]): Array<{ reason: string; count: number }> {
  const skipReasonCounts = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.status !== 'skipped') continue;
    skipReasonCounts.set(decision.reason, (skipReasonCounts.get(decision.reason) ?? 0) + 1);
  }

  return Array.from(skipReasonCounts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
}

function buildVerdicts(decisions: MemoryAssistDecisionRecord[]): Record<MemoryAssistSystemVerdict, number> {
  const verdicts: Record<MemoryAssistSystemVerdict, number> = {
    likely_helped: 0,
    unclear: 0,
    likely_not_helped: 0,
  };

  for (const decision of decisions) {
    if (!decision.systemVerdict) continue;
    verdicts[decision.systemVerdict] += 1;
  }

  return verdicts;
}

function arraysEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function selectionOverlapRate(left: number[], right: number[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 100;
  const intersection = [...leftSet].filter((value) => rightSet.has(value)).length;
  return (intersection / union.size) * 100;
}

function buildShadowRankingStats(decisions: MemoryAssistDecisionRecord[]): MemoryAssistShadowRankingStats | null {
  const semanticDecisions = decisions.filter(
    (decision) =>
      decision.source === 'semantic_prompt'
      && decision.shadowRanking?.experimentalSelectedObservationIds
      && decision.shadowRanking.productionSelectedObservationIds
  );

  if (semanticDecisions.length === 0) {
    return null;
  }

  let exactMatches = 0;
  let overlapAccumulator = 0;
  let likelyHelpedWithExperimentalOverlap = 0;
  let likelyHelpedCompared = 0;

  for (const decision of semanticDecisions) {
    const production = [...(decision.shadowRanking?.productionSelectedObservationIds ?? [])].sort((a, b) => a - b);
    const experimental = [...(decision.shadowRanking?.experimentalSelectedObservationIds ?? [])].sort((a, b) => a - b);

    if (arraysEqual(production, experimental)) {
      exactMatches += 1;
    }

    overlapAccumulator += selectionOverlapRate(production, experimental);

    if (decision.systemVerdict === 'likely_helped') {
      likelyHelpedCompared += 1;
      const traceObservationIds = new Set((decision.traceItems ?? []).map((item) => item.observationId));
      const experimentalOverlap = experimental.some((observationId) => traceObservationIds.has(observationId));
      if (experimentalOverlap) {
        likelyHelpedWithExperimentalOverlap += 1;
      }
    }
  }

  return {
    totalCompared: semanticDecisions.length,
    exactMatches,
    exactMatchRate: roundPercent(exactMatches, semanticDecisions.length),
    divergentSelections: semanticDecisions.length - exactMatches,
    avgSelectionOverlapRate: roundMetric(overlapAccumulator / semanticDecisions.length),
    likelyHelpedWithExperimentalOverlap,
    likelyHelpedWithExperimentalOverlapRate: roundPercent(likelyHelpedWithExperimentalOverlap, likelyHelpedCompared),
  };
}

function buildRecommendation(stats: {
  actionable: number;
  injectRate: number | null;
  likelyHelpedRate: number | null;
  topSkipReasons: Array<{ reason: string; count: number }>;
  shadowRanking: MemoryAssistShadowRankingStats | null;
}, slice: MemoryAssistRecommendationSlice): MemoryAssistCalibrationRecommendation {
  // Short-circuit: the prescriptive recommender is gated off until Probe B
  // lands a validated content-reuse signal. `likelyHelpedRate` is currently
  // derived from path-overlap tautologies (see recommender-gate.ts).
  if (isRecommenderPaused()) {
    return {
      kind: 'paused',
      reason: RECOMMENDER_PAUSED_REASON,
      slice,
    };
  }

  if (stats.actionable < 20) {
    return {
      kind: 'insufficient_data',
      reason: 'Need at least 20 actionable decisions before making a threshold recommendation.',
      confidence: 0.35,
      suggestedDelta: null,
      actionable: stats.actionable,
      slice,
    };
  }

  const belowThresholdSkips = stats.topSkipReasons.find((item) => item.reason === 'below_threshold')?.count ?? 0;
  const dominantBelowThreshold = belowThresholdSkips > 0
    && belowThresholdSkips >= Math.ceil(stats.actionable * 0.25);
  const shadowSuggestsOpportunity = (stats.shadowRanking?.divergentSelections ?? 0) > 0
    || (stats.shadowRanking?.likelyHelpedWithExperimentalOverlap ?? 0) > 0;

  if ((stats.injectRate ?? 0) >= 40 && (stats.likelyHelpedRate ?? 0) <= 10) {
    return {
      kind: 'lower_threshold',
      reason: 'Injection volume is high, but few recalls are being judged helpful. Tighten the threshold slightly.',
      confidence: 0.8,
      suggestedDelta: -0.05,
      actionable: stats.actionable,
      slice,
    };
  }

  if ((stats.injectRate ?? 0) <= 5 && dominantBelowThreshold && shadowSuggestsOpportunity) {
    return {
      kind: 'raise_threshold',
      reason: 'Below-threshold skips dominate this slice and shadow ranking shows missed alternatives. Loosen the threshold slightly.',
      confidence: 0.72,
      suggestedDelta: 0.05,
      actionable: stats.actionable,
      slice,
    };
  }

  return {
    kind: 'keep_threshold',
    reason: 'This slice looks balanced enough to keep the current threshold for now.',
    confidence: 0.58,
    suggestedDelta: 0,
    actionable: stats.actionable,
    slice,
  };
}

function buildSegmentStats(
  decisions: MemoryAssistDecisionRecord[],
  taxonomyCorrectionCount: number | null,
  slice: MemoryAssistRecommendationSlice,
  observationCount: number | null = null,
): MemoryAssistSegmentStats {
  const total = decisions.length;
  const injected = decisions.filter((decision) => decision.status === 'injected').length;
  const checkedNoInject = decisions.filter((decision) => decision.status === 'skipped').length;
  const disabled = decisions.filter((decision) => decision.status === 'disabled').length;
  const errors = decisions.filter((decision) => decision.status === 'error').length;
  const actionable = injected + checkedNoInject;
  const verdicts = buildVerdicts(decisions);
  const likelyHelped = verdicts.likely_helped;
  const userConfirmedHelpful = decisions.filter((decision) => decision.userFeedback === 'helpful').length;
  const userConfirmedNotHelpful = decisions.filter((decision) => decision.userFeedback === 'not_helpful').length;
  const estimatedInjectedTokens = decisions.reduce((sum, decision) => sum + (decision.estimatedInjectedTokens ?? 0), 0);

  // helped / helpRate measure judge-evaluated helpfulness, not injection count.
  // Previously `helped: injected` and `helpRate: injected/actionable` duplicated
  // the inject rate under a helpfulness label — the math was incoherent and the
  // UI silently lied. Correct formulation: count of decisions judged helpful,
  // rate computed per injected decision (the set where help could occur).
  const helped = likelyHelped;
  const helpRate = roundPercent(likelyHelped, injected);

  // taxonomy correction rate is observation-level (corrections per observation),
  // not decision-level. Old denominator (decisions.length) produced >100% values
  // because corrections outnumber decisions in typical workloads (observations
  // are much more frequent than memory-assist decisions). Fall back to the
  // decisions denominator only when observationCount isn't provided.
  const taxonomyDenominator = observationCount ?? total;
  const taxonomyCorrectionRate = taxonomyCorrectionCount == null
    ? null
    : roundPercent(taxonomyCorrectionCount, taxonomyDenominator);

  const segment = {
    total,
    actionable,
    injected,
    injectRate: roundPercent(injected, actionable),
    likelyHelped,
    likelyHelpedRate: roundPercent(likelyHelped, actionable),
    userConfirmedHelpful,
    userConfirmedHelpfulRate: roundPercent(userConfirmedHelpful, userConfirmedHelpful + userConfirmedNotHelpful),
    helped,
    checkedNoHelp: Math.max(injected - helped, 0),
    disabled,
    errors,
    helpRate,
    topSkipReasons: buildSkipReasons(decisions),
    verdicts,
    estimatedInjectedTokens,
    helpfulRecallsPer1kInjectedTokens: estimatedInjectedTokens > 0
      ? roundMetric((likelyHelped / estimatedInjectedTokens) * 1000)
      : null,
    injectedTokensPerLikelyHelpedRecall: likelyHelped > 0
      ? roundMetric(estimatedInjectedTokens / likelyHelped)
      : null,
    taxonomyCorrectionCount,
    taxonomyCorrectionRate,
    shadowRanking: buildShadowRankingStats(decisions),
  };
  return {
    ...segment,
    recommendation: buildRecommendation(segment, slice),
  };
}

/**
 * Count observations in the window for a given scope. Used as the denominator
 * for taxonomy correction rate — corrections happen at observation-level, so
 * using decisions.length would produce >100% rates in typical workloads.
 */
function countObservationsInWindow(
  db: Database,
  windowDays: number,
  project?: string,
): number {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const sql = project
    ? 'SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? AND project = ?'
    : 'SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ?';
  const row = (project
    ? db.prepare(sql).get(cutoff, project)
    : db.prepare(sql).get(cutoff)) as { c: number };
  return row.c;
}

function buildSourceStats(
  source: MemoryAssistSourceStats['source'],
  decisions: MemoryAssistDecisionRecord[],
  taxonomyCorrectionCount: number | null,
  observationCount: number | null = null,
): MemoryAssistSourceStats {
  return {
    source,
    ...buildSegmentStats(decisions, taxonomyCorrectionCount, {
      scope: 'source',
      key: source,
      source,
    }, observationCount),
  };
}

function buildProjectStats(
  project: string,
  decisions: MemoryAssistDecisionRecord[],
  taxonomyCorrectionCount: number | null,
  observationCount: number | null = null,
): MemoryAssistProjectStats {
  return {
    project,
    ...buildSegmentStats(decisions, taxonomyCorrectionCount, {
      scope: 'project',
      key: project,
      project,
    }, observationCount),
  };
}

function buildProjectSourceStats(
  project: string,
  source: MemoryAssistSourceStats['source'],
  decisions: MemoryAssistDecisionRecord[],
  taxonomyCorrectionCount: number | null,
): MemoryAssistProjectSourceStats {
  return {
    project,
    source,
    ...buildSegmentStats(decisions, taxonomyCorrectionCount, {
      scope: 'project_source',
      key: `${project}::${source}`,
      project,
      source,
    }),
  };
}

interface ImplicitSignalCountRow {
  signal_kind: string;
  cnt: number;
}

function computeImplicitUseCounts(
  db: Database,
  windowEpoch: number
): {
  file_reuse: number;
  content_cited: number;
  no_overlap: number;
  not_yet_computed: number;
  implicitUseRate: number | null;
} {
  // Count distinct decisions in window that have each signal kind
  const rows = db.prepare(`
    SELECT s.signal_kind, COUNT(DISTINCT s.decision_id) as cnt
    FROM memory_implicit_signals s
    JOIN memory_assist_decisions d ON d.id = s.decision_id
    WHERE d.status = 'injected' AND d.created_at_epoch >= ?
    GROUP BY s.signal_kind
  `).all(windowEpoch) as ImplicitSignalCountRow[];

  const signalMap: Record<string, number> = {};
  for (const row of rows) {
    signalMap[row.signal_kind] = row.cnt;
  }

  // Total injected decisions in window
  const totalInjectedRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM memory_assist_decisions
    WHERE status = 'injected' AND created_at_epoch >= ?
  `).get(windowEpoch) as { cnt: number };
  const totalInjected = totalInjectedRow.cnt;

  // Distinct injected decisions that have ANY signal row
  const computedRow = db.prepare(`
    SELECT COUNT(DISTINCT d.id) as cnt
    FROM memory_assist_decisions d
    JOIN memory_implicit_signals s ON s.decision_id = d.id
    WHERE d.status = 'injected' AND d.created_at_epoch >= ?
  `).get(windowEpoch) as { cnt: number };
  const computedCount = computedRow.cnt;

  const file_reuse = signalMap['file_reuse'] ?? 0;
  const content_cited = signalMap['content_cited'] ?? 0;
  const no_overlap = signalMap['no_overlap'] ?? 0;
  const not_yet_computed = Math.max(0, totalInjected - computedCount);

  const usedCount = file_reuse + content_cited;

  return {
    file_reuse,
    content_cited,
    no_overlap,
    not_yet_computed,
    implicitUseRate: roundPercent(usedCount, computedCount),
  };
}

export function getMemoryAssistDashboard(
  db: Database,
  decisions: MemoryAssistDecisionRecord[],
  windowDays = 30
): MemoryAssistDashboard & ObservationFeedbackStats {
  const promptDecisions = decisions.filter((decision) => decision.source === 'semantic_prompt');
  const summaryDecisions = decisions.filter((decision) => decision.source === 'semantic_summary');
  const fileDecisions = decisions.filter((decision) => decision.source === 'file_context');
  const injected = decisions.filter((decision) => decision.status === 'injected').length;
  const checkedNoInject = decisions.filter((decision) => decision.status === 'skipped').length;
  const actionable = injected + checkedNoInject;
  const likelyHelped = decisions.filter((decision) => decision.systemVerdict === 'likely_helped').length;
  const feedback = getObservationFeedbackStats(db, windowDays);
  const taxonomyCorrections = getObservationTypeCorrectionStats(db, windowDays);
  const userConfirmedHelpful = decisions.filter((decision) => decision.userFeedback === 'helpful').length;
  const userConfirmedNotHelpful = decisions.filter((decision) => decision.userFeedback === 'not_helpful').length;
  const windowEpoch = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const globalObservationCount = countObservationsInWindow(db, windowDays);
  const implicitStats = computeImplicitUseCounts(db, windowEpoch);
  const globalSegment = buildSegmentStats(decisions, taxonomyCorrections.total, {
    scope: 'global',
    key: 'global',
  }, globalObservationCount);

  const availableProjects = [...new Set(
    decisions
      .map((decision) => decision.project)
      .filter((project): project is string => typeof project === 'string' && project.length > 0)
  )].sort((left, right) => left.localeCompare(right));

  const projectStats = Object.fromEntries(
    availableProjects.map((project) => {
      const projectDecisions = decisions.filter((decision) => decision.project === project);
      const projectCorrections = getObservationTypeCorrectionStats(db, windowDays, { project });
      const projectObservationCount = countObservationsInWindow(db, windowDays, project);
      return [project, buildProjectStats(project, projectDecisions, projectCorrections.total, projectObservationCount)];
    })
  ) as Record<string, MemoryAssistProjectStats>;

  const projectSourceEntries = availableProjects.flatMap((project) => {
    return (['semantic_prompt', 'semantic_summary', 'file_context'] as const).map((source) => {
      const scopedDecisions = decisions.filter(
        (decision) => decision.project === project && decision.source === source
      );
      const key = `${project}::${source}`;
      return [key, buildProjectSourceStats(project, source, scopedDecisions, null)] as const;
    });
  });

  const sourceStats = {
    semantic_prompt: buildSourceStats('semantic_prompt', promptDecisions, null),
    semantic_summary: buildSourceStats('semantic_summary', summaryDecisions, null),
    file_context: buildSourceStats('file_context', fileDecisions, null),
  } satisfies Record<'semantic_prompt' | 'semantic_summary' | 'file_context', MemoryAssistSourceStats>;

  // Last-hour snapshot — exposes bimodal workload the 30d aggregate hides.
  // Decline perception often comes from looking at a static aggregate without
  // seeing that recent hours are trending up or down. Rendered as a subtitle
  // badge in the UI next to each main rate.
  const recentCutoff = Date.now() - 60 * 60 * 1000;
  const recentDecisions = decisions.filter((d) => d.createdAtEpoch >= recentCutoff);
  const recentInjected = recentDecisions.filter((d) => d.status === 'injected').length;
  const recentSkipped = recentDecisions.filter((d) => d.status === 'skipped').length;
  const recentActionable = recentInjected + recentSkipped;
  const recentLikelyHelped = recentDecisions.filter((d) => d.systemVerdict === 'likely_helped').length;
  const recentTrend = {
    sinceEpoch: recentCutoff,
    totalDecisions: recentDecisions.length,
    injectRate: roundPercent(recentInjected, recentActionable),
    likelyHelpedRate: roundPercent(recentLikelyHelped, recentActionable),
    injected: recentInjected,
    actionable: recentActionable,
  };

  const dashboard = {
    windowDays,
    totalDecisions: decisions.length,
    injected,
    injectRate: roundPercent(injected, actionable),
    likelyHelped,
    likelyHelpedRate: roundPercent(likelyHelped, actionable),
    recentTrend,
    userConfirmedHelpfulRate: roundPercent(userConfirmedHelpful, userConfirmedHelpful + userConfirmedNotHelpful),
    estimatedInjectedTokens: globalSegment.estimatedInjectedTokens,
    helpfulRecallsPer1kInjectedTokens: globalSegment.helpfulRecallsPer1kInjectedTokens,
    injectedTokensPerLikelyHelpedRecall: globalSegment.injectedTokensPerLikelyHelpedRecall,
    taxonomyCorrectionRate: globalSegment.taxonomyCorrectionRate,
    // `helped` / `helpRate` represent the judge-evaluated outcome — how often
    // an injection actually helped, not how often we injected. Previously
    // `helped: injected` and `helpRate: injected/actionable` duplicated the
    // inject rate under a helpfulness label, making the dashboard mathematically
    // incoherent (the UI showed 7% "helpful" but the math was 7% injection).
    // Now helped counts decisions where the judge flagged likely_helped, and
    // the rate is computed per injected decision (the set where help could
    // have happened at all).
    helped: likelyHelped,
    checkedNoHelp: Math.max(injected - likelyHelped, 0),
    helpRate: roundPercent(likelyHelped, injected),
    feedback,
    helpful: feedback.helpful,
    notHelpful: feedback.notHelpful,
    bySource: feedback.bySource,
    sourceStats,
    projectStats,
    projectSourceStats: Object.fromEntries(projectSourceEntries) as Record<string, MemoryAssistProjectSourceStats>,
    availableProjects,
    taxonomyCorrections,
    shadowRanking: buildShadowRankingStats(promptDecisions),
    recommendation: globalSegment.recommendation,
    implicitUseRate: implicitStats.implicitUseRate,
    implicitUseCounts: {
      file_reuse: implicitStats.file_reuse,
      content_cited: implicitStats.content_cited,
      no_overlap: implicitStats.no_overlap,
      not_yet_computed: implicitStats.not_yet_computed,
    },
  };
  logger.debug('DB', `memory-assist-dashboard: built for ${windowDays}d window using ${decisions.length} decisions across ${availableProjects.length} projects`);
  return dashboard;
}
