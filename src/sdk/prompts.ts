/**
 * SDK Prompts Module
 * Generates prompts for the Claude Agent SDK memory worker
 */

import { logger } from '../utils/logger.js';
import type { ModeConfig } from '../services/domain/types.js';

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
}

export interface SDKSession {
  id: number;
  memory_session_id: string | null;
  project: string;
  user_prompt: string;
  last_assistant_message?: string;
}

/**
 * Build initial prompt to initialize the SDK agent
 */
export function buildInitPrompt(project: string, sessionId: string, userPrompt: string, mode: ModeConfig): string {
  return `${mode.prompts.system_identity}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <why>${mode.prompts.xml_why_placeholder}</why>
  <!--
    ${mode.prompts.why_guidance}
  -->
  <alternatives_rejected>${mode.prompts.xml_alternatives_placeholder}</alternatives_rejected>
  <!--
    ${mode.prompts.alternatives_guidance}
  -->
  <related>
    <id>${mode.prompts.xml_related_placeholder}</id>
  </related>
  <!--
    ${mode.prompts.related_guidance}
  -->
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
</observation>
\`\`\`
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_start}`;
}

export interface ObservationTurnContext {
  userRequest: string | null;
  priorAssistantMessage: string | null;
  priorObservations?: string[];  // compact timeline: ["HH:MM [type] title", ...]
}

function truncateWithSuffix(text: string, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + '…(truncated)';
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// High-confidence secret patterns. We only match things that cannot plausibly
// be normal prose — prefixes like "sk-ant-", "ghp_", "AKIA", and full JWTs. The
// goal is to prevent tokens/keys from reaching third-party LLM providers via
// the user_request/prior_assistant channels H1 opened, while keeping ordinary
// text unmangled. Over-redaction would hurt intent_fit gains from H1.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Authorization: Bearer <token> (case-insensitive header form)
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/gi },
  // key=value assignments where the key name signals a secret. Matches up to
  // the next whitespace, quote, or &/; separator (common in URLs/envs).
  { name: 'named_secret', re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?([^\s"'&;]{6,})/gi },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      // For key=value patterns, preserve the left side so context stays readable.
      const eqIdx = match.search(/[:=]/);
      if (eqIdx > -1 && /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)/i.test(match.slice(0, eqIdx))) {
        return match.slice(0, eqIdx + 1) + '[REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return out;
}

function renderTurnContextField(raw: string | null | undefined, max: number): string {
  if (raw == null || raw === '') return '(not available)';
  return escapeXml(truncateWithSuffix(redactSecrets(raw), max));
}

/**
 * Build prompt to send tool observation to SDK agent
 *
 * turnContext threads the per-turn user intent + prior assistant message into
 * every per-observation prompt. An audit (intent_fit 0.40, 80% ceiling) showed
 * the capture LLM couldn't align observations with user intent because it only
 * saw the tool call in isolation. Without turnContext, the fields render as
 * "(not available)" so legacy callers still work.
 */
export function buildObservationPrompt(obs: Observation, turnContext?: ObservationTurnContext): string {
  // Safely parse tool_input and tool_output - they're already JSON strings
  let toolInput: any;
  let toolOutput: any;

  try {
    toolInput = typeof obs.tool_input === 'string' ? JSON.parse(obs.tool_input) : obs.tool_input;
  } catch (error) {
    logger.debug('SDK', 'Tool input is plain string, using as-is', {
      toolName: obs.tool_name
    }, error as Error);
    toolInput = obs.tool_input;
  }

  try {
    toolOutput = typeof obs.tool_output === 'string' ? JSON.parse(obs.tool_output) : obs.tool_output;
  } catch (error) {
    logger.debug('SDK', 'Tool output is plain string, using as-is', {
      toolName: obs.tool_name
    }, error as Error);
    toolOutput = obs.tool_output;
  }

  const userRequestBlock = renderTurnContextField(turnContext?.userRequest, 500);
  const priorAssistantBlock = renderTurnContextField(turnContext?.priorAssistantMessage, 300);

  const base = `<observed_from_primary_session>
  <user_request>${userRequestBlock}</user_request>
  <prior_assistant_message>${priorAssistantBlock}</prior_assistant_message>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>
</observed_from_primary_session>

Return either one or more <observation>...</observation> blocks, or an empty response if this tool use should be skipped.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.
Never reply with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Non-XML text is discarded.`;

  if (turnContext?.priorObservations?.length) {
    return base + `\n\nPRIOR_OBSERVATIONS_ON_SAME_FILES (chronological, what was done to these files before this action):\n` +
      turnContext.priorObservations.join('\n');
  }
  return base;
}

/**
 * Build prompt to generate progress summary
 */
export function buildSummaryPrompt(session: SDKSession, mode: ModeConfig): string {
  const lastAssistantMessage = session.last_assistant_message || (() => {
    logger.error('SDK', 'Missing last_assistant_message in session for summary prompt', {
      sessionId: session.id
    });
    return '';
  })();

  return `--- MODE SWITCH: PROGRESS SUMMARY ---

${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

${mode.prompts.summary_context_label}
${lastAssistantMessage}

${mode.prompts.summary_format_instruction}
<summary>
  <request>${mode.prompts.xml_summary_request_placeholder}</request>
  <investigated>${mode.prompts.xml_summary_investigated_placeholder}</investigated>
  <learned>${mode.prompts.xml_summary_learned_placeholder}</learned>
  <completed>${mode.prompts.xml_summary_completed_placeholder}</completed>
  <next_steps>${mode.prompts.xml_summary_next_steps_placeholder}</next_steps>
  <notes>${mode.prompts.xml_summary_notes_placeholder}</notes>
</summary>

${mode.prompts.summary_footer}

CRITICAL FORMAT RULE: Your output must contain ONLY the <summary>...</summary> block above. Do NOT use <observation> tags — this is a summary turn, not an observation turn. Any <observation> tag in your output will cause this entire summary to be silently discarded by the system.`;
}

/**
 * Build prompt for continuation of existing session
 *
 * CRITICAL: Why contentSessionId Parameter is Required
 * ====================================================
 * This function receives contentSessionId from SDKAgent.ts, which comes from:
 * - SessionManager.initializeSession (fetched from database)
 * - SessionStore.createSDKSession (stored by new-hook.ts)
 * - new-hook.ts receives it from Claude Code's hook context
 *
 * The contentSessionId is the SAME session_id used by:
 * - NEW hook (to create/fetch session)
 * - SAVE hook (to store observations)
 * - This continuation prompt (to maintain session context)
 *
 * This is how everything stays connected - ONE session_id threading through
 * all hooks and prompts in the same conversation.
 *
 * Called when: promptNumber > 1 (see SDKAgent.ts line 150)
 * First prompt: Uses buildInitPrompt instead (promptNumber === 1)
 */
export function buildContinuationPrompt(userPrompt: string, promptNumber: number, contentSessionId: string, mode: ModeConfig): string {
  return `${mode.prompts.continuation_greeting}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.system_identity}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.continuation_instruction}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <why>${mode.prompts.xml_why_placeholder}</why>
  <!--
    ${mode.prompts.why_guidance}
  -->
  <alternatives_rejected>${mode.prompts.xml_alternatives_placeholder}</alternatives_rejected>
  <!--
    ${mode.prompts.alternatives_guidance}
  -->
  <related>
    <id>${mode.prompts.xml_related_placeholder}</id>
  </related>
  <!--
    ${mode.prompts.related_guidance}
  -->
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
</observation>
\`\`\`
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_continued}`;
} 
