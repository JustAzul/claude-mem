import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt, redactSecrets } from '../../src/sdk/prompts.js';

const baseObs = {
  id: 1,
  tool_name: 'exec_command',
  tool_input: JSON.stringify({ cmd: 'pwd' }),
  tool_output: JSON.stringify({ output: '/repo' }),
  created_at_epoch: Date.now(),
  cwd: '/repo',
};

describe('buildObservationPrompt', () => {
  it('instructs the observer to avoid prose skip responses', () => {
    const prompt = buildObservationPrompt(baseObs);

    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks, or an empty response');
    expect(prompt).toContain('Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection');
    expect(prompt).toContain('Never reply with prose such as "Skipping", "No substantive tool executions"');
  });

  it('renders "(not available)" placeholders when no turnContext is passed', () => {
    const prompt = buildObservationPrompt(baseObs);

    expect(prompt).toContain('<user_request>(not available)</user_request>');
    expect(prompt).toContain('<prior_assistant_message>(not available)</prior_assistant_message>');
  });

  it('renders "(not available)" when turnContext fields are null', () => {
    const prompt = buildObservationPrompt(baseObs, {
      userRequest: null,
      priorAssistantMessage: null,
    });

    expect(prompt).toContain('<user_request>(not available)</user_request>');
    expect(prompt).toContain('<prior_assistant_message>(not available)</prior_assistant_message>');
  });

  it('threads user intent and prior assistant message into the prompt', () => {
    const prompt = buildObservationPrompt(baseObs, {
      userRequest: 'fix the migration bug in SessionStore',
      priorAssistantMessage: 'Investigating SessionStore now.',
    });

    expect(prompt).toContain('<user_request>fix the migration bug in SessionStore</user_request>');
    expect(prompt).toContain('<prior_assistant_message>Investigating SessionStore now.</prior_assistant_message>');
  });

  it('truncates user_request at 500 chars and prior_assistant_message at 300 chars', () => {
    const longUser = 'a'.repeat(900);
    const longPrior = 'b'.repeat(500);
    const prompt = buildObservationPrompt(baseObs, {
      userRequest: longUser,
      priorAssistantMessage: longPrior,
    });

    expect(prompt).toContain('a'.repeat(500) + '…(truncated)');
    expect(prompt).not.toContain('a'.repeat(501));
    expect(prompt).toContain('b'.repeat(300) + '…(truncated)');
    expect(prompt).not.toContain('b'.repeat(301));
  });

  it('escapes XML metacharacters in turn context fields', () => {
    const prompt = buildObservationPrompt(baseObs, {
      userRequest: 'run <script>alert(1)</script> & check',
      priorAssistantMessage: '<b>bold</b>',
    });

    expect(prompt).toContain('<user_request>run &lt;script&gt;alert(1)&lt;/script&gt; &amp; check</user_request>');
    expect(prompt).toContain('<prior_assistant_message>&lt;b&gt;bold&lt;/b&gt;</prior_assistant_message>');
    // Raw (unescaped) values must not appear inside the rendered fields
    expect(prompt).not.toContain('<script>alert(1)</script>');
  });

  it('treats empty strings the same as null (renders placeholder)', () => {
    const prompt = buildObservationPrompt(baseObs, {
      userRequest: '',
      priorAssistantMessage: '',
    });

    expect(prompt).toContain('<user_request>(not available)</user_request>');
    expect(prompt).toContain('<prior_assistant_message>(not available)</prior_assistant_message>');
  });

  it('redacts known secret patterns from turn context before sending to LLM', () => {
    const prompt = buildObservationPrompt(baseObs, {
      userRequest: 'deploy with ANTHROPIC_API_KEY=sk-ant-api03-abcdef123456789012345abc and token sk-proj-AbCdEf0123456789xyz',
      priorAssistantMessage: 'Got it, running ghp_1234567890abcdefghijklmnop1234567890AB now',
    });

    expect(prompt).not.toContain('sk-ant-api03-abcdef123456789012345abc');
    expect(prompt).not.toContain('sk-proj-AbCdEf0123456789xyz');
    expect(prompt).not.toContain('ghp_1234567890abcdefghijklmnop1234567890AB');
    expect(prompt).toContain('[REDACTED]');
  });
});

describe('redactSecrets', () => {
  it('redacts Anthropic, OpenAI, GitHub, AWS, JWT, and Bearer tokens', () => {
    expect(redactSecrets('key=sk-ant-api03-abcdef123456789012345xyz')).not.toContain('abcdef');
    expect(redactSecrets('sk-proj-AbCdEfGhIjKlMnOpQrStUv')).toContain('[REDACTED]');
    expect(redactSecrets('token ghp_1234567890abcdefghijklmnop1234567890AB done')).toContain('[REDACTED]');
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP is the key')).toContain('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toContain('[REDACTED]');
    expect(redactSecrets('eyJabcdefghij.klmnopqrst.uvwxyz01234')).toContain('[REDACTED]');
  });

  it('preserves the key name in named_secret patterns for readable context', () => {
    const redacted = redactSecrets('password=SuperSecret123 and api_key: deadbeefcafe1234');
    expect(redacted).toContain('password=[REDACTED]');
    expect(redacted).toContain('api_key:[REDACTED]');
  });

  it('does not mangle ordinary text that merely mentions secrets conceptually', () => {
    const text = 'We need to rotate the password tomorrow and double-check the API key policy.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('handles multiple secrets in one string', () => {
    const out = redactSecrets('export OPENAI=sk-proj-1234567890abcdef1234 && export GH=ghp_1234567890abcdefghijklmnop1234567890AB');
    expect(out.match(/\[REDACTED\]/g)?.length).toBe(2);
  });
});
