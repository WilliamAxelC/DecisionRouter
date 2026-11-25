export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DecisionRouter — Telemetry & Routing Trace</title>
  <style>
    :root {
      --bg: #0b0f17;
      --panel: #121826;
      --border: #1e293b;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --good: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 12px;
    }
    h1 { margin: 0; font-size: 1.35rem; font-weight: 650; }
    .sub { color: var(--muted); font-size: 0.85rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .card .label { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .card .value { font-size: 1.45rem; font-weight: 700; margin-top: 4px; }
    .card .hint { font-size: 0.78rem; color: var(--muted); margin-top: 2px; }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 20px;
    }
    @media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
    h2 { font-size: 0.95rem; margin: 0 0 10px; color: var(--accent); }
    table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    .badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 600;
      border: 1px solid var(--border);
      background: #0f172a;
    }
    .tier-self { color: #34d399; border-color: #065f46; }
    .tier-trivial { color: #94a3b8; }
    .tier-standard { color: var(--accent); }
    .tier-complex { color: var(--warn); }
    .tier-frontier { color: #c084fc; }
    .tier-specialist { color: var(--good); }
    .flag-sticky { color: var(--good); border-color: #065f46; }
    .flag-esc { color: var(--warn); border-color: #78350f; }
    .flag-fail { color: var(--bad); border-color: #7f1d1d; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
    button {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 0.82rem;
    }
    button:hover { border-color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>DecisionRouter</h1>
      <div class="sub">Per-request Gemini free-tier model router &amp; cross-protocol proxy</div>
    </div>
    <div>
      <span class="sub" id="updatedAt">Loading...</span>
      <button onclick="refreshAll()">Refresh</button>
    </div>
  </header>

  <section class="grid" id="kpis"></section>

  <section class="split">
    <div class="card">
      <h2>Gemini Free-Tier Decision Quota &amp; Breakers</h2>
      <div id="statusArea" class="mono">Loading...</div>
    </div>
    <div class="card">
      <h2>Model &amp; Tier Breakdown (24h)</h2>
      <div id="breakdownArea">Loading...</div>
    </div>
  </section>

  <section class="card">
    <h2>Recent Routing Decisions</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Proto / Req</th>
            <th>Tier</th>
            <th>Selected Model</th>
            <th>Source &amp; Flags</th>
            <th>Latency</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody id="recentBody"></tbody>
      </table>
    </div>
  </section>

  <script>
    function esc(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[c]);
    }
    function fmtUsd(v) {
      if (!v) return '$0.0000';
      return v < 0.01 ? '$' + v.toFixed(5) : '$' + v.toFixed(4);
    }

    async function refreshAll() {
      try {
        const [stats, recent, status] = await Promise.all([
          fetch('/_router/api/stats?hours=24').then(r => r.json()),
          fetch('/_router/api/recent?limit=30').then(r => r.json()),
          fetch('/_router/api/status').then(r => r.json())
        ]);

        document.getElementById('kpis').innerHTML = [
          { label: 'Requests (24h)', value: stats.totalRequests, hint: 'avg ' + stats.avgTotalMs.toFixed(0) + 'ms total' },
          { label: 'Est. Spend', value: fmtUsd(stats.totalCostUsd), hint: 'baseline ' + fmtUsd(stats.baselineCostUsd) },
          { label: 'Est. Savings', value: stats.savingsPct.toFixed(1) + '%', hint: fmtUsd(stats.savingsUsd) + ' saved' },
          { label: 'Avg Decision', value: stats.avgDecisionMs.toFixed(1) + 'ms', hint: 'classifier + heuristics' },
          { label: 'Cache-Sticky', value: stats.cacheStickyCount, hint: 'mid-loop prefix kept' },
          { label: 'Self-Handled', value: stats.selfHandledCount || 0, hint: '0 upstream hops' },
          { label: 'Escalations', value: stats.escalatedCount, hint: stats.failoverCount + ' failovers' }
        ].map(k => '<div class="card"><div class="label">' + esc(k.label) + '</div><div class="value">' + esc(k.value) + '</div><div class="hint">' + esc(k.hint) + '</div></div>').join('');

        const quotaRows = (status.geminiQuota || []).map(q =>
          '<tr><td>' + esc(q.model) + ' (key #' + (q.keyIndex + 1) + ')</td>' +
          '<td>' + q.rpmUsed + '/' + q.rpmLimit + ' RPM</td>' +
          '<td>' + q.rpdUsed + '/' + q.rpdLimit + ' RPD</td>' +
          '<td>' + (q.cooldownUntilMs ? '<span class="badge flag-fail">cooldown</span>' : '<span class="badge flag-sticky">ready</span>') + '</td></tr>'
        ).join('');
        const breakerRows = (status.circuitBreakers || []).map(b =>
          '<div><span class="badge flag-fail">' + esc(b.key) + '</span> failures=' + b.failures + (b.lastError ? ' (' + esc(b.lastError.slice(0, 60)) + ')' : '') + '</div>'
        ).join('');
        document.getElementById('statusArea').innerHTML =
          '<table><thead><tr><th>Decision Model</th><th>RPM</th><th>RPD</th><th>State</th></tr></thead><tbody>' +
          (quotaRows || '<tr><td colspan="4">No Gemini keys configured (using heuristics)</td></tr>') +
          '</tbody></table>' +
          (breakerRows ? '<div style="margin-top:10px">' + breakerRows + '</div>' : '<div class="hint" style="margin-top:8px">All upstream circuit breakers healthy.</div>');

        const modelRows = (stats.byModel || []).map(m =>
          '<tr><td class="mono">' + esc(m.model) + '</td><td>' + m.count + '</td><td>' + fmtUsd(m.costUsd) + '</td><td>' + m.avgMs.toFixed(0) + 'ms</td></tr>'
        ).join('');
        document.getElementById('breakdownArea').innerHTML =
          '<table><thead><tr><th>Model</th><th>Reqs</th><th>Cost</th><th>Avg</th></tr></thead><tbody>' +
          (modelRows || '<tr><td colspan="4">No traffic recorded yet</td></tr>') +
          '</tbody></table>';

        document.getElementById('recentBody').innerHTML = (recent.items || []).map(r => {
          const flags = [
            '<span class="badge">' + esc(r.source) + '</span>',
            r.selfHandled ? '<span class="badge flag-sticky">self</span>' : '',
            r.cacheSticky ? '<span class="badge flag-sticky">sticky</span>' : '',
            r.escalated ? '<span class="badge flag-esc">escalated</span>' : '',
            r.failovers > 0 ? '<span class="badge flag-fail">failover:' + r.failovers + '</span>' : ''
          ].filter(Boolean).join(' ');
          const dt = new Date(r.createdAtMs).toLocaleTimeString();
          return '<tr>' +
            '<td class="mono">' + esc(dt) + '</td>' +
            '<td><span class="badge">' + esc(r.protocol) + '</span> <span class="mono">' + esc(r.requestedModel) + '</span></td>' +
            '<td><span class="badge tier-' + esc(r.tier) + '">' + esc(r.tier + (r.specialist ? ':' + r.specialist : '')) + '</span></td>' +
            '<td class="mono">' + esc(r.selectedProvider + '/' + r.selectedModel) + '</td>' +
            '<td>' + flags + '</td>' +
            '<td class="mono">' + r.decisionMs.toFixed(1) + 'ms / ' + r.totalMs.toFixed(0) + 'ms</td>' +
            '<td class="mono">' + r.inputTokens + '→' + r.outputTokens + (r.cachedInputTokens ? ' (' + r.cachedInputTokens + 'c)' : '') + '</td>' +
            '<td class="mono">' + fmtUsd(r.estimatedCostUsd) + '</td>' +
            '<td>' + esc(r.reason) + '</td>' +
          '</tr>';
        }).join('');

        document.getElementById('updatedAt').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        document.getElementById('updatedAt').textContent = 'Error: ' + e.message;
      }
    }

    refreshAll();
    setInterval(refreshAll, 5000);
  </script>
</body>
</html>`;
}
