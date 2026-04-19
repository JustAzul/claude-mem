import React, { useEffect, useState } from 'react';

interface ObservationTraceModalProps {
  observationId: number;
  onClose: () => void;
}

interface TraceData {
  observation: Record<string, unknown>;
  source: { origin: Record<string, unknown>; pendingMessage: Record<string, unknown> | null } | null;
  turn: {
    contentSessionId: string | null;
    userPrompt: { prompt_text: string; created_at_epoch: number } | null;
    priorAssistantMessage: string | null;
    siblings: Array<{ id: number; type: string; title: string; created_at_epoch: number }>;
  } | null;
  memoryAssist: {
    injectedIn: Array<Record<string, unknown>>;
    generatedBy: Array<Record<string, unknown>>;
  };
}

export function ObservationTraceModal({ observationId, onClose }: ObservationTraceModalProps) {
  const [data, setData] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/observations/${observationId}/trace`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((d: any) => { if (!cancelled) setData(d as TraceData); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'fetch failed'); });
    return () => { cancelled = true; };
  }, [observationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e as any).key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="trace-modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        overflow: 'auto',
        padding: '40px 16px',
      }}
    >
      <div
        className="trace-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-card)',
          color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border-primary)',
          borderRadius: 10,
          padding: 24,
          width: '100%',
          maxWidth: 960,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        {/* Close + header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Trace — observation #{observationId}</h2>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 18 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {error && (
          <div style={{ color: 'var(--color-accent-warning)', padding: 16 }}>
            Failed to load trace: {error}
          </div>
        )}
        {!data && !error && <div style={{ padding: 16 }}>Loading…</div>}
        {data && (
          <>
            {/* Section 1: observation */}
            <Section title="1. Observation">
              <KV k="id" v={String(data.observation.id)} />
              <KV k="type" v={String(data.observation.type)} />
              <KV k="title" v={String(data.observation.title ?? '')} />
              <KV k="subtitle" v={String(data.observation.subtitle ?? '(none)')} />
              <KV k="narrative" v={String(data.observation.narrative ?? '(none)')} />
              <KV k="why" v={String(data.observation.why ?? '(none)')} />
              <KV k="alternatives_rejected" v={String(data.observation.alternatives_rejected ?? '(none)')} />
              <KV k="related_observation_ids" v={String(data.observation.related_observation_ids ?? '(none)')} />
              <KV k="concepts" v={String(data.observation.concepts ?? '[]')} />
              <KV k="files_read" v={String(data.observation.files_read ?? '[]')} />
              <KV k="files_modified" v={String(data.observation.files_modified ?? '[]')} />
            </Section>

            {/* Section 2: source */}
            <Section title="2. Source tool call">
              {!data.source ? (
                <Empty note="No origin link found (orphan observation — see ORPHAN_OBSERVATIONS warning in worker log)." />
              ) : (
                <SourceToolCallDetail
                  origin={data.source.origin}
                  pendingMessage={data.source.pendingMessage}
                />
              )}
            </Section>

            {/* Section 3: turn */}
            <Section title="3. Turn context">
              {!data.turn ? (
                <Empty note="Turn context unavailable (no memory_session_id or prompt_number on this observation)." />
              ) : (
                <>
                  <KV k="content_session_id" v={String(data.turn.contentSessionId ?? '(unknown)')} />
                  <KV k="user_prompt" v={data.turn.userPrompt ? String(data.turn.userPrompt.prompt_text) : '(not available — user_prompts pruning)'} />
                  {data.turn.priorAssistantMessage && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600, marginBottom: 4 }}>
                        prior_assistant_message
                      </div>
                      <div
                        title={data.turn.priorAssistantMessage}
                        style={{
                          fontSize: 12,
                          color: 'var(--color-text-secondary)',
                          fontStyle: 'italic',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          cursor: 'help',
                        }}
                      >
                        {data.turn.priorAssistantMessage.length > 300
                          ? data.turn.priorAssistantMessage.slice(0, 300) + '…'
                          : data.turn.priorAssistantMessage}
                      </div>
                    </div>
                  )}
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {data.turn.siblings.length === 0
                      ? 'No siblings in this turn.'
                      : `${data.turn.siblings.length} sibling observation(s) in this turn:`}
                  </div>
                  <ul style={{ marginTop: 4, fontSize: 12 }}>
                    {data.turn.siblings.map((s) => (
                      <li key={s.id}>#{s.id} [{s.type}] {s.title}</li>
                    ))}
                  </ul>
                </>
              )}
            </Section>

            {/* Section 4: memory-assist refs */}
            <Section title="4. Memory-assist references">
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                Injected in {data.memoryAssist.injectedIn.length} decision(s); generated by {data.memoryAssist.generatedBy.length} outcome signal(s).
              </div>
              {data.memoryAssist.injectedIn.length > 0 && (
                <div style={{ fontSize: 12, marginBottom: 12 }}>
                  <strong>Injected in:</strong>
                  <ul>
                    {data.memoryAssist.injectedIn.map((d: any) => (
                      <li key={d.id}>#{d.id} [{d.source}/{d.status}] verdict={d.system_verdict} file={d.file_path}</li>
                    ))}
                  </ul>
                </div>
              )}
              {data.memoryAssist.generatedBy.length > 0 && (
                <div style={{ fontSize: 12 }}>
                  <strong>Generated by:</strong>
                  <ul>
                    {data.memoryAssist.generatedBy.map((o: any) => (
                      <li key={o.id}>decision #{o.decision_id} • {o.tool_name}/{o.action} on {o.file_path}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>

            {/* Raw JSON — collapsible */}
            <div style={{ marginTop: 16 }}>
              <button
                onClick={() => setShowRaw((s) => !s)}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  border: '1px solid var(--color-border-primary)',
                  background: 'var(--color-bg-card-hover)',
                  color: 'var(--color-text-secondary)',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
              </button>
              {showRaw && (
                <pre
                  style={{
                    marginTop: 12,
                    fontSize: 11,
                    padding: 12,
                    background: 'var(--color-bg-terminal)',
                    color: 'var(--color-text-primary)',
                    borderRadius: 6,
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {JSON.stringify(data, null, 2)}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--color-border-primary)' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--color-text-secondary)' }}>{title}</h3>
      {children}
    </section>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, fontSize: 12, marginBottom: 4 }}>
      <span style={{ color: 'var(--color-text-muted)', fontFamily: mono ? 'var(--font-mono)' : 'inherit' }}>{k}</span>
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: mono ? 'var(--font-mono)' : 'inherit' }}>{v}</span>
    </div>
  );
}

function Empty({ note }: { note: string }) {
  return <div style={{ fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>{note}</div>;
}

function safeJSON(value: unknown): string {
  if (value == null) return '(none)';
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

function formatEpoch(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '(unknown)';
  const ms = value < 1e12 ? value * 1000 : value;
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(value);
  }
}

function SourceToolCallDetail({
  origin,
  pendingMessage,
}: {
  origin: Record<string, unknown>;
  pendingMessage: Record<string, unknown> | null;
}) {
  const o = origin as Record<string, unknown>;
  const pm = pendingMessage as Record<string, unknown> | null;

  return (
    <>
      {/* Origin metadata — always present when data.source exists */}
      <KV k="tool_name" v={String(o.tool_name ?? '(unknown)')} />
      <KV k="action" v={String(o.action ?? '(unknown)')} />
      <KV k="file_path" v={String(o.file_path ?? '(none)')} />
      <KV k="pending_message_id" v={String(o.pending_message_id ?? '(none)')} />
      {o.prompt_number != null && <KV k="prompt_number" v={String(o.prompt_number)} />}

      {/* Pending-message payload — may be pruned on older observations */}
      {!pm ? (
        <div style={{ marginTop: 8 }}>
          <Empty note="Source tool call payload was pruned. Retention is aggressive; only the last few days are kept." />
        </div>
      ) : (
        <>
          <KV k="cwd" v={String(pm.cwd ?? '(none)')} />
          {pm.prompt_number != null && <KV k="pending.prompt_number" v={String(pm.prompt_number)} />}
          {pm.content_session_id != null && <KV k="content_session_id" v={String(pm.content_session_id)} />}
          {pm.message_type != null && <KV k="message_type" v={String(pm.message_type)} />}
          {pm.status != null && <KV k="status" v={String(pm.status)} />}
          {pm.created_at_epoch != null && (
            <KV k="created_at" v={formatEpoch(pm.created_at_epoch)} />
          )}

          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600 }}>
            tool_input
          </div>
          <CodeBlock content={safeJSON(pm.tool_input)} />

          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600 }}>
            tool_response
          </div>
          <CodeBlock content={safeJSON(pm.tool_response)} />

          {pm.last_assistant_message != null && String(pm.last_assistant_message).length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 600 }}>
                last_assistant_message
              </div>
              <CodeBlock content={String(pm.last_assistant_message)} />
            </>
          )}
        </>
      )}
    </>
  );
}

function CodeBlock({ content }: { content: string }) {
  return (
    <pre
      style={{
        marginTop: 4,
        fontSize: 11,
        padding: 10,
        background: 'var(--color-bg-terminal)',
        color: 'var(--color-text-primary)',
        borderRadius: 6,
        maxHeight: 260,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {content}
    </pre>
  );
}
