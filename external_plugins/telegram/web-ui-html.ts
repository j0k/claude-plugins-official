/**
 * Embedded web UI HTML/CSS/JS — served by daemon.ts on localhost.
 * Single-page dashboard with auto-refreshing panels for daemon status,
 * inbox/outbox queues, and structured events log.
 */

export const webUIHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Telegram Daemon</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #21262d;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --accent: #58a6ff;
    --ok: #3fb950;
    --warn: #d29922;
    --err: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    margin: 0;
    padding: 16px;
    font-size: 13px;
    line-height: 1.5;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }
  h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .muted { color: var(--muted); font-size: 12px; }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .full { grid-column: 1 / -1; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    min-height: 100px;
  }
  .panel h2 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
  }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; word-break: break-all; }
  ul, ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li.item {
    padding: 6px 8px;
    margin-bottom: 4px;
    background: var(--panel-2);
    border-radius: 4px;
    border-left: 3px solid var(--border);
  }
  li.item.ok { border-left-color: var(--ok); }
  li.item.warn { border-left-color: var(--warn); }
  li.item.err { border-left-color: var(--err); }
  li.item .meta {
    color: var(--muted);
    font-size: 11px;
    display: flex;
    gap: 8px;
    margin-bottom: 2px;
  }
  li.item .body { white-space: pre-wrap; }
  .events {
    max-height: 500px;
    overflow-y: auto;
    background: #010409;
    padding: 8px;
    border-radius: 4px;
    font-size: 12px;
  }
  .events div { white-space: pre-wrap; padding: 1px 0; }
  .events .info { color: var(--text); }
  .events .debug { color: var(--muted); }
  .events .warn { color: var(--warn); }
  .events .error { color: var(--err); }
  .events .source-daemon { }
  .events .source-plugin { color: #79c0ff; }
  .events .source-tool { color: #d2a8ff; }
  .empty { color: var(--muted); font-style: italic; padding: 8px; }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--panel-2);
    font-size: 11px;
  }
  .badge.ok { background: rgba(63,185,80,0.2); color: var(--ok); }
  .badge.warn { background: rgba(210,153,34,0.2); color: var(--warn); }
  button {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }
  button:hover { background: var(--border); }
</style>
</head>
<body>
<header>
  <h1>Telegram Daemon Dashboard</h1>
  <div class="muted">
    <span id="last-update">—</span>
    <label style="margin-left:12px;"><input type="checkbox" id="autorefresh" checked> auto-refresh</label>
    <button onclick="refreshAll()" style="margin-left:8px;">refresh</button>
  </div>
</header>

<div class="grid">
  <section class="panel">
    <h2>Daemon</h2>
    <dl class="kv" id="daemon-info">
      <dt>status</dt><dd><span class="badge" id="daemon-status">…</span></dd>
    </dl>
  </section>

  <section class="panel">
    <h2>State</h2>
    <dl class="kv" id="state-info">
      <dt>—</dt><dd>—</dd>
    </dl>
  </section>

  <section class="panel">
    <h2>Inbox (<span id="inbox-count">0</span>)</h2>
    <ul id="inbox-list"><li class="empty">no pending messages</li></ul>
  </section>

  <section class="panel">
    <h2>Outbox (<span id="outbox-count">0</span>)</h2>
    <ul id="outbox-list"><li class="empty">empty</li></ul>
  </section>

  <section class="panel full">
    <h2>Events (live)</h2>
    <div class="events" id="events"></div>
  </section>
</div>

<script>
let lastEventTs = 0;

async function fetchJson(path) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function refreshDaemon() {
  const d = await fetchJson('/api/daemon');
  if (!d) return;
  const dl = document.getElementById('daemon-info');
  const uptimeStr = formatUptime(d.uptime_sec);
  dl.innerHTML =
    '<dt>status</dt><dd><span class="badge ok">running</span></dd>' +
    '<dt>pid</dt><dd>' + d.pid + '</dd>' +
    '<dt>bot</dt><dd>@' + (d.bot_username || '—') + '</dd>' +
    '<dt>uptime</dt><dd>' + uptimeStr + '</dd>' +
    '<dt>started</dt><dd>' + d.started_at + '</dd>' +
    '<dt>log</dt><dd style="font-size:11px;">' + d.log_file + '</dd>';
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
}

async function refreshState() {
  const s = await fetchJson('/api/state');
  if (!s) return;
  const dl = document.getElementById('state-info');
  const lastChats = s.last_read_per_chat || {};
  const chatRows = Object.entries(lastChats).map(([cid, ts]) => '<dt>chat ' + cid + '</dt><dd>' + ts + '</dd>').join('');
  dl.innerHTML =
    '<dt>last_read</dt><dd>' + (s.last_read_at || '—') + '</dd>' +
    chatRows;
}

function renderQueue(elemId, countId, items, kind) {
  document.getElementById(countId).textContent = items.length;
  const ul = document.getElementById(elemId);
  if (!items.length) { ul.innerHTML = '<li class="empty">empty</li>'; return; }
  ul.innerHTML = items.map(it => {
    const c = it.content || {};
    if (kind === 'inbox') {
      return '<li class="item">' +
        '<div class="meta"><span>' + (c.user || '?') + '</span><span>chat=' + (c.chat_id || '?') + '</span><span>' + (c.ts || '') + '</span></div>' +
        '<div class="body">' + escapeHtml((c.content || '').slice(0, 200)) + '</div>' +
      '</li>';
    } else {
      const preview = c.type === 'send_message' ? (c.text || '').slice(0, 200) :
                      c.type === 'react' ? 'react ' + c.emoji + ' on msg ' + c.message_id :
                      c.type === 'edit_message' ? 'edit msg ' + c.message_id + ': ' + (c.text || '').slice(0, 200) :
                      JSON.stringify(c);
      return '<li class="item">' +
        '<div class="meta"><span>' + (c.type || '?') + '</span><span>chat=' + (c.chat_id || '?') + '</span><span>' + (c.queued_at || '') + '</span></div>' +
        '<div class="body">' + escapeHtml(preview) + '</div>' +
      '</li>';
    }
  }).join('');
}

async function refreshInbox() {
  const items = await fetchJson('/api/inbox') || [];
  renderQueue('inbox-list', 'inbox-count', items, 'inbox');
}

async function refreshOutbox() {
  const items = await fetchJson('/api/outbox') || [];
  renderQueue('outbox-list', 'outbox-count', items, 'outbox');
}

async function refreshEvents() {
  const evs = await fetchJson('/api/events?limit=200');
  if (!evs) return;
  const cont = document.getElementById('events');
  const html = evs.slice(-200).map(e => {
    const cls = 'source-' + (e.source || 'tool') + ' ' + (e.level || 'info');
    const extras = Object.entries(e).filter(([k]) => !['ts','source','level','event'].includes(k))
      .map(([k,v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)))
      .join(' ');
    return '<div class="' + cls + '">[' + e.ts + '] ' + e.source + ' ' + e.level + ' ' + e.event + (extras ? ' ' + extras : '') + '</div>';
  }).join('');
  cont.innerHTML = html;
  cont.scrollTop = cont.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

async function refreshAll() {
  await Promise.all([refreshDaemon(), refreshState(), refreshInbox(), refreshOutbox(), refreshEvents()]);
  document.getElementById('last-update').textContent = 'updated ' + new Date().toLocaleTimeString();
}

setInterval(() => {
  if (document.getElementById('autorefresh').checked) refreshAll();
}, 3000);
refreshAll();
</script>
</body>
</html>`
