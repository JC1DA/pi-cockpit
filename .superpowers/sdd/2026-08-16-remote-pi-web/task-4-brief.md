### Task 4: Web pages (login + chat)

**Files:**
- Modify: `index.ts` (append `LOGIN_PAGE` + `CHAT_PAGE` sections)
- Modify: `selftest.ts` (extend import; append page test block)

**Interfaces:**
- Produces: `export const LOGIN_PAGE: string` — password form page.
- Produces: `export const CHAT_PAGE: string` — the live session viewer page.

Page rules (Global Constraints): single `<script>` block per page, no backticks, no `${...}`, ES2017-level JS only.

- [ ] **Step 1: Write the failing tests** — in `selftest.ts`, extend the import to add `LOGIN_PAGE, CHAT_PAGE`, and append:

```typescript
// ---------- pages ----------
{
  const scriptOf = (page: string): string[] => {
    const out: string[] = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(page)) !== null) out.push(m[1]);
    return out;
  };
  const syntaxOk = (page: string): boolean => {
    const scripts = scriptOf(page);
    if (scripts.length === 0) return false;
    return scripts.every((s) => { try { new Function(s); return true; } catch { return false; } });
  };
  check("page: login has password input and posts to /login",
    LOGIN_PAGE.includes('type="password"') && LOGIN_PAGE.includes("'/login'"));
  check("page: login script syntax valid", syntaxOk(LOGIN_PAGE));
  check("page: chat uses EventSource on /events", CHAT_PAGE.includes("new EventSource('/events')"));
  check("page: chat script syntax valid", syntaxOk(CHAT_PAGE));
  check("page: no template literals leak into pages",
    !LOGIN_PAGE.includes("`") && !CHAT_PAGE.includes("`") &&
    !LOGIN_PAGE.includes("${") && !CHAT_PAGE.includes("${"));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node selftest.ts`
Expected: `LOGIN_PAGE is not exported`/undefined failure (red).

- [ ] **Step 3: Implement** — in `index.ts`, append:

```typescript
// ---------------------------------------------------------------------------
// Pages (spec §6). No backticks / ${...} inside page JS — they nest in
// template literals below.
// ---------------------------------------------------------------------------

export const LOGIN_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi remote — login</title>
<style>
body{background:#111;color:#e5e5e5;font:15px ui-monospace,SFMono-Regular,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#1c1c1e;padding:28px;border-radius:12px;display:flex;flex-direction:column;gap:12px;width:280px}
h1{font-size:16px;margin:0}
input{background:#111;border:1px solid #444;color:#e5e5e5;padding:8px;border-radius:8px;font:inherit}
button{background:#2563eb;color:#fff;border:0;padding:8px;border-radius:8px;cursor:pointer;font:inherit}
.err{color:#f87171;font-size:13px;min-height:16px}
</style>
</head>
<body>
<form id="f">
<h1>pi session viewer</h1>
<input id="pw" type="password" placeholder="password" autofocus>
<button>Unlock</button>
<div class="err" id="err"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value })
  }).then(function (r) {
    if (r.ok) { location.reload(); }
    else { document.getElementById('err').textContent = 'wrong password'; }
  });
});
</script>
</body>
</html>`;

