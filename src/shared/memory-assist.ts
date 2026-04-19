export type MemoryAssistSource = 'semantic_prompt' | 'file_context' | 'session_start';

export type MemoryAssistStatus = 'injected' | 'skipped' | 'disabled' | 'error';

export type MemoryAssistFeedbackLabel = 'helpful' | 'not_helpful';

export type MemoryAssistSystemVerdict =
  | 'likely_helped'
  | 'unclear'
  | 'likely_not_helped';

export type MemoryAssistOutcomeSignalType = 'tool_use';

export type MemoryAssistToolAction =
  | 'read'
  | 'write'
  | 'edit'
  | 'command'
  | 'browser'
  | 'search'
  | 'other';

export interface MemoryAssistJudgedOutcome {
  outcomeId?: number;
  pendingMessageId?: number | null;
  action: MemoryAssistToolAction;
  toolName: string;
  filePath?: string | null;
  timestamp?: number;
  matchedPaths?: string[];
  matchedTraceObservationIds?: number[];
  generatedObservationIds?: number[];
  conceptOverlapCount?: number;
  sequenceRole?: 'follow_up_read' | 'follow_up_edit' | 'terminal_follow_up' | 'browser_follow_up' | 'other_follow_up';
  signalSource?: 'exact_observation_link' | 'sequence_only' | 'file_overlap' | 'browser_only' | 'no_overlap';
  evidenceStrength?: 'primary' | 'supporting' | 'context';
  reason: string;
}

export interface MemoryAssistSystemEvidence {
  matchedTracePaths: string[];
  usedOutcomes: MemoryAssistJudgedOutcome[];
  ignoredOutcomes: MemoryAssistJudgedOutcome[];
}

export interface MemoryAssistTraceItem {
  observationId: number;
  title?: string | null;
  type?: string | null;
  createdAtEpoch?: number;
  distance?: number | null;
  filePath?: string | null;
  relatedFilePaths?: string[];
  concepts?: string[];
  score?: number;
}

export interface MemoryAssistEvent {
  id?: number;
  source: MemoryAssistSource;
  status: MemoryAssistStatus;
  reason: string;
  timestamp: number;
  promptNumber?: number;
  project?: string;
  platformSource?: string;
  sessionDbId?: number;
  contentSessionId?: string;
  candidateCount?: number;
  selectedCount?: number;
  threshold?: number;
  bestDistance?: number | null;
  worstDistance?: number | null;
  promptLength?: number;
  filePath?: string;
  message?: string;
  estimatedInjectedTokens?: number;
  traceItems?: MemoryAssistTraceItem[];
  shadowRanking?: MemoryAssistShadowRanking | null;
  systemVerdict?: MemoryAssistSystemVerdict | null;
  systemConfidence?: number | null;
  systemReasons?: string[];
  systemEvidence?: MemoryAssistSystemEvidence | null;
  userFeedback?: MemoryAssistFeedbackLabel | null;
}

export interface MemoryAssistReport extends Omit<MemoryAssistEvent, 'timestamp'> {
  timestamp?: number;
}

export interface MemoryAssistRankedCandidate {
  observationId: number;
  distance: number | null;
  score: number;
  title?: string | null;
  type?: string | null;
  createdAtEpoch?: number;
  relatedFilePaths?: string[];
  concepts?: string[];
}

export interface MemoryAssistShadowRanking {
  productionRankerId: string;
  experimentalRankerId?: string;
  productionCandidates: MemoryAssistRankedCandidate[];
  experimentalCandidates?: MemoryAssistRankedCandidate[];
  productionSelectedObservationIds: number[];
  experimentalSelectedObservationIds?: number[];
}

export interface MemoryAssistDecision extends MemoryAssistEvent {
  id: number;
  platformSource?: string;
  sessionDbId?: number;
  contentSessionId?: string;
  shadowRanking?: MemoryAssistShadowRanking | null;
}

