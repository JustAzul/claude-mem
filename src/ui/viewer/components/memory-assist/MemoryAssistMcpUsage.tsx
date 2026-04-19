import React, { useEffect, useState } from 'react';

interface ByToolEntry {
  tool_name: string;
  count: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
  error_count: number;
  last_invoked_at: number;
}

interface UsageData {
  window: { since: number; until: number };
  byTool: ByToolEntry[];
  hourlyBuckets: { hour_epoch: number; count: number }[];
}

interface InvocationEntry {
  id: number;
  tool_name: string;
  args_summary: Record<string, unknown> | null;
  result_status: string;
  error_message: string | null;
  duration_ms: number;
  invoked_at_epoch: number;
}

interface RecentData {
  invocations: InvocationEntry[];
}

function relativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function MemoryAssistMcpUsage(): React.ReactElement {
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [recentData, setRecentData] = useState<RecentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [usageRes, recentRes] = await Promise.all([
          fetch(`/api/mcp/usage?since=${since}`),
          fetch('/api/mcp/usage/recent?limit=50'),
        ]);
        if (!usageRes.ok || !recentRes.ok) throw new Error('Failed to fetch MCP usage data');
        const [usage, recent] = await Promise.all([usageRes.json(), recentRes.json()]);
        if (!cancelled) {
          setUsageData(usage as UsageData);
          setRecentData(recent as RecentData);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div style={{ padding: '16px', color: 'var(--color-text-muted)', fontSize: 13 }}>
        Loading MCP usage…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '16px', color: 'var(--color-error, #e55)', fontSize: 13 }}>
        Error: {error}
      </div>
    );
  }

  const byTool = usageData?.byTool ?? [];
  const invocations = recentData?.invocations ?? [];

  if (byTool.length === 0 && invocations.length === 0) {
    return (
      <div style={{ padding: '16px', color: 'var(--color-text-muted)', fontSize: 13 }}>
        No MCP invocations yet
      </div>
    );
  }

  const thStyle: React.CSSProperties = {
    textAlign: 'left',
    padding: '6px 10px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    borderBottom: '1px solid var(--color-border-primary)',
    whiteSpace: 'nowrap',
  };

  const tdStyle: React.CSSProperties = {
    padding: '6px 10px',
    fontSize: 12,
    color: 'var(--color-text-primary)',
    borderBottom: '1px solid var(--color-border-primary)',
    verticalAlign: 'top',
  };

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {byTool.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Last 30 days — by tool
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Tool</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Count</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Avg ms</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>p95 ms</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Errors</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Last invoked</th>
                </tr>
              </thead>
              <tbody>
                {byTool.map(row => (
                  <tr key={row.tool_name}>
                    <td style={tdStyle}>
                      <code style={{ fontSize: 11, background: 'var(--color-bg-card-hover)', padding: '2px 5px', borderRadius: 4 }}>
                        {row.tool_name}
                      </code>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{row.count}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{row.avg_duration_ms}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{row.p95_duration_ms}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: row.error_count > 0 ? 'var(--color-error, #e55)' : 'inherit' }}>
                      {row.error_count}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--color-text-muted)' }}>
                      {relativeTime(row.last_invoked_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {invocations.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Recent invocations
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto', display: 'grid', gap: 6 }}>
            {invocations.map(inv => (
              <div
                key={inv.id}
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border-primary)',
                  background: 'var(--color-bg-card)',
                  display: 'grid',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    {relativeTime(inv.invoked_at_epoch)}
                  </span>
                  <code style={{ fontSize: 11, background: 'var(--color-bg-card-hover)', padding: '2px 5px', borderRadius: 4 }}>
                    {inv.tool_name}
                  </code>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 6px',
                      borderRadius: 999,
                      background: inv.result_status === 'ok' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      color: inv.result_status === 'ok' ? '#22c55e' : '#ef4444',
                    }}
                  >
                    {inv.result_status}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                    {inv.duration_ms}ms
                  </span>
                </div>
                {inv.args_summary && (
                  <pre style={{
                    margin: 0,
                    fontSize: 10,
                    color: 'var(--color-text-secondary)',
                    background: 'var(--color-bg-card-hover)',
                    padding: '4px 8px',
                    borderRadius: 4,
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    <code>{JSON.stringify(inv.args_summary, null, 2)}</code>
                  </pre>
                )}
                {inv.error_message && (
                  <div style={{ fontSize: 11, color: 'var(--color-error, #e55)' }}>
                    {inv.error_message}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
