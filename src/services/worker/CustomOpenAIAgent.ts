/**
 * CustomOpenAIAgent: OpenAI-compatible observation extraction
 *
 * Generic agent for any OpenAI-compatible `/chat/completions` backend
 * (e.g. self-hosted LLM gateway, LiteLLM, vLLM, Ollama, LM Studio).
 *
 * Config (settings file or centralized ~/.claude-mem/.env):
 *   CLAUDE_MEM_CUSTOM_BASE_URL  e.g. https://example.com/v1
 *   CLAUDE_MEM_CUSTOM_API_KEY   Bearer token (required)
 *   CLAUDE_MEM_CUSTOM_MODEL     model ID passed through to the backend
 *
 * Env fallbacks via getCredential(): CUSTOM_OPENAI_API_KEY, CUSTOM_OPENAI_BASE_URL, CUSTOM_OPENAI_MODEL
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type ToolContext,
  type WorkerRef
} from './agents/index.js';
import { toSnapshotString, type CaptureSnapshotSource } from '../sqlite/observations/capture-snapshot.js';

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string | number };
}

export class CustomOpenAIAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const { apiKey, baseUrl, model } = this.getConfig();

      if (!apiKey) {
        throw new Error('Custom provider API key not configured. Set CLAUDE_MEM_CUSTOM_API_KEY in settings or CUSTOM_OPENAI_API_KEY in ~/.claude-mem/.env.');
      }
      if (!baseUrl) {
        throw new Error('Custom provider base URL not configured. Set CLAUDE_MEM_CUSTOM_BASE_URL (e.g. https://example.com/v1).');
      }
      if (!model) {
        throw new Error('Custom provider model not configured. Set CLAUDE_MEM_CUSTOM_MODEL.');
      }

      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `custom-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=CustomOpenAI`);
      }

      const mode = ModeManager.getInstance().getActiveMode();

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.query(session.conversationHistory, apiKey, baseUrl, model);

      if (initResponse.content) {
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'CustomOpenAI',
          undefined,
          model
        );
      } else {
        logger.error('SDK', 'Empty custom provider init response', {
          sessionId: session.sessionDbId,
          model
        });
      }

      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);

        if (message.cwd) lastCwd = message.cwd;
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }
          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured.');
          }

          // Pass turn context (userRequest + priorAssistantMessage) for cross-provider
          // contract parity with SDKAgent/OpenRouterAgent. A paired ablation POC on
          // gpt-5.4-mini (scripts/poc-observation-context-ablation.mjs, run_id
          // ctx-abl-1776688705960, n=20) found these fields neutral on this provider
          // (fidelity Δ=-0.018, intent_fit Δ=+0.005, +6% prompt tokens) — kept anyway
          // because the gain is real on the Claude SDK path and dropping them would
          // diverge the per-provider contract. Re-run the POC before removing.
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          }, {
            userRequest: session.userPrompt ?? null,
            priorAssistantMessage: message.last_assistant_message ?? null,
          });

          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.query(session.conversationHistory, apiKey, baseUrl, model);

          let tokensUsed = 0;
          if (obsResponse.content) {
            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          const toolContext: ToolContext = {
            tool_name: message.tool_name!,
            tool_input: message.tool_input,
          };
          const captureSource: CaptureSnapshotSource = {
            memorySessionId: session.memorySessionId,
            contentSessionId: session.contentSessionId,
            promptNumber: session.lastPromptNumber,
            userPrompt: session.userPrompt ?? null,
            priorAssistantMessage: message.last_assistant_message ?? null,
            toolName: message.tool_name ?? null,
            toolInput: toSnapshotString(message.tool_input),
            toolOutput: toSnapshotString(message.tool_response),
            cwd: message.cwd ?? null,
          };
          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'CustomOpenAI',
            lastCwd,
            model,
            toolContext,
            captureSource
          );

        } else if (message.type === 'summarize') {
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured.');
          }

          // Use a minimal prompt that avoids observer-agent framing.
          // buildSummaryPrompt uses "memory agent / observer" phrasing shared with observation
          // turns, which conditions gpt-class models to emit <observation> instead of <summary>.
          const lastMsg = (message.last_assistant_message || '')
            // Strip XML tags that could prime the model to emit observation-format output
            .replace(/<\/?observation[^>]*>/gi, '')
            .replace(/<\/?type[^>]*>/gi, '')
            .trim();
          const minimalSummaryPrompt = `Create a progress checkpoint summary for this coding session.

Project: ${session.project}
User request: ${session.userPrompt || '(not available)'}

Last AI response in the primary session:
${lastMsg.slice(0, 2000)}${lastMsg.length > 2000 ? '…(truncated)' : ''}

Respond with ONLY this XML block — no other text, no <observation> tags:
<summary>
  <request>[Short title: what the user asked for and what was done]</request>
  <investigated>[What was explored or examined so far]</investigated>
  <learned>[What was discovered about how things work]</learned>
  <completed>[What work has been completed or shipped]</completed>
  <next_steps>[What is actively being worked on or planned next]</next_steps>
  <notes>[Additional insights about current progress]</notes>
</summary>`;

          const summaryHistory: ConversationMessage[] = [
            { role: 'system', content: 'You are a concise progress note-taker. Output ONLY a single <summary>...</summary> XML block. Never output <observation> tags.' },
            { role: 'user', content: minimalSummaryPrompt }
          ];
          const summaryResponse = await this.query(summaryHistory, apiKey, baseUrl, model);
          const summaryContent = summaryResponse.content || '';

          let tokensUsed = 0;
          if (summaryResponse.content) {
            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            summaryContent,
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'CustomOpenAI',
            lastCwd,
            model
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;

      let safeBaseUrl = baseUrl;
      try {
        const u = new URL(baseUrl);
        u.username = '';
        u.password = '';
        safeBaseUrl = u.toString();
      } catch { /* not a parseable URL — log as-is */ }

      logger.success('SDK', 'Custom OpenAI agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model,
        baseUrl: safeBaseUrl
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Custom OpenAI agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Custom provider failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error)
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Custom OpenAI agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_CUSTOM_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) return history;
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);
      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Custom provider context truncated', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }
      truncated.unshift(msg);
      tokenCount += msgTokens;
    }
    return truncated;
  }

  private conversationToMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  private async query(
    history: ConversationMessage[],
    apiKey: string,
    baseUrl: string,
    model: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncated = this.truncateHistory(history);
    const messages = this.conversationToMessages(truncated);
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const payload: Record<string, unknown> = { model, messages };

    // Both temperature and max_tokens are opt-in; some OpenAI-compatible backends reject them.
    const tempRaw = settings.CLAUDE_MEM_CUSTOM_TEMPERATURE;
    if (tempRaw && tempRaw.trim() !== '') {
      const t = Number(tempRaw);
      if (Number.isFinite(t)) payload.temperature = t;
    }

    const maxOutRaw = settings.CLAUDE_MEM_CUSTOM_MAX_OUTPUT_TOKENS;
    if (maxOutRaw && maxOutRaw.trim() !== '') {
      const mt = parseInt(maxOutRaw, 10);
      if (Number.isFinite(mt) && mt > 0) payload.max_tokens = mt;
    }

    logger.debug('SDK', `Querying custom provider (${model})`, {
      url,
      turns: truncated.length,
      estimatedTokens: this.estimateTokens(truncated.map(m => m.content).join(''))
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 200);
      throw new Error(`Custom provider API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenAIChatResponse;
    if (data.error) {
      throw new Error(`Custom provider API error: ${data.error.code} - ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.error('SDK', 'Empty response from custom provider', { url, model });
      return { content: '' };
    }

    const tokensUsed = data.usage?.total_tokens;
    if (tokensUsed) {
      logger.info('SDK', 'Custom provider usage', {
        model,
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        totalTokens: tokensUsed,
        messagesInContext: truncated.length
      });
    }

    return { content, tokensUsed };
  }

  private getConfig(): { apiKey: string; baseUrl: string; model: string } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const apiKey = settings.CLAUDE_MEM_CUSTOM_API_KEY || getCredential('CUSTOM_OPENAI_API_KEY') || '';
    const baseUrl = settings.CLAUDE_MEM_CUSTOM_BASE_URL || getCredential('CUSTOM_OPENAI_BASE_URL') || '';
    const model = settings.CLAUDE_MEM_CUSTOM_MODEL || getCredential('CUSTOM_OPENAI_MODEL') || '';
    return { apiKey, baseUrl, model };
  }
}

export function isCustomOpenAIAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const apiKey = settings.CLAUDE_MEM_CUSTOM_API_KEY || getCredential('CUSTOM_OPENAI_API_KEY');
  const baseUrl = settings.CLAUDE_MEM_CUSTOM_BASE_URL || getCredential('CUSTOM_OPENAI_BASE_URL');
  const model = settings.CLAUDE_MEM_CUSTOM_MODEL || getCredential('CUSTOM_OPENAI_MODEL');
  return !!(apiKey && baseUrl && model);
}

export function isCustomOpenAISelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'custom';
}