export const CHAT_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi session</title>
<style>
:root{--bg:#111;--panel:#1c1c1e;--user:#2563eb;--asst:#26262c;--tool:#1a1a1c;--text:#e5e5e5;--dim:#8a8a8a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,monospace;display:flex;flex-direction:column;height:100vh}
header{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--panel);border-bottom:1px solid #333}
header .dot{width:9px;height:9px;border-radius:50%;background:#4ade80;flex:none}
header .dot.busy{background:#facc15}
header .meta{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header button{background:none;border:1px solid #555;color:var(--text);padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit}
header button#stop{display:none;border-color:#b91c1c}
header button#stop.show{display:inline-block}
#msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--user)}
.msg.assistant{align-self:flex-start;background:var(--asst)}
.msg.pending{opacity:.7;border:1px dashed #555}
.msg.pendinguser{opacity:.7;border:1px dashed #555;align-self:flex-end}
details.tool{align-self:flex-start;max-width:85%;background:var(--tool);border:1px solid #333;border-radius:8px;padding:4px 8px}
details.tool.err{border-color:#b91c1c}
details.tool summary{cursor:pointer;color:var(--dim);font-size:12px}
details.tool pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;color:#c8c8c8}
.note{align-self:center;color:var(--dim);font-size:12px}
footer{display:flex;gap:8px;padding:10px 12px;background:var(--panel);border-top:1px solid #333}
footer textarea{flex:1;resize:none;height:56px;background:#111;color:var(--text);border:1px solid #444;border-radius:8px;padding:8px;font:inherit}
footer button{background:var(--user);color:#fff;border:0;border-radius:8px;padding:0 16px;cursor:pointer;font:inherit}
</style>
</head>
<body>
<header>
<div class="dot" id="dot"></div>
<span class="meta" id="meta"></span>
<button id="stop">Stop</button>
<button id="logout">Logout</button>
</header>
<div id="msgs"></div>
<footer>
<textarea id="input" placeholder="Message..."></textarea>
<button id="send">Send</button>
</footer>
<script>
var msgs = document.getElementById('msgs'),
    input = document.getElementById('input'),
    dot = document.getElementById('dot'),
    metaEl = document.getElementById('meta'),
    stopBtn = document.getElementById('stop');
var curMeta = {}, pendingEl = null, pendingUserEl = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function autoScroll() {
  if (msgs.scrollTop + msgs.clientHeight > msgs.scrollHeight - 80) msgs.scrollTop = msgs.scrollHeight;
}
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(function (x) { return x && x.type === 'text'; })
    .map(function (x) { return x.text || ''; }).join('');
  return '';
}
function addMsg(role, html, cls) {
  var d = document.createElement('div');
  d.className = 'msg ' + role + (cls ? ' ' + cls : '');
  d.innerHTML = html;
  msgs.appendChild(d);
  autoScroll();
  return d;
}
function addNote(t) {
  var d = document.createElement('div');
  d.className = 'note';
  d.textContent = t;
  msgs.appendChild(d);
  autoScroll();
}
function updateMetaLine() {
  metaEl.textContent = (curMeta.sessionName || 'pi session') + '  ·  ' + (curMeta.model || '') + '  ·  ' + (curMeta.cwd || '');
  if (curMeta.sessionName) document.title = curMeta.sessionName;
}
function setBusy(b) {
  dot.classList.toggle('busy', b);
  stopBtn.classList.toggle('show', b);
  input.placeholder = b ? 'Agent busy — your message will queue...' : 'Message...';
}
function toolEl(id, name, state) {
  var old = document.getElementById('call-' + id);
  if (old) old.remove();
  var el = document.createElement('details');
  el.className = 'tool';
  el.id = 'call-' + id;
  el.innerHTML = '<summary>' + esc(name) + ' — ' + esc(state) + '</summary>';
  msgs.appendChild(el);
  autoScroll();
  return el;
}
function renderEntry(en) {
  if (en.type === 'message' && en.message) {
    var m = en.message;
    if (m.role === 'user') {
      if (pendingUserEl) { pendingUserEl.remove(); pendingUserEl = null; }
      addMsg('user', esc(textOf(m.content)));
    } else if (m.role === 'assistant') {
      var texts = [];
      (Array.isArray(m.content) ? m.content : []).forEach(function (p) {
        if (p.type === 'text') texts.push(p.text || '');
        else if (p.type === 'toolCall') {
          var el = toolEl(p.id, p.name, 'running...');
          var pre = document.createElement('pre');
          pre.className = 'in';
          pre.textContent = 'input: ' + JSON.stringify(p.arguments);
          el.appendChild(pre);
        }
      });
      if (pendingEl) { pendingEl.remove(); pendingEl = null; }
      if (texts.length) addMsg('assistant', esc(texts.join('')));
    } else if (m.role === 'toolResult') {
      var out = textOf(m.content);
      var el2 = document.getElementById('call-' + m.toolCallId);
      if (el2) {
        var s = el2.querySelector('summary');
        if (s) s.textContent = m.toolName + ' — ' + (m.isError ? 'error' : 'done');
        el2.classList.toggle('err', !!m.isError);
        var pre2 = document.createElement('pre');
        pre2.className = 'out';
        pre2.textContent = 'output: ' + out;
        el2.appendChild(pre2);
      } else {
        var el3 = document.createElement('details');
        el3.className = 'tool' + (m.isError ? ' err' : '');
        el3.innerHTML = '<summary>' + esc(m.toolName) + ' — ' + (m.isError ? 'error' : 'done') + '</summary>';
        var pre3 = document.createElement('pre');
        pre3.textContent = out;
        el3.appendChild(pre3);
        msgs.appendChild(el3);
      }
      autoScroll();
    } else if (m.role === 'bashExecution') {
      var el4 = document.createElement('details');
      el4.className = 'tool';
      el4.innerHTML = '<summary>! ' + esc(m.command || '') + '</summary>';
      var pre4 = document.createElement('pre');
      pre4.textContent = m.output || '';
      el4.appendChild(pre4);
      msgs.appendChild(el4);
      autoScroll();
    } else if (m.role === 'custom' || m.role === 'customMessage') {
      addNote('note: ' + textOf(m.content).slice(0, 200));
    }
    return;
  }
  if (en.type === 'compaction') addNote('— compacted (' + (en.tokensBefore || 0) + ' tokens before) —');
  else if (en.type === 'model_change') addNote('model → ' + (en.provider || '') + '/' + (en.modelId || ''));
  else if (en.type === 'thinking_level_change') addNote('thinking → ' + (en.thinkingLevel || ''));
  else if (en.type === 'branch_summary') addNote('branch: ' + String(en.summary || '').slice(0, 120));
  else if (en.type === 'session_info') addNote('name → ' + (en.name || '(cleared)'));
}
function renderSnapshot(d) {
  curMeta = d.meta || {};
  updateMetaLine();
  msgs.innerHTML = '';
  (d.entries || []).forEach(renderEntry);
  autoScroll();
}

var es = new EventSource('/events');
es.addEventListener('snapshot', function (e) { renderSnapshot(JSON.parse(e.data)); });
es.addEventListener('resync', function (e) { renderSnapshot(JSON.parse(e.data)); });
es.addEventListener('update', function (e) {
  var m = JSON.parse(e.data);
  if (!pendingEl) {
    pendingEl = document.createElement('div');
    pendingEl.className = 'msg assistant pending';
    msgs.appendChild(pendingEl);
  }
  pendingEl.textContent = textOf(m.content);
  autoScroll();
});
es.addEventListener('append', function (e) {
  (JSON.parse(e.data).entries || []).forEach(renderEntry);
});
es.addEventListener('toolstart', function (e) {
  var d = JSON.parse(e.data);
  toolEl(d.id, d.name, 'running...');
});
es.addEventListener('status', function (e) { setBusy(!!JSON.parse(e.data).busy); });
es.addEventListener('meta', function (e) { curMeta.model = JSON.parse(e.data).model || ''; updateMetaLine(); });

function send() {
  var t = input.value.trim();
  if (!t) return;
  input.value = '';
  pendingUserEl = addMsg('user', esc(t), 'pendinguser');
  fetch('/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: t })
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (d) { alert('send failed: ' + (d.error || r.status)); });
  }).catch(function (err) { alert('send failed: ' + err); });
}
input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.getElementById('send').addEventListener('click', send);
stopBtn.addEventListener('click', function () {
  fetch('/stop', { method: 'POST' }).then(function () { setBusy(false); });
});
document.getElementById('logout').addEventListener('click', function () {
  fetch('/logout', { method: 'POST' }).then(function () { location.reload(); });
});
</script>
</body>
</html>`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent.

---

