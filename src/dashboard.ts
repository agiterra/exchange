/**
 * Dashboard HTML — monospace dark-mode agent registry.
 * Passkey auth on a monospace dark-mode agent registry — peak infrastructure.
 */

export function renderDashboard(agents: any[], operatorName: string): string {
  const agentRows = agents.map((a: any) => {
    const status = a.online ? "●" : "○";
    const statusColor = a.online ? "#4ade80" : "#6b7280";
    const planFull = a.plan ? esc(a.plan) : "";
    const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "never";
    const typeBadge = a.permanent
      ? '<span class="badge badge-personai">personai</span>'
      : '<span class="badge badge-ephemeral">ephemeral</span>';
    const pubkeyShort = a.pubkey ? a.pubkey.slice(0, 8) + "…" : "—";
    return `
      <tr class="agent-row" onclick="this.classList.toggle('expanded')">
        <td><span style="color:${statusColor}">${status}</span></td>
        <td class="agent-name">${esc(a.display_name)}</td>
        <td class="badge-cell">${typeBadge}</td>
        <td class="plan"><span class="plan-text">${planFull || "—"}</span></td>
      </tr>
      <tr class="agent-detail">
        <td></td>
        <td colspan="3" class="detail-content">
          <span class="detail-field">id:</span> <span class="copyable" onclick="copy('${esc(a.id)}',this)" title="Click to copy">${esc(a.id)}</span>
          <span class="detail-sep">·</span>
          <span class="detail-field">sessions:</span> ${a.sessions}
          <span class="detail-sep">·</span>
          <span class="detail-field">pubkey:</span> <span class="copyable" onclick="copy('${esc(a.pubkey)}',this)" title="Click to copy full key">${pubkeyShort}</span>
          <span class="detail-sep">·</span>
          <span class="detail-field">seen:</span> ${lastSeen}
          <div class="detail-plan">${planFull || ""}</div>
        </td>
      </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Wire</title>
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
    col.col-name { width: 150px; }
    col.col-type { width: 80px; }
    col.col-plan { }
    .badge-cell { white-space: nowrap; }
    td, th { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td:last-child { white-space: nowrap; }
    .plan { color: #a1a1aa; overflow: hidden; }
    .plan-text {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agent-detail { display: none; }
    .agent-row.expanded + .agent-detail { display: table-row; }
    .detail-content {
      padding: 4px 12px 12px 0;
      color: #6b7280;
      font-size: 0.85em;
      white-space: normal;
      border-bottom: 1px solid #1f1f1f;
    }
    .detail-field { color: #525252; }
    .detail-sep { color: #333; margin: 0 4px; }
    .detail-plan {
      margin-top: 6px;
      color: #a1a1aa;
      white-space: pre-wrap;
      line-height: 1.4;
    }
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
    .msg-delivery .ok { color: #4ade80; }
    .msg-delivery .skip { color: #f87171; }
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
    .stats {
      display: flex;
      gap: 32px;
      margin-bottom: 24px;
      color: #a1a1aa;
    }
    .stat-value { color: #fafafa; font-weight: 600; }
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
    <h1>The Wire <span>v0.3.0</span></h1>
    <div class="operator">${esc(operatorName)} · <a href="/auth/logout">logout</a></div>
  </header>

  <div class="stats">
    <div><span class="stat-value">${agents.length}</span> agents</div>
    <div><span class="stat-value">${agents.filter((a: any) => a.online).length}</span> online</div>
    <div><span class="stat-value">${agents.reduce((n: number, a: any) => n + a.sessions, 0)}</span> sessions</div>
  </div>

  <h2>Agent Registry</h2>
  <table>
    <colgroup>
      <col class="col-status">
      <col class="col-name">
      <col class="col-type">
      <col class="col-plan">
    </colgroup>
    <thead>
      <tr>
        <th></th>
        <th>Agent</th>
        <th>Type</th>
        <th>Plan</th>
      </tr>
    </thead>
    <tbody>
      ${agentRows}
    </tbody>
  </table>

  <div class="form-section">
    <div class="msg-log-header" id="msg-log-header" onclick="this.classList.toggle('expanded')">
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
      const expandedIds = new Set();
      tbody.querySelectorAll('.agent-row.expanded').forEach(el => {
        const id = el.getAttribute('data-agent');
        if (id) expandedIds.add(id);
      });
      tbody.innerHTML = agents.map(a => {
        const status = a.online ? '●' : '○';
        const statusColor = a.online ? '#4ade80' : '#6b7280';
        const planFull = a.plan ? esc(a.plan) : '';
        const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : 'never';
        const typeBadge = a.permanent
          ? '<span class="badge badge-personai">personai</span>'
          : '<span class="badge badge-ephemeral">ephemeral</span>';
        const pubkeyShort = a.pubkey ? a.pubkey.slice(0, 8) + '…' : '—';
        const expanded = expandedIds.has(a.id) ? ' expanded' : '';
        return '<tr class="agent-row' + expanded + '" data-agent="' + esc(a.id) + '" onclick="this.classList.toggle(&quot;expanded&quot;)">' +
          '<td><span style="color:' + statusColor + '">' + status + '</span></td>' +
          '<td class="agent-name">' + esc(a.display_name) + '</td>' +
          '<td class="badge-cell">' + typeBadge + '</td>' +
          '<td class="plan"><span class="plan-text">' + (planFull || '—') + '</span></td>' +
          '</tr>' +
          '<tr class="agent-detail">' +
          '<td></td>' +
          '<td colspan="3" class="detail-content">' +
          '<span class="detail-field">id:</span> <span class="copyable" data-copy="' + esc(a.id) + '" onclick="event.stopPropagation()">' + esc(a.id) + '</span>' +
          '<span class="detail-sep">·</span>' +
          '<span class="detail-field">sessions:</span> ' + a.sessions +
          '<span class="detail-sep">·</span>' +
          '<span class="detail-field">pubkey:</span> <span class="copyable" data-copy="' + esc(a.pubkey) + '" onclick="event.stopPropagation()">' + pubkeyShort + '</span>' +
          '<span class="detail-sep">·</span>' +
          '<span class="detail-field">seen:</span> ' + lastSeen +
          '<div class="detail-plan">' + (planFull || '') + '</div>' +
          '</td></tr>';
      }).join('');

      // Re-bind click handlers via delegation
      tbody.querySelectorAll('[data-copy]').forEach(el => {
        el.onclick = (e) => { e.stopPropagation(); copy(el.dataset.copy, el); };
      });
    };

    // --- Message log ---
    let msgCount = 0;
    function addMessageEntry(msg) {
      const log = document.getElementById('message-log');
      const d = new Date(msg.created_at);
      const ts = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString();
      const deliveryBadges = (msg.deliveries || []).map(d =>
        '<span class="' + (d.status === 'delivered' ? 'ok' : 'skip') + '">' + esc(d.agentId) + '</span>'
      ).join(' ');

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
      addMessageEntry(JSON.parse(e.data));
    });

    // Backfill recent messages via REST
    fetch('/messages/recent?limit=50').then(r => r.json()).then(messages => {
      // Reverse so newest ends up on top after prepend
      for (const msg of messages.reverse()) addMessageEntry(msg);
    }).catch(() => {});

    function esc(s) {
      return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') : '';
    }

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


    async function registerAgent() {
      const id = document.getElementById('new-agent-id').value.trim();
      const name = document.getElementById('new-agent-name').value.trim();
      const pubkey = document.getElementById('new-agent-pubkey').value.trim();

      if (!id || !name) { alert('Agent ID and name are required'); return; }
      if (!pubkey) { alert('Public key required — use keygen or paste one'); return; }

      const res = await fetch('/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, display_name: name, pubkey }),
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
  <title>The Wire — Login</title>
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
    <h1>The Wire</h1>
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
