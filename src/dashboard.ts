/**
 * Dashboard HTML — monospace dark-mode agent registry.
 * Passkey auth on a monospace dark-mode agent registry — peak infrastructure.
 */

// Persona rows get Restart / Run-as / credential status (2026-09-02). Same markup on the server
// render and the SSE re-render; the JS binds by data-* attributes.
const PERSONA_PRESETS = [["claude-code", "claude-fable-5-1", "Claude Fable 5.1"], ["grok", "grok-4.6", "Grok 4.6"], ["codex", "gpt-5.6-sol", "Codex Sol"]];
function personaControls(id: string): string {
  const opts = PERSONA_PRESETS.map(([h, m, label]) => `<option value="${h} ${m}">${label}</option>`).join("");
  return `<span class="persona-status" data-pstatus="${id}" title="harness · credential">…</span>` +
    `<button data-restart="${id}" title="Quit the persona screen; launchd relaunches it on its current harness (refused if the credential is dead)">restart</button>` +
    `<select data-runas="${id}" title="Switch harness/model and restart"><option value="">run as…</option>${opts}</select>`;
}

export function renderDashboard(agents: any[], operatorName: string): string {
  const agentRows = agents.map((a: any) => {
    const status = a.online ? "●" : "○";
    const statusColor = a.online ? "#4ade80" : "#6b7280";
    const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "never";
    const typeBadge = a.permanent
      ? '<span class="badge badge-personai">personai</span>'
      : '<span class="badge badge-ephemeral">ephemeral</span>';
    const pubkeyShort = a.pubkey ? a.pubkey.slice(0, 8) + "…" : "—";
    return `
      <tr class="agent-row">
        <td><span style="color:${statusColor}">${status}</span></td>
        <td class="agent-name copyable" onclick="copy('${esc(a.id)}',this)" title="Click to copy id">${esc(a.display_name)}</td>
        <td class="badge-cell">${typeBadge}</td>
        <td class="dim copyable" onclick="copy('${esc(a.pubkey)}',this)" title="Click to copy full key">${pubkeyShort}</td>
        <td class="dim">${a.sessions}</td>
        <td class="dim">${lastSeen}</td>
        <td class="agent-actions">
          <button data-peek="${esc(a.id)}" title="Read agent's screen output">peek</button>
          <button data-msg="${esc(a.id)}" title="Send IPC message to agent">msg</button>
          <a class="row-btn" href="${esc(attachHref(a))}" title="Attach this agent's screen in a new iTerm2 tab">📺 attach</a>
          ${a.permanent ? personaControls(a.id) : ""}
        </td>
      </tr>
      <tr><td colspan="7" class="agent-plan" data-plan-for="${esc(a.id)}">${a.plan ? esc(a.plan) : ""}</td></tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${process.env.WIRE_INSTANCE_NAME ?? "The Wire"}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230a0a0a'/><path d='M18 4L10 18h5l-2 10 10-14h-5z' fill='%23fbbf24'/></svg>">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 13px;
      line-height: 1.6;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid #262626;
      padding-bottom: 12px;
      margin-bottom: 24px;
    }
    h1 { font-size: 16px; font-weight: 600; color: #fafafa; }
    h1 span { color: #6b7280; font-weight: 400; }
    .operator { color: #6b7280; font-size: 12px; }
    .operator a { color: #6b7280; text-decoration: none; }
    .operator a:hover { color: #e5e5e5; }
    h2 {
      font-size: 13px;
      font-weight: 600;
      color: #a1a1aa;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    th {
      text-align: left;
      color: #6b7280;
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid #1f1f1f;
    }
    td {
      padding: 8px 12px 8px 0;
      border-bottom: 1px solid #141414;
      vertical-align: top;
    }
    .agent-row { cursor: pointer; }
    .agent-row:hover { background: #111; }
    .agent-name { color: #60a5fa; font-weight: 500; white-space: nowrap; }
    .badge { font-size: 0.7em; padding: 1px 5px; border-radius: 3px; font-weight: 400; vertical-align: middle; }
    .badge-personai { background: #1e3a5f; color: #60a5fa; }
    .badge-ephemeral { background: #3f3f00; color: #facc15; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    col.col-status { width: 24px; }
    col.col-name { width: 130px; }
    col.col-type { width: 80px; }
    col.col-key { width: 100px; }
    col.col-sessions { width: 70px; }
    col.col-seen { }
    col.col-actions { width: 220px; }
    .badge-cell { white-space: nowrap; }
    td, th { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    th { color: #525252; font-weight: 400; font-size: 11px; text-align: left; }
    .agent-plan {
      padding: 2px 0 8px 28px;
      color: #a1a1aa;
      line-height: 1.5;
    }
    .agent-plan:empty { display: none; }
    .agent-plan h1, .agent-plan h2, .agent-plan h3 { color: #e5e5e5; margin: 8px 0 4px; font-size: 0.9em; }
    .agent-plan h1 { font-size: 1em; }
    .agent-plan p { margin: 2px 0; }
    .agent-plan a { color: #60a5fa; text-decoration: none; }
    .agent-plan a:hover { text-decoration: underline; }
    .agent-plan code { background: #1a1a2e; color: #c4b5fd; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    .agent-plan strong { color: #e5e5e5; }
    .agent-plan em { color: #d4d4d8; }
    .agent-plan del { color: #6b7280; }
    .agent-plan ul, .agent-plan ol { margin: 2px 0 2px 20px; }
    .agent-plan li { margin: 1px 0; }
    .agent-actions { white-space: nowrap; }
    .agent-actions button { padding: 2px 8px; font-size: 11px; background: #1a1a2e; color: #a1a1aa; border: 1px solid #333; border-radius: 3px; cursor: pointer; font-family: inherit; }
    .agent-actions button:hover { background: #2a2a3e; color: #e5e5e5; border-color: #555; }
    .agent-actions .row-btn { display: inline-block; padding: 2px 8px; font-size: 11px; background: #1a1a2e; color: #a1a1aa; border: 1px solid #333; border-radius: 3px; cursor: pointer; font-family: inherit; text-decoration: none; line-height: inherit; }
    .agent-actions .row-btn:hover { background: #2a2a3e; color: #e5e5e5; border-color: #555; }
    .peek-output { background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 12px; margin-top: 4px; white-space: pre-wrap; font-size: 11px; color: #a1a1aa; max-height: 70vh; overflow-y: auto; }
    .peek-output .peek-header { color: #fbbf24; margin-bottom: 8px; font-weight: bold; }
    .agent-plan table { border-collapse: collapse; margin: 4px 0; width: auto; }
    .agent-plan th, .agent-plan td { border: 1px solid #2a2a2a; padding: 3px 8px; text-align: left; white-space: normal; overflow: visible; }
    .agent-plan th { color: #e5e5e5; background: #1a1a1a; font-size: 0.9em; }
    .agent-plan td { color: #a1a1aa; }
    .dim { color: #525252; }
    .copyable { cursor: pointer; position: relative; }
    .copyable:hover { text-decoration: underline; }
    .copied { color: #4ade80 !important; }
    .copy-toast {
      position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
      background: #4ade80; color: #000; font-size: 10px; font-weight: 600;
      padding: 2px 6px; border-radius: 3px; pointer-events: none;
      animation: copy-fade 0.8s ease-out forwards;
    }
    @keyframes copy-fade {
      0% { opacity: 1; transform: translateX(-50%) translateY(0); }
      100% { opacity: 0; transform: translateX(-50%) translateY(-8px); }
    }
    .form-section {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #1f1f1f;
    }
    .form-row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      align-items: center;
    }
    .form-row input, .form-row select {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #e5e5e5;
      padding: 6px 10px;
      font-family: inherit;
      font-size: 12px;
      border-radius: 4px;
    }
    .form-row input:focus { outline: none; border-color: #60a5fa; }
    .form-row button {
      background: #262626;
      color: #e5e5e5;
      border: 1px solid #333;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .form-row button:hover { background: #333; }
    .form-row button.primary { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
    .form-row button.primary:hover { background: #d4d4d8; }
    .key-output {
      background: #111;
      border: 1px solid #262626;
      border-radius: 4px;
      padding: 12px;
      margin-top: 8px;
      display: none;
      font-size: 11px;
      word-break: break-all;
    }
    .key-output label { color: #6b7280; display: block; margin-bottom: 2px; }
    .key-output .key-val {
      color: #fbbf24;
      cursor: pointer;
      padding: 4px 0;
    }
    .key-output .key-val:hover { text-decoration: underline; }
    .key-output .warning { color: #f87171; font-size: 10px; margin-top: 8px; }
    #message-log {
      max-height: 400px;
      overflow-y: auto;
      background: #111;
      border: 1px solid #1f1f1f;
      border-radius: 4px;
      padding: 8px 12px;
      display: none;
    }
    #message-log:empty::after {
      content: 'Waiting for messages…';
      color: #3f3f46;
    }
    .msg-log-header {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .msg-log-header:hover h2 { color: #e5e5e5; }
    .msg-log-toggle { color: #525252; font-size: 11px; transition: transform 0.15s; }
    .msg-log-header.expanded .msg-log-toggle { transform: rotate(90deg); }
    .msg-log-header.expanded + #message-log { display: block; }
    .msg-log-count { color: #525252; font-size: 11px; font-weight: 400; }
    .msg-entry {
      padding: 3px 0;
      border-bottom: 1px solid #141414;
      cursor: pointer;
    }
    .msg-entry:last-child { border-bottom: none; }
    .msg-summary {
      display: flex;
      gap: 12px;
      align-items: baseline;
      overflow: hidden;
      white-space: nowrap;
    }
    .msg-ts { color: #525252; font-size: 11px; min-width: 140px; flex-shrink: 0; }
    .msg-seq { color: #6b7280; font-size: 11px; min-width: 40px; flex-shrink: 0; }
    .msg-source { color: #60a5fa; min-width: 80px; flex-shrink: 0; }
    .msg-arrow { color: #3f3f46; flex-shrink: 0; }
    .msg-dest { color: #a78bfa; min-width: 80px; flex-shrink: 0; }
    .msg-delivery { font-size: 11px; flex-shrink: 0; }
    .msg-delivery .uni { color: #4ade80; }
    .msg-delivery .broad { color: #4ade80; }
    .msg-delivery .fail { color: #f87171; }
    .msg-snippet { color: #3f3f46; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg-detail {
      display: none;
      margin: 4px 0 4px 92px;
      padding: 6px 8px;
      background: #0d0d0d;
      border: 1px solid #1a1a1a;
      border-radius: 3px;
      font-size: 11px;
      color: #a1a1aa;
      max-height: 300px;
      overflow-y: auto;
    }
    .msg-entry.expanded .msg-detail { display: block; }
    .json-tree { line-height: 1.5; }
    .json-key { color: #60a5fa; }
    .json-str { color: #4ade80; }
    .json-num { color: #fbbf24; }
    .json-bool { color: #f472b6; }
    .json-null { color: #6b7280; }
    .json-toggle {
      cursor: pointer;
      user-select: none;
      color: #525252;
      display: inline;
    }
    .json-toggle:hover { color: #a1a1aa; }
    .json-toggle::before { content: '▶ '; font-size: 9px; display: inline-block; transition: transform 0.1s; }
    .json-toggle.open::before { transform: rotate(90deg); }
    .json-children { display: none; padding-left: 16px; }
    .json-toggle.open + .json-children { display: block; }
    .json-bracket { color: #525252; }
    .json-comma { color: #525252; }
    .json-preview { color: #3f3f46; }
    /* token strip: one cell per harness pool; red = empty or credential dead, amber = >=80% */
    .usage-strip { display: flex; gap: 10px; margin: 0 0 16px 0; flex-wrap: wrap; }
    .usage-cell { border: 1px solid #333; border-radius: 4px; padding: 6px 10px; min-width: 170px; background: #111118; font-size: 12px; }
    .usage-cell .usage-label { color: #a1a1aa; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
    .usage-cell .usage-vals { color: #e5e5e5; }
    .usage-cell .usage-vals span { margin-right: 8px; white-space: nowrap; }
    .usage-cell .usage-note { color: #6b7280; font-size: 11px; margin-top: 2px; }
    .usage-cell.ok { border-color: #2f4f3a; }
    .usage-cell.amber { border-color: #b45309; background: #1f1706; }
    .usage-cell.amber .usage-label { color: #fbbf24; }
    .usage-cell.red { border-color: #dc2626; background: #2a0b0b; }
    .usage-cell.red .usage-label { color: #f87171; }
    .usage-cell.unknown { border-color: #3f3f46; }
    .usage-cell.unknown .usage-label { color: #71717a; }
    .usage-stale { color: #f59e0b; font-size: 11px; margin-left: 6px; }
    .persona-status { font-size: 11px; margin: 0 6px; color: #a1a1aa; }
    .persona-status .pst-ok { color: #4ade80; }
    .persona-status .pst-red { color: #f87171; font-weight: bold; }
    .agent-actions select { padding: 2px 4px; font-size: 11px; background: #1a1a2e; color: #a1a1aa; border: 1px solid #333; border-radius: 3px; font-family: inherit; }
    .stats {
      display: flex;
      gap: 32px;
      margin-bottom: 24px;
      color: #a1a1aa;
    }
    .stat-value { color: #fafafa; font-weight: 600; }
    /* Wallets panel */
    .wallets-empty { color: #525252; font-size: 12px; padding: 12px 0; }
    .wallet-row { border-bottom: 1px solid #141414; padding: 8px 0; }
    .wallet-row:last-child { border-bottom: none; }
    .wallet-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .wallet-name { font-weight: 600; color: #fafafa; }
    .wallet-addr { color: #6b7280; font-size: 11px; cursor: pointer; }
    .wallet-addr:hover { color: #a1a1aa; }
    .wallet-chain { color: #fbbf24; font-size: 11px; }
    .wallet-creator { color: #525252; font-size: 11px; }
    .wallet-mode-select {
      background: #1a1a1a;
      color: #e5e5e5;
      border: 1px solid #262626;
      border-radius: 3px;
      padding: 2px 6px;
      font-family: inherit;
      font-size: 11px;
    }
    .wallet-members { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; }
    .wallet-member-chip {
      background: #1a1a1a;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 2px 4px 2px 8px;
      font-size: 11px;
      color: #a1a1aa;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .wallet-member-revoke {
      cursor: pointer;
      color: #525252;
      padding: 0 4px;
      border-radius: 50%;
    }
    .wallet-member-revoke:hover { color: #f87171; background: #262626; }
    .wallet-grant {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }
    .wallet-grant input {
      width: 110px;
      font-size: 11px;
      padding: 1px 6px;
      background: #0d0d0d;
      border: 1px solid #262626;
      color: #e5e5e5;
      border-radius: 3px;
    }
    .wallet-grant button {
      font-size: 11px;
      padding: 1px 6px;
      background: #1a1a1a;
      border: 1px solid #262626;
      color: #a1a1aa;
      border-radius: 3px;
      cursor: pointer;
    }
    .wallet-grant button:hover { color: #4ade80; border-color: #4ade80; }
    .wallet-access-disabled { color: #3f3f46; font-style: italic; font-size: 11px; }
    footer {
      margin-top: 32px;
      padding-top: 12px;
      border-top: 1px solid #1f1f1f;
      color: #3f3f46;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <header>
    <h1>${process.env.WIRE_INSTANCE_NAME ? process.env.WIRE_INSTANCE_NAME + " - " : ""}The Wire <span>v0.3.0</span></h1>
    <div class="operator">${esc(operatorName)} · <a href="/auth/logout">logout</a></div>
  </header>

  <div class="stats">
    <div><span class="stat-value">${agents.length}</span> agents</div>
    <div><span class="stat-value">${agents.filter((a: any) => a.online).length}</span> online</div>
    <div><span class="stat-value">${agents.reduce((n: number, a: any) => n + a.sessions, 0)}</span> sessions</div>
  </div>

  <div id="usage-strip" class="usage-strip"><div class="usage-cell unknown"><div class="usage-label">tokens</div><div class="usage-vals">loading…</div></div></div>

  <h2>Agent Registry</h2>
  <table>
    <colgroup>
      <col class="col-status">
      <col class="col-name">
      <col class="col-type">
      <col class="col-key">
      <col class="col-sessions">
      <col class="col-seen">
      <col class="col-actions">
    </colgroup>
    <thead>
      <tr>
        <th></th>
        <th>Agent</th>
        <th>Type</th>
        <th>Key</th>
        <th>Sessions</th>
        <th>Seen</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${agentRows}
    </tbody>
  </table>
  <div id="peek-dock"></div>

  <div class="form-section">
    <h2>Wallets</h2>
    <div id="wallets-panel" class="wallets-empty">Loading…</div>
  </div>

  <div class="form-section">
    <div class="msg-log-header expanded" id="msg-log-header" onclick="this.classList.toggle('expanded')">
      <span class="msg-log-toggle">▶</span>
      <h2>Message Log</h2>
      <span class="msg-log-count" id="msg-log-count"></span>
    </div>
    <div id="message-log"></div>
  </div>


  <div class="form-section">
    <h2>Register Agent</h2>
    <div class="form-row">
      <input type="text" id="new-agent-id" placeholder="agent-id" style="width:120px">
      <input type="text" id="new-agent-name" placeholder="Display Name" style="width:160px">
      <input type="text" id="new-agent-pubkey" placeholder="Ed25519 pubkey (base64, optional)" style="flex:1">
      <button onclick="generateKeypair()" title="Generate Ed25519 keypair">keygen</button>
      <button class="primary" onclick="registerAgent()">Register</button>
    </div>
    <div id="key-output" class="key-output">
      <label>Public Key (will be registered):</label>
      <div class="key-val" id="gen-pubkey" onclick="copy(this.textContent)"></div>
      <label>Private Key (give to agent — shown once):</label>
      <div class="key-val" id="gen-privkey" onclick="copy(this.textContent)" style="color:#f87171"></div>
      <div class="warning">Copy the private key now. It cannot be recovered.</div>
    </div>
  </div>

  <footer>The Wire · agiterra · port ${process.env.WIRE_PORT ?? "9800"}</footer>

  <script>
    // --- Persona Restart / Run-as / credential status (POST /agents/:id/persona-action) ---
    const PERSONA_PRESETS_JS = [['claude-code','claude-fable-5-1','Claude Fable 5.1'],['grok','grok-4.6','Grok 4.6'],['codex','gpt-5.6-sol','Codex Sol']];
    function personaControlsJs(id) {
      const opts = PERSONA_PRESETS_JS.map(p => '<option value="' + p[0] + ' ' + p[1] + '">' + p[2] + '</option>').join('');
      const st = personaStatusCache[id] || '…';
      return '<span class="persona-status" data-pstatus="' + esc(id) + '" title="harness · credential">' + st + '</span>' +
        '<button data-restart="' + esc(id) + '" title="Quit the persona screen; launchd relaunches it on its current harness (refused if the credential is dead)">restart</button>' +
        '<select data-runas="' + esc(id) + '" title="Switch harness/model and restart"><option value="">run as…</option>' + opts + '</select>';
    }
    const personaStatusCache = {};
    function renderPersonaStatus(id, r) {
      let html;
      if (!r) html = '<span class="dim">pending…</span>';
      else if (r.action === 'check' && r.ok) {
        const live = r.cred && r.cred.live;
        html = '<span class="' + (live ? 'pst-ok' : 'pst-red') + '">' + esc(r.harness || '?') + ' ' + esc(r.model || '') + ' · cred ' + (live ? 'ok' : 'DEAD') + (r.cred && r.cred.expires_at ? ' (exp ' + esc(String(r.cred.expires_at).slice(11,16)) + 'Z)' : '') + '</span>';
      } else if (r.ok) html = '<span class="pst-ok">' + esc(r.action) + ' ok → screen ' + esc(r.screen_pid || '?') + ' ' + esc(r.harness || '') + ' ' + esc(r.model || '') + '</span>';
      else html = '<span class="pst-red">' + esc(r.action || '') + ' refused: ' + esc(r.reason || 'unknown') + '</span>';
      personaStatusCache[id] = html;
      document.querySelectorAll('[data-pstatus="' + id + '"]').forEach(el => { el.innerHTML = html; });
    }
    async function pollPersonaStatus(id, tries) {
      for (let i = 0; i < (tries || 30); i++) {
        try {
          const res = await fetch('/agents/' + encodeURIComponent(id) + '/persona-status');
          const j = await res.json();
          if (j.result) { renderPersonaStatus(id, j.result); return j.result; }
        } catch (e) { /* keep polling */ }
        await new Promise(r => setTimeout(r, 3000));
      }
      renderPersonaStatus(id, { ok: false, action: 'status', reason: 'no result within 90 s — is com.agiterra.persona-restart loaded?' });
      return null;
    }
    async function fleetAccount(slot) {
      if (!confirm('Switch EVERY Claude session to account slot "' + slot + '"? Creds are fanned to all personas and lanes; parked sessions get a resume poke.')) return;
      const el = document.querySelector('[data-pstatus="fleet"]'); if (el) el.textContent = 'switching → ' + slot + ' …';
      const res = await fetch('/agents/fleet/persona-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claude-account', slot }) });
      const jr = await res.json().catch(() => ({}));
      if (!res.ok || !jr.ok) { if (el) el.textContent = 'switch refused: ' + (jr.error || res.status); return; }
      pollPersonaStatus('fleet', 30);
      setTimeout(loadUsage, 8000);
    }
    async function personaAction(id, action, harness, model) {
      if (action === 'restart' && !confirm('Restart ' + id + ' now? The screen is quit and launchd relaunches it on its current harness. Refused automatically if the credential is dead.')) return;
      if (action === 'run-as' && !confirm('Switch ' + id + ' to ' + harness + ' ' + model + ' and restart it now?')) return;
      renderPersonaStatus(id, null);
      const res = await fetch('/agents/' + encodeURIComponent(id) + '/persona-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, harness, model }) });
      const j = await res.json();
      if (!j.ok) { renderPersonaStatus(id, { ok: false, action, reason: j.error || 'request refused' }); return; }
      const r = await pollPersonaStatus(id, action === 'check' ? 10 : 40);
      if (r && action !== 'check') {
        const dock = document.getElementById('peek-dock');
        if (dock) { const panel = document.createElement('div'); panel.className = 'peek-output'; panel.innerHTML = '<div class="peek-header">' + esc(id) + ' ' + esc(action) + '</div>' + esc(JSON.stringify(r, null, 2)); dock.prepend(panel); }
      }
    }
    function bindPersonaControls(root) {
      root.querySelectorAll('[data-restart]').forEach(el => { el.onclick = (e) => { e.stopPropagation(); personaAction(el.dataset.restart, 'restart'); }; });
      root.querySelectorAll('[data-runas]').forEach(el => { el.onchange = (e) => { e.stopPropagation(); const v = el.value; el.value = ''; if (!v) return; const [h, m] = v.split(' '); personaAction(el.dataset.runas, 'run-as', h, m); }; });
    }
    bindPersonaControls(document);
    document.querySelectorAll('[data-pstatus]').forEach(el => { const id = el.dataset.pstatus; if (!personaStatusCache[id]) personaAction(id, 'check'); });

    // --- Token strip (GET /usage, polled every 60s; never invents a number) ---
    function relTime(iso) {
      if (!iso) return '';
      const ms = new Date(iso).getTime() - Date.now();
      if (isNaN(ms)) return '';
      if (ms <= 0) return 'reset due';
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
      return h >= 24 ? 'resets in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : 'resets in ' + h + 'h ' + m + 'm';
    }
    function pctNum(v) { return (v === null || v === undefined || v === '') ? null : Number(v); }
    function stateFor(pcts, dead) {
      if (dead) return 'red';
      const known = pcts.filter(p => p !== null && !isNaN(p));
      if (!known.length) return 'unknown';
      const mx = Math.max.apply(null, known);
      return mx >= 95 ? 'red' : (mx >= 80 ? 'amber' : 'ok');
    }
    function usageCell(label, state, vals, note) {
      return '<div class="usage-cell ' + state + '"><div class="usage-label">' + esc(label) + '</div>' +
        '<div class="usage-vals">' + vals.map(v => '<span title="' + esc(v[2] || '') + '">' + esc(v[0]) + ' ' + esc(v[1]) + '</span>').join('') + '</div>' +
        (note ? '<div class="usage-note">' + esc(note) + '</div>' : '') + '</div>';
    }
    async function loadUsage() {
      const el = document.getElementById('usage-strip');
      if (!el) return;
      try {
        const res = await fetch('/usage');
        const j = await res.json();
        if (!j.ok) { el.innerHTML = usageCell('tokens', 'red', [['meter file', 'unreadable', '']], j.error || j.file); return; }
        const d = j.data || {};
        const ageMin = (Date.now() - new Date(d.as_of || j.file_mtime).getTime()) / 60000;
        const stale = isNaN(ageMin) ? '' : (ageMin > 30 ? ' <span class="usage-stale">stale ' + Math.round(ageMin) + 'm</span>' : '');
        const sd = d.seven_day || {}, fh = d.five_hour || {}, fw = d.fable_weekly || {};
        const cDead = d.claude_status && d.claude_status !== 'live';
        const cp = [pctNum(sd.used_percent), pctNum(fh.used_percent), pctNum(fw.used_percent)];
        const fmt = p => p === null ? '—' : p + '%';
        // One Claude cell per ACCOUNT SLOT (root's claude-account.sh publishes /tmp/claude-accounts.json;
        // Tim 2026-09-03: both accounts' stats, labeled, and a switch). Falls back to the single legacy cell.
        const acc = j.accounts && Array.isArray(j.accounts.slots) ? j.accounts : null;
        let claude = '';
        if (acc && acc.slots.length) {
          for (const sl of acc.slots) {
            const u = sl.usage || {}; const live = u.status === 'live';
            const p = [pctNum((u.session || {}).used_percent), pctNum((u.weekly || {}).used_percent), pctNum((u.fable || {}).used_percent)];
            const lbl = 'Claude · ' + sl.slot + (sl.active ? ' ✓' : '');
            claude += usageCell(lbl, live ? stateFor(p, false) : 'unknown',
              [['5h', fmt(p[0]), relTime((u.session || {}).resets_at)], ['7d', fmt(p[1]), relTime((u.weekly || {}).resets_at)], ['Fable', fmt(p[2]), relTime((u.fable || {}).resets_at)]],
              (sl.email || '') + (live ? ' · token ' + Math.round((sl.minutes_left || 0) / 60) + 'h left' : ' · ' + (u.status || 'no usage read')));
          }
          const btns = acc.slots.map(sl => '<button class="row-btn" style="' + (sl.active ? 'font-weight:bold;opacity:.6' : '') + '" ' + (sl.active ? 'disabled' : '') + ' onclick="fleetAccount(\'' + esc(sl.slot) + '\')">' + esc(sl.slot) + '</button>').join(' ');
          claude += '<div class="usage-cell unknown"><div class="usage-label">Claude account</div><div class="usage-vals">' + btns + '</div>' +
            '<div class="usage-note"><span class="persona-status" data-pstatus="fleet">switch fans creds to every session + pokes parked ones</span></div></div>';
        } else {
          claude = usageCell('Claude', stateFor(cp, cDead),
            [['7d', fmt(cp[0]), relTime(sd.resets_at)], ['5h', fmt(cp[1]), relTime(fh.resets_at)], ['Fable', fmt(cp[2]), relTime(fw.resets_at)]],
            cDead ? 'credential/probe: ' + d.claude_status : relTime(fh.resets_at));
        }
        const g = (d.grok || {}).weekly_page || {};
        const gp = pctNum(g.used_percent);
        const grok = usageCell('Grok', stateFor([gp], false), [['weekly', fmt(gp), relTime(g.resets_at)]],
          gp === null ? 'no live scrape — ' + relTime(g.resets_at) : relTime(g.resets_at));
        const x = ((d.codex || {}).primary) || {};
        const xp = pctNum(x.used_percent);
        const codex = usageCell('Codex', stateFor([xp], false), [['weekly', fmt(xp), relTime(x.resets_at)]], relTime(x.resets_at));
        const h = j.host || null;
        let hostCell = usageCell('Host', 'unknown', [['mem', '—', ''], ['swap', '—', ''], ['disk', '—', '']], 'no host meter');
        if (h && h.mem) {
          const swp = pctNum((h.swap || {}).used_pct), mf = pctNum((h.mem || {}).free_pct), dfree = (h.disk || {}).free_gb;
          const hstate = (swp !== null && swp >= 50) || (mf !== null && mf < 15) || (dfree !== undefined && dfree < 20) ? 'red' : ((swp !== null && swp >= 25) || (mf !== null && mf < 30) || (dfree !== undefined && dfree < 40) ? 'amber' : 'ok');
          hostCell = usageCell('Host', hstate,
            [['mem used', fmt(pctNum((h.mem || {}).used_pct)), (h.mem || {}).total_gb + ' GB'], ['swap', fmt(swp), ((h.swap || {}).used_mb || 0) + ' / ' + ((h.swap || {}).total_mb || 0) + ' MB'], ['disk free', (dfree === undefined ? '—' : dfree + ' GB'), ((h.disk || {}).used_pct || '') + '% used']],
            (h.flags && h.flags.length) ? h.flags[0] : 'as of ' + String(h.as_of || '').slice(11, 16) + 'Z');
        }
        const pl = j.pool || null;
        let poolCell = usageCell('USDC pool', 'unknown', [['USDC', '—', ''], ['ETH', '—', '']], 'no pool meter');
        if (pl && pl.status === 'live') {
          const low = (pl.usdc !== null && pl.usdc < pl.min_usdc) || (pl.eth !== null && pl.eth < pl.min_eth);
          poolCell = usageCell('USDC pool', low ? 'red' : 'ok',
            [['USDC', (pl.usdc === null ? '—' : Number(pl.usdc).toFixed(2)), 'min ' + pl.min_usdc], ['ETH', (pl.eth === null ? '—' : Number(pl.eth).toFixed(4)), 'min ' + pl.min_eth]],
            (pl.flags && pl.flags.length) ? pl.flags[0] : 'dev-wallet ' + String((pl.pool || {}).address || '').slice(0, 10) + '… as of ' + String(pl.as_of || '').slice(11, 16) + 'Z');
        } else if (pl) {
          poolCell = usageCell('USDC pool', 'red', [['pool', 'unreadable', '']], pl.error || pl.status);
        }
        el.innerHTML = claude + grok + codex + hostCell + poolCell + '<div class="usage-cell unknown"><div class="usage-label">as of</div><div class="usage-vals">' + esc((d.as_of || '').replace('T', ' ').slice(0, 16)) + 'Z' + stale + '</div></div>';
      } catch (e) {
        el.innerHTML = usageCell('tokens', 'red', [['/usage', 'failed', '']], String(e));
      }
    }
    loadUsage();
    setInterval(loadUsage, 60000);

    // --- Live SSE updates ---
    const evtSource = new EventSource('/dashboard/stream');
    evtSource.addEventListener('refresh', () => window.location.reload());
    evtSource.onmessage = (e) => {
      const agents = JSON.parse(e.data);

      // Update stats
      document.querySelector('.stats').innerHTML = [
        '<div><span class="stat-value">' + agents.length + '</span> agents</div>',
        '<div><span class="stat-value">' + agents.filter(a => a.online).length + '</span> online</div>',
        '<div><span class="stat-value">' + agents.reduce((n, a) => n + a.sessions, 0) + '</span> sessions</div>',
      ].join('');

      // Update table body — preserve expanded state
      const tbody = document.querySelector('tbody');
      tbody.innerHTML = agents.map(a => {
        const status = a.online ? '●' : '○';
        const statusColor = a.online ? '#4ade80' : '#6b7280';
        const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : 'never';
        const typeBadge = a.permanent
          ? '<span class="badge badge-personai">personai</span>'
          : '<span class="badge badge-ephemeral">ephemeral</span>';
        const pubkeyShort = a.pubkey ? a.pubkey.slice(0, 8) + '…' : '—';
        return '<tr class="agent-row" data-agent="' + esc(a.id) + '">' +
          '<td><span style="color:' + statusColor + '">' + status + '</span></td>' +
          '<td class="agent-name copyable" data-copy="' + esc(a.id) + '" title="Click to copy id">' + esc(a.display_name) + '</td>' +
          '<td class="badge-cell">' + typeBadge + '</td>' +
          '<td class="dim copyable" data-copy="' + esc(a.pubkey) + '" title="Click to copy full key">' + pubkeyShort + '</td>' +
          '<td class="dim">' + a.sessions + '</td>' +
          '<td class="dim">' + lastSeen + '</td>' +
          '<td class="agent-actions">' +
            '<button data-peek="' + esc(a.id) + '" title="Read agent screen output">peek</button>' +
            '<button data-msg="' + esc(a.id) + '" title="Send IPC message to agent">msg</button>' +
            '<a class="row-btn" href="' + esc(attachHref(a)) + '" title="Attach this agent\\'s screen in a new iTerm2 tab">📺 attach</a>' +
            (a.permanent ? personaControlsJs(a.id) : '') +
          '</td>' +
          '</tr>' +
          '<tr><td colspan="7" class="agent-plan" data-plan-for="' + esc(a.id) + '">' + renderPlan(a.plan || '') + '</td></tr>';
      }).join('');

      // Bind handlers
      tbody.querySelectorAll('[data-copy]').forEach(el => {
        el.onclick = (e) => { e.stopPropagation(); copy(el.dataset.copy, el); };
      });
      tbody.querySelectorAll('[data-peek]').forEach(el => {
        el.onclick = (e) => { e.stopPropagation(); peek(el.dataset.peek); };
      });
      tbody.querySelectorAll('[data-msg]').forEach(el => {
        el.onclick = (e) => { e.stopPropagation(); promptSend(el.dataset.msg); };
      });
      bindPersonaControls(tbody);
    };

    // --- Message log ---
    let msgCount = 0;
    function addMessageEntry(msg) {
      const log = document.getElementById('message-log');
      const d = new Date(msg.created_at);
      const ts = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString();
      const deliveries = msg.deliveries || [];
      const okCount = deliveries.filter(d => d.status === 'delivered').length;
      const failCount = deliveries.length - okCount;
      let deliveryBadges = '';
      if (msg.dest) {
        // Unicast — just show delivery status
        deliveryBadges = failCount > 0
          ? '<span class="fail">x</span>'
          : (okCount > 0 ? '<span class="uni">ok</span>' : '');
      } else {
        // Broadcast — show delivery count
        deliveryBadges = okCount > 0
          ? '<span class="broad">*' + okCount + '</span>'
          : '';
        if (failCount > 0) deliveryBadges += ' <span class="fail">x' + failCount + '</span>';
      }

      // Unwrap stringified JSON
      let parsed = msg.content;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch {}
      }
      // Single-line snippet for collapsed view
      const snippet = typeof parsed === 'string'
        ? parsed
        : JSON.stringify(parsed);
      const shortSnippet = snippet.length > 80 ? snippet.slice(0, 80) + '\u2026' : snippet;

      const entry = document.createElement('div');
      entry.className = 'msg-entry';
      entry.onclick = (ev) => {
        if (ev.target.closest('.msg-detail') || ev.target.closest('.json-toggle')) return;
        entry.classList.toggle('expanded');
      };

      const summary = document.createElement('div');
      summary.className = 'msg-summary';
      // Prefer human-readable text over raw stringified payload
      let displaySnippet = shortSnippet;
      if (parsed && typeof parsed === 'object') {
        const readable = parsed.text
          ?? parsed.detail
          ?? parsed.message
          ?? (parsed.type === 'wrap-up' ? 'Wrap-Up for ' + (parsed.ticket || '?') : null);
        if (typeof readable === 'string' && readable) {
          displaySnippet = readable.length > 80 ? readable.slice(0, 80) + '\u2026' : readable;
        }
      }

      summary.innerHTML =
        '<span class="msg-ts">' + ts + '</span>' +
        '<span class="msg-seq">#' + msg.seq + '</span>' +
        '<span class="msg-source">' + esc(msg.source || '') + '</span>' +
        '<span class="msg-arrow">\u2192</span>' +
        '<span class="msg-dest">' + esc(msg.dest || '*') + '</span>' +
        '<span class="msg-delivery">' + deliveryBadges + '</span>' +
        '<span class="msg-snippet">' + esc(displaySnippet) + '</span>';

      const detail = document.createElement('div');
      detail.className = 'msg-detail json-tree';
      detail.appendChild(renderJson(parsed, 0));

      entry.appendChild(summary);
      entry.appendChild(detail);

      log.prepend(entry);
      msgCount++;
      document.getElementById('msg-log-count').textContent = '(' + msgCount + ')';

      // Cap at 200 entries
      while (log.children.length > 200) { log.removeChild(log.lastChild); msgCount--; }
    }

    // SSE live messages
    evtSource.addEventListener('wire_message', (e) => {
      const msg = JSON.parse(e.data);
      addMessageEntry(msg);
      // Live-refresh the Wallets panel when plugin_settings.wallet-vault.wallets
      // changes (via operator edits here, or extension publishes elsewhere).
      let parsed = msg.content;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch {}
      }
      if (window.refreshWalletsIfRelevant) {
        window.refreshWalletsIfRelevant({ topic: msg.topic, payload: parsed });
      }
    });

    // Backfill recent messages via REST (API returns oldest-first)
    fetch('/messages/recent?limit=50').then(r => r.json()).then(messages => {
      // Iterate oldest-first so each prepend pushes older entries down
      for (const msg of messages) addMessageEntry(msg);
    }).catch(() => {});

    function esc(s) {
      return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') : '';
    }

    // Mirror of the server-side attachHref() — see dashboard.ts. Keep in sync.
    function attachHref(a) {
      return 'wire-attach://attach?' + new URLSearchParams({
        agent: a.id,
        host: a.ssh_host || 'local',
        user: a.run_as_uid || '',
        screen: a.screen_name || a.id,
      }).toString();
    }

    function renderPlan(src) {
      if (!src) return '';
      return marked.parse(src, { breaks: true });
    }

    document.querySelectorAll('.agent-plan').forEach(function(el) {
      var raw = el.textContent;
      el.innerHTML = renderPlan(raw);
    });

    // Bind initial peek/msg buttons
    document.querySelectorAll('[data-peek]').forEach(function(el) {
      el.onclick = function(e) { e.stopPropagation(); peek(el.dataset.peek); };
    });
    document.querySelectorAll('[data-msg]').forEach(function(el) {
      el.onclick = function(e) { e.stopPropagation(); promptSend(el.dataset.msg); };
    });

    function renderJson(val, depth) {
      const frag = document.createDocumentFragment();
      if (val === null) {
        const s = document.createElement('span');
        s.className = 'json-null';
        s.textContent = 'null';
        frag.appendChild(s);
      } else if (typeof val === 'boolean') {
        const s = document.createElement('span');
        s.className = 'json-bool';
        s.textContent = String(val);
        frag.appendChild(s);
      } else if (typeof val === 'number') {
        const s = document.createElement('span');
        s.className = 'json-num';
        s.textContent = String(val);
        frag.appendChild(s);
      } else if (typeof val === 'string') {
        // Try to unwrap nested stringified JSON
        let inner = null;
        if (val.length > 2 && (val[0] === '{' || val[0] === '[')) {
          try { inner = JSON.parse(val); } catch {}
        }
        if (inner !== null && typeof inner === 'object') {
          return renderJson(inner, depth);
        }
        const s = document.createElement('span');
        s.className = 'json-str';
        s.textContent = JSON.stringify(val);
        frag.appendChild(s);
      } else if (Array.isArray(val)) {
        if (val.length === 0) {
          const s = document.createElement('span');
          s.className = 'json-bracket';
          s.textContent = '[]';
          frag.appendChild(s);
        } else {
          const isOpen = depth === 0;
          const toggle = document.createElement('span');
          toggle.className = 'json-toggle' + (isOpen ? ' open' : '');
          const preview = document.createElement('span');
          preview.className = 'json-preview';
          preview.textContent = 'Array(' + val.length + ')';
          toggle.appendChild(preview);
          toggle.onclick = (e) => { e.stopPropagation(); toggle.classList.toggle('open'); };
          frag.appendChild(toggle);
          const children = document.createElement('div');
          children.className = 'json-children';
          val.forEach((item, i) => {
            const row = document.createElement('div');
            row.appendChild(renderJson(item, depth + 1));
            if (i < val.length - 1) {
              const comma = document.createElement('span');
              comma.className = 'json-comma';
              comma.textContent = ',';
              row.appendChild(comma);
            }
            children.appendChild(row);
          });
          frag.appendChild(children);
        }
      } else if (typeof val === 'object') {
        const keys = Object.keys(val);
        if (keys.length === 0) {
          const s = document.createElement('span');
          s.className = 'json-bracket';
          s.textContent = '{}';
          frag.appendChild(s);
        } else {
          const isOpen = depth === 0;
          const toggle = document.createElement('span');
          toggle.className = 'json-toggle' + (isOpen ? ' open' : '');
          const preview = document.createElement('span');
          preview.className = 'json-preview';
          preview.textContent = '{' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? ', \u2026' : '') + '}';
          toggle.appendChild(preview);
          toggle.onclick = (e) => { e.stopPropagation(); toggle.classList.toggle('open'); };
          frag.appendChild(toggle);
          const children = document.createElement('div');
          children.className = 'json-children';
          keys.forEach((k, i) => {
            const row = document.createElement('div');
            const key = document.createElement('span');
            key.className = 'json-key';
            key.textContent = JSON.stringify(k);
            row.appendChild(key);
            row.appendChild(document.createTextNode(': '));
            row.appendChild(renderJson(val[k], depth + 1));
            if (i < keys.length - 1) {
              const comma = document.createElement('span');
              comma.className = 'json-comma';
              comma.textContent = ',';
              row.appendChild(comma);
            }
            children.appendChild(row);
          });
          frag.appendChild(children);
        }
      }
      return frag;
    }

    function copy(text, srcEl) {
      navigator.clipboard.writeText(text).then(() => {
        const el = srcEl || event?.target?.closest('.copyable') || event?.target;
        if (el) {
          el.classList.add('copied');
          const toast = document.createElement('span');
          toast.className = 'copy-toast';
          toast.textContent = 'Copied!';
          el.appendChild(toast);
          setTimeout(() => { el.classList.remove('copied'); toast.remove(); }, 800);
        }
      });
    }

    // ---- Wallets panel ----
    let walletsCache = {};

    async function loadWallets() {
      const panel = document.getElementById('wallets-panel');
      try {
        const res = await fetch('/plugin_settings/wallet-vault/wallets');
        if (res.status === 404) {
          walletsCache = {};
          renderWallets();
          return;
        }
        if (!res.ok) {
          panel.textContent = 'Failed to load wallets (' + res.status + ')';
          return;
        }
        const body = await res.json();
        walletsCache = body.value || {};
        renderWallets();
      } catch (e) {
        panel.textContent = 'Error loading wallets: ' + (e.message || e);
      }
    }

    function renderWallets() {
      const panel = document.getElementById('wallets-panel');
      const addrs = Object.keys(walletsCache);
      if (addrs.length === 0) {
        panel.className = 'wallets-empty';
        panel.textContent = '(no wallets yet)';
        return;
      }
      panel.className = '';
      panel.innerHTML = addrs.map(addr => {
        const w = walletsCache[addr];
        const name = w.operator_name || w.name;
        const shortAddr = addr.slice(0, 8) + '…' + addr.slice(-6);
        const accessControls = w.access.mode === 'all'
          ? '<span class="wallet-access-disabled">all registered agents</span>'
          : (w.access.mode === 'creator-only'
              ? '<span class="wallet-access-disabled">creator only (' + esc(w.creator) + ')</span>'
              : (w.access.agents.map(ag =>
                  '<span class="wallet-member-chip">' + esc(ag) +
                  '<span class="wallet-member-revoke" onclick="revokeAgent(\\''+addr+'\\',\\''+esc(ag)+'\\')" title="Revoke">×</span></span>'
                ).join('') +
                '<span class="wallet-grant"><input type="text" placeholder="agent-id" id="grant-'+addr+'"><button onclick="grantAgent(\\''+addr+'\\')">+grant</button></span>'));
        return '<div class="wallet-row">' +
          '<div class="wallet-head">' +
            '<span class="wallet-name">' + esc(name) + '</span>' +
            '<span class="wallet-addr copyable" onclick="copy(\\''+addr+'\\',this)" title="Click to copy">' + esc(shortAddr) + '</span>' +
            '<span class="wallet-chain">chain ' + w.chain_id + '</span>' +
            '<span class="wallet-creator">creator: ' + esc(w.creator) + '</span>' +
            'mode: <select class="wallet-mode-select" onchange="setMode(\\''+addr+'\\',this.value)">' +
              ['creator-only', 'specific', 'all'].map(m =>
                '<option value="'+m+'"' + (w.access.mode === m ? ' selected' : '') + '>'+m+'</option>'
              ).join('') +
            '</select>' +
          '</div>' +
          '<div class="wallet-members">' + accessControls + '</div>' +
        '</div>';
      }).join('');
    }

    async function putWallets(updated) {
      const res = await fetch('/plugin_settings/wallet-vault/wallets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: updated }),
      });
      if (!res.ok) {
        alert('Update failed (' + res.status + '): ' + await res.text().catch(() => ''));
        return false;
      }
      return true;
    }

    async function grantAgent(addr) {
      const input = document.getElementById('grant-' + addr);
      const agentId = input.value.trim();
      if (!agentId) return;
      const next = JSON.parse(JSON.stringify(walletsCache));
      const w = next[addr];
      if (w.access.mode === 'creator-only') w.access.mode = 'specific';
      if (!w.access.agents.includes(agentId)) w.access.agents.push(agentId);
      if (await putWallets(next)) {
        input.value = '';
        await loadWallets();
      }
    }

    async function revokeAgent(addr, agentId) {
      const next = JSON.parse(JSON.stringify(walletsCache));
      next[addr].access.agents = next[addr].access.agents.filter(a => a !== agentId);
      if (await putWallets(next)) await loadWallets();
    }

    async function setMode(addr, mode) {
      const next = JSON.parse(JSON.stringify(walletsCache));
      next[addr].access.mode = mode;
      if (await putWallets(next)) await loadWallets();
    }

    // Refresh wallets when plugin_settings.updated arrives via SSE.
    // The dashboard's existing stream listener (further down) calls
    // refreshWalletsIfRelevant on every message; expose it globally.
    window.refreshWalletsIfRelevant = function(msg) {
      if (msg && msg.topic === 'plugin_settings.updated' && msg.payload &&
          msg.payload.namespace === 'wallet-vault' && msg.payload.key === 'wallets') {
        walletsCache = msg.payload.value || {};
        renderWallets();
      } else if (msg && msg.topic === 'plugin_settings.deleted' && msg.payload &&
          msg.payload.namespace === 'wallet-vault' && msg.payload.key === 'wallets') {
        walletsCache = {};
        renderWallets();
      }
    };

    loadWallets();

    async function generateKeypair() {
      const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
      const privRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
      const pubB64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));
      const privB64 = btoa(String.fromCharCode(...new Uint8Array(privRaw)));

      document.getElementById('new-agent-pubkey').value = pubB64;
      document.getElementById('gen-pubkey').textContent = pubB64;
      document.getElementById('gen-privkey').textContent = privB64;
      document.getElementById('key-output').style.display = 'block';
    }


    // Peek lives in #peek-dock, outside the agent table. SSE rebuilds tbody
    // every 3s; a row inside it vanished. Click peek again to close.
    async function peek(agentId) {
      const existing = document.getElementById('peek-' + agentId);
      if (existing) { existing.remove(); return; }

      const res = await fetch('/agents/' + encodeURIComponent(agentId) + '/peek');
      const data = await res.json();
      const dock = document.getElementById('peek-dock');
      if (!dock) return;
      const panel = document.createElement('div');
      panel.id = 'peek-' + agentId;
      panel.className = 'peek-output';
      if (res.ok) {
        panel.innerHTML = '<div class="peek-header">' + esc(agentId) + ' screen output — click peek again to close</div>' + esc(data.output || '(empty)');
      } else {
        panel.style.color = '#f87171';
        panel.textContent = 'peek failed: ' + (data.error || res.status) + (data.detail ? ' — ' + data.detail : '');
      }
      dock.appendChild(panel);
      panel.scrollIntoView({ block: 'nearest' });
    }

    async function promptSend(agentId) {
      const msg = prompt('Message to ' + agentId + ':');
      if (!msg) return;

      const res = await fetch('/agents/' + encodeURIComponent(agentId) + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, text: msg }),
      });

      const data = await res.json();
      const dock = document.getElementById('peek-dock');
      const note = document.createElement('div');
      note.className = 'peek-output';
      if (!res.ok) {
        note.style.color = '#f87171';
        note.textContent = 'msg to ' + agentId + ' failed: ' + (data.error || res.status) + (data.detail ? ' — ' + data.detail : '');
      } else {
        const st = ((data.delivered_to || [])[0] || {}).status || 'stored';
        note.innerHTML = '<div class="peek-header">msg ' + esc(agentId) + ' seq ' + esc(String(data.seq)) + ' (' + esc(st) + ') — click to dismiss</div>';
      }
      note.onclick = function() { note.remove(); };
      if (dock) dock.appendChild(note);
      else window.alert(note.textContent);
    }

    async function registerAgent() {
      const id = document.getElementById('new-agent-id').value.trim();
      const name = document.getElementById('new-agent-name').value.trim();
      const pubkey = document.getElementById('new-agent-pubkey').value.trim();

      if (!id || !name) { alert('Agent ID and name are required'); return; }
      if (!pubkey) { alert('Public key required — use keygen or paste one'); return; }

      const res = await fetch('/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, display_name: name, pubkey, permanent: true }),
      });

      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert('Registration failed: ' + (err.error || res.status));
      }
    }
  </script>
</body>
</html>`;
}

export function renderLogin(hasOwner: boolean): string {
  const action = hasOwner ? "Sign in" : "Claim this instance";
  const subtitle = hasOwner
    ? "Authenticate with your passkey to access the dashboard."
    : "No owner registered. The first passkey claims ownership.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${process.env.WIRE_INSTANCE_NAME ?? "The Wire"} — Login</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230a0a0a'/><path d='M18 4L10 18h5l-2 10 10-14h-5z' fill='%23fbbf24'/></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #111;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 32px;
      width: 360px;
      text-align: center;
    }
    h1 { font-size: 16px; margin-bottom: 8px; }
    p { color: #6b7280; margin-bottom: 24px; font-size: 12px; }
    button {
      background: #fafafa;
      color: #0a0a0a;
      border: none;
      padding: 10px 24px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      width: 100%;
    }
    button:hover { background: #d4d4d8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #f87171; margin-top: 12px; font-size: 12px; display: none; }
    #name-field { display: ${hasOwner ? "none" : "block"}; margin-bottom: 16px; }
    input {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #e5e5e5;
      padding: 8px 12px;
      font-family: inherit;
      font-size: 13px;
      border-radius: 4px;
      width: 100%;
    }
    input:focus { outline: none; border-color: #60a5fa; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${process.env.WIRE_INSTANCE_NAME ? process.env.WIRE_INSTANCE_NAME + " - " : ""}The Wire</h1>
    <p>${subtitle}</p>
    <div id="name-field">
      <input type="text" id="display-name" placeholder="Your name" autocomplete="name">
    </div>
    <button id="auth-btn" onclick="authenticate()">${action}</button>
    <div id="error" class="error"></div>
  </div>

  <script>
    const hasOwner = ${hasOwner};

    async function authenticate() {
      const btn = document.getElementById('auth-btn');
      const errEl = document.getElementById('error');
      btn.disabled = true;
      errEl.style.display = 'none';

      try {
        if (!hasOwner) {
          await doRegister();
        } else {
          await doLogin();
        }
      } catch (e) {
        errEl.textContent = e.message || 'Authentication failed';
        errEl.style.display = 'block';
        btn.disabled = false;
      }
    }

    async function doRegister() {
      const name = document.getElementById('display-name').value || 'Operator';
      const res = await fetch('/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name }),
      });
      const options = await res.json();

      // Decode challenge
      options.challenge = base64urlToBuffer(options.challenge);
      options.user.id = base64urlToBuffer(options.user.id);

      const credential = await navigator.credentials.create({ publicKey: options });
      const response = credential.response;

      await fetch('/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          response: {
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            attestationObject: bufferToBase64url(response.attestationObject),
          },
          type: credential.type,
          display_name: name,
          challenge: options._challenge,
        }),
      });

      window.location.reload();
    }

    async function doLogin() {
      const res = await fetch('/auth/login/options', { method: 'POST' });
      const options = await res.json();
      const savedChallenge = options.challenge;

      const publicKeyOptions = {
        challenge: base64urlToBuffer(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
      };

      const credential = await navigator.credentials.get({ publicKey: publicKeyOptions });
      const response = credential.response;

      const verifyRes = await fetch('/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          response: {
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            authenticatorData: bufferToBase64url(response.authenticatorData),
            signature: bufferToBase64url(response.signature),
          },
          type: credential.type,
          challenge: savedChallenge,
        }),
      });

      if (verifyRes.ok) {
        window.location.reload();
      } else {
        throw new Error('Login verification failed');
      }
    }

    function base64urlToBuffer(b64url) {
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64);
      return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
    }

    function bufferToBase64url(buf) {
      const bytes = new Uint8Array(buf);
      let str = '';
      for (const b of bytes) str += String.fromCharCode(b);
      return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build the wire-attach:// URL for an agent's click-to-attach button (Phase 2/3).
 * The native WireAttach.app registers the wire-attach:// scheme and opens the
 * agent's screen in a new iTerm2 tab. Falls back to 'local' host and the agent
 * id as screen name when the agent didn't self-report those columns.
 *
 * NOTE: an identical helper is inlined in the client SSE re-render <script>
 * below — the two render sites run in different contexts (server-side template
 * literal vs. browser string-concat) so the helper is duplicated, not imported.
 * Keep the two in sync.
 */
function attachHref(a: any): string {
  return "wire-attach://attach?" + new URLSearchParams({
    agent: a.id,
    host: a.ssh_host || "local",
    user: a.run_as_uid || "",
    screen: a.screen_name || a.id,
  }).toString();
}