export interface MemoryAssistOutcomeSignal {
  id?: number;
  decisionId?: number | null;
  pendingMessageId?: number | null;
  source?: MemoryAssistSource;
  promptNumber?: number;
  contentSessionId?: string;
  sessionDbId?: number;
  project?: string;
  platformSource?: string;
  signalType: MemoryAssistOutcomeSignalType;
  toolName: string;
  action: MemoryAssistToolAction;
  filePath?: string | null;
  relatedFilePaths?: string[];
  concepts?: string[];
  generatedObservationIds?: number[];
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface MemoryAssistDecisionRecord extends MemoryAssistDecision {
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface MemoryAssistSourceStats {
  source: Exclude<MemoryAssistSource, 'session_start'>;
  total: number;
  actionable: number;
  injected: number;
  injectRate: number | null;
  likelyHelped: number;
  likelyHelpedRate: number | null;
  userConfirmedHelpful: number;
  userConfirmedHelpfulRate: number | null;
  helped: number;
  checkedNoHelp: number;
  disabled: number;
  errors: number;
  helpRate: number | null;
  topSkipReasons: Array<{ reason: string; count: number }>;
  verdicts: Record<MemoryAssistSystemVerdict, number>;
  estimatedInjectedTokens: number;
  helpfulRecallsPer1kInjectedTokens: number | null;
  injectedTokensPerLikelyHelpedRecall: number | null;
  taxonomyCorrectionCount: number | null;
  taxonomyCorrectionRate: number | null;
  shadowRanking: MemoryAssistShadowRankingStats | null;
}

export interface MemoryAssistShadowRankingStats {
  totalCompared: number;
  exactMatches: number;
  exactMatchRate: number | null;
  divergentSelections: number;
  avgSelectionOverlapRate: number | null;
  likelyHelpedWithExperimentalOverlap: number;
  likelyHelpedWithExperimentalOverlapRate: number | null;
}

export type MemoryAssistCalibrationRecommendationKind =
  | 'raise_threshold'
  | 'lower_threshold'
  | 'keep_threshold'
  | 'insufficient_data'
  | 'paused';

export interface MemoryAssistRecommendationSlice {
  scope: 'global' | 'source' | 'project' | 'project_source';
  key: string;
  project?: string;
  source?: Exclude<MemoryAssistSource, 'session_start'>;
}

/**
 * Paused recommendation — emitted when the recommender is gated off pending a
 * validated content-reuse signal (Probe B). Carries no numeric prescription.
 * See `src/services/sqlite/memory-assist/recommender-gate.ts` for the gate.
 */
export interface MemoryAssistCalibrationPausedRecommendation {
  kind: 'paused';
  reason: string;
  slice: MemoryAssistRecommendationSlice;
}

export interface MemoryAssistCalibrationActiveRecommendation {
  kind: Exclude<MemoryAssistCalibrationRecommendationKind, 'paused'>;
  reason: string;
  confidence: number;
  suggestedDelta: number | null;
  actionable: number;
  slice: MemoryAssistRecommendationSlice;
}

export type MemoryAssistCalibrationRecommendation =
  | MemoryAssistCalibrationActiveRecommendation
  | MemoryAssistCalibrationPausedRecommendation;

export interface MemoryAssistSegmentStats {
  total: number;
  actionable: number;
  injected: number;
  injectRate: number | null;
  likelyHelped: number;
  likelyHelpedRate: number | null;
  userConfirmedHelpful: number;
  userConfirmedHelpfulRate: number | null;
  helped: number;
  checkedNoHelp: number;
  disabled: number;
  errors: number;
  helpRate: number | null;
  topSkipReasons: Array<{ reason: string; count: number }>;
  verdicts: Record<MemoryAssistSystemVerdict, number>;
  estimatedInjectedTokens: number;
  helpfulRecallsPer1kInjectedTokens: number | null;
  injectedTokensPerLikelyHelpedRecall: number | null;
  taxonomyCorrectionCount: number | null;
  taxonomyCorrectionRate: number | null;
  shadowRanking: MemoryAssistShadowRankingStats | null;
  recommendation: MemoryAssistCalibrationRecommendation;
}

export interface MemoryAssistProjectStats extends MemoryAssistSegmentStats {
  project: string;
}

export interface MemoryAssistProjectSourceStats extends MemoryAssistSegmentStats {
  project: string;
  source: Exclude<MemoryAssistSource, 'session_start'>;
}

export interface MemoryAssistFeedbackStats {
  windowDays: number;
  helpful: number;
  notHelpful: number;
  bySource: Record<string, { helpful: number; notHelpful: number }>;
}

export interface MemoryAssistDashboard {
  windowDays: number;
  totalDecisions: number;
  injected: number;
  injectRate: number | null;
  likelyHelped: number;
  likelyHelpedRate: number | null;
  userConfirmedHelpfulRate: number | null;
  estimatedInjectedTokens: number;
  helpfulRecallsPer1kInjectedTokens: number | null;
  injectedTokensPerLikelyHelpedRecall: number | null;
  taxonomyCorrectionRate: number | null;
  helped: number;
  checkedNoHelp: number;
  helpRate: number | null;
  feedback: MemoryAssistFeedbackStats;
  sourceStats: Record<Exclude<MemoryAssistSource, 'session_start'>, MemoryAssistSourceStats>;
  projectStats: Record<string, MemoryAssistProjectStats>;
  projectSourceStats: Record<string, MemoryAssistProjectSourceStats>;
  availableProjects: string[];
  taxonomyCorrections: {
    total: number;
    aliases: Array<{ originalType: string; normalizedType: string; count: number }>;
  };
  shadowRanking: MemoryAssistShadowRankingStats | null;
  recommendation: MemoryAssistCalibrationRecommendation;
}

export interface MemoryAssistCalibrationRecord {
  id: number;
  project: string | null;
  source: MemoryAssistSource | null;
  semanticThreshold: number | null;
  injectLimit: number | null;
  minQueryLength: number | null;
  rankerId: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface MemoryAssistCalibrationSnapshot {
  global: MemoryAssistCalibrationRecord | null;
  byProject: Record<string, MemoryAssistCalibrationRecord>;
  bySource: Record<string, MemoryAssistCalibrationRecord>;
  byProjectAndSource: Record<string, MemoryAssistCalibrationRecord>;
}

export interface MemoryAssistOutcomeSummary {
  latestSignalAt?: number;
  signalCount: number;
  actions: Record<MemoryAssistToolAction, number>;
}
