# Review package: review-task-5.md
Changed files: index.ts selftest.ts

===== FILE: index.ts =====
/**
 * remote-pi-ext — browse and drive the current pi session from a web browser.
 *
 *   /webserve start [port]   (default 8765) — asks for a password, serves the session
 *   /webserve stop
 *   /webserve status
 *
 * Zero runtime dependencies: node:http + node:crypto + node:os only.
 * The pi import below is type-only (erased at runtime).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

export type AnyRec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Password (spec §7)
// ---------------------------------------------------------------------------

/** SHA-256 hex of the password. The only form of the password ever stored. */
export function hashPassword(pw: string): string {
  return createHash("sha256").update(pw, "utf8").digest("hex");
}

/**
 * Constant-time password check. Never throws: a malformed/short stored hash
 * simply fails (digest is always 32 bytes; Buffer.from("hex") may yield less).
 */
export function verifyPassword(pw: string, hashHex: string): boolean {
  const given = createHash("sha256").update(pw, "utf8").digest();
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0 || expected.length !== given.length) return false;
  return timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Session tokens + cookie (spec §5 Auth)
// ---------------------------------------------------------------------------

const COOKIE_NAME = "remote_pi_session";

/** 32 random bytes, hex — 256-bit unguessable token. */
export function issueToken(): string {
  return randomBytes(32).toString("hex");
}

export function cookieHeader(token: string): string {
  return COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800";
}

export function clearCookieHeader(): string {
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

/** Extract our token from a `Cookie` request header. Null when absent/empty. */
export function tokenFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const kv = part.trim();
    if (kv.startsWith(COOKIE_NAME + "=")) {
      const v = kv.slice(COOKIE_NAME.length + 1);
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry sanitizer (spec §5: strip everything except what the web view needs)
// ---------------------------------------------------------------------------

const ENTRY_FIELDS: Record<string, string[]> = {
  message: ["type", "id", "timestamp", "message"],
  compaction: ["type", "id", "timestamp", "summary", "tokensBefore"],
  branch_summary: ["type", "id", "timestamp", "fromId", "summary"],
  model_change: ["type", "id", "timestamp", "provider", "modelId"],
  thinking_level_change: ["type", "id", "timestamp", "thinkingLevel"],
  session_info: ["type", "id", "timestamp", "name"],
  custom_message: ["type", "id", "timestamp", "customType", "content", "display"],
  custom: ["type", "id", "timestamp", "customType", "data"],
  label: ["type", "id", "timestamp", "targetId", "label"],
};

/** Whitelist one entry's fields. `parentId` is never sent; unknown types -> null. */
export function sanitizeEntry(e: AnyRec): AnyRec | null {
  const fields = ENTRY_FIELDS[e.type as string];
  if (!fields) return null;
  const out: AnyRec = {};
  for (const f of fields) {
    if (e[f] !== undefined) out[f] = e[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaf diff (spec §5 streaming protocol: append vs resync per client)
// ---------------------------------------------------------------------------

export type LeafDiff =
  | { kind: "none" }
  | { kind: "append"; entries: AnyRec[] } // raw entries, oldest-first, excludes lastLeaf
  | { kind: "resync" };                   // caller sends a full snapshot

/**
 * Decide what one SSE client needs when the session leaf moved from
 * `lastLeaf` to `newLeaf`. Walks parentId links from newLeaf back to lastLeaf;
 * any break in the chain (tree nav, resume, compaction re-root, unknown id)
 * means the client must resync. A 100k-step guard defeats pathological cycles.
 */
export function diffLeaf(
  byId: Map<string, AnyRec>,
  lastLeaf: string | null,
  newLeaf: string | null,
): LeafDiff {
  if (!newLeaf || newLeaf === lastLeaf) return { kind: "none" };
  if (!lastLeaf) return { kind: "resync" };
  const path: AnyRec[] = [];
  let cur: string | null = newLeaf;
  let guard = 0;
  while (cur !== lastLeaf) {
    const e = byId.get(cur);
    if (!e) return { kind: "resync" };
    path.push(e);
    cur = (e.parentId as string | null) ?? null;
    if (cur === null) return { kind: "resync" };
    if (++guard > 100000) return { kind: "resync" };
  }
  path.reverse();
  return { kind: "append", entries: path };
}
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

// ---------------------------------------------------------------------------
// Web server (spec §5). Zero-dependency node:http.
// ---------------------------------------------------------------------------

const BODY_LIMIT = 100 * 1024;   // spec: 100 KB body limit
const INPUT_LIMIT = 32 * 1024;   // spec: input text 32 KB

export interface SnapshotMeta {
  cwd: string;
  model: string;
  sessionName: string | null;
  leafId: string | null;
}

/** Pi-side dependency seam. Task 7 implements this against a live session. */
export interface WebApi {
  getSnapshot(): { entries: AnyRec[]; meta: SnapshotMeta };
  allEntries(): Map<string, AnyRec>;
  sendInput(text: string): Promise<{ queued: boolean }>;
  stopAgent(): { aborted: boolean };
}

export interface WebServer {
  port: number; // actual bound port (may differ from requested)
  stop(): void;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        const err = new Error("body too large");
        (err as { code?: string }).code = "BODY_TOO_LARGE";
        reject(err);
        // deviation: brief called req.destroy() here; that also kills the socket, so the
        // 413 could never be delivered (client saw ECONNRESET). Stream keeps flowing (drains
        // the body); chunks is not buffered past the limit, so memory stays bounded.
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function parseJsonBody(raw: string): AnyRec | null {
  try { return JSON.parse(raw) as AnyRec; } catch { return null; }
}

export function startServer(opts: {
  host?: string;
  port: number;
  passwordHash: string;
  tokens: Set<string>;
  api: WebApi;
}): Promise<WebServer> {
  const { passwordHash, tokens, api } = opts;
  const server = http.createServer((req, res) => { void handle(req, res); });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || "/").split("?")[0];
    const token = tokenFromCookie(req.headers.cookie);
    const authed = token !== null && tokens.has(token);
    try {
      // --- public: page + login ---
      if (req.method === "GET" && url === "/") {
        html(res, 200, authed ? CHAT_PAGE : LOGIN_PAGE);
        return;
      }
      if (req.method === "POST" && url === "/login") {
        const raw = await readBody(req, BODY_LIMIT);
        const body = parseJsonBody(raw);
        const pw = typeof body?.password === "string" ? (body.password as string) : "";
        if (!verifyPassword(pw, passwordHash)) { json(res, 401, { error: "bad password" }); return; }
        const t = issueToken();
        tokens.add(t);
        json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(t) });
        return;
      }
      // --- everything below requires a valid token cookie ---
      if (!authed) { json(res, 401, { error: "unauthenticated" }); return; }

      if (req.method === "POST" && url === "/input") {
        const raw = await readBody(req, BODY_LIMIT);
        const body = parseJsonBody(raw);
        if (!body) { json(res, 400, { error: "bad json" }); return; }
        const text = typeof body.text === "string" ? (body.text as string).trim() : "";
        if (!text) { json(res, 400, { error: "empty message" }); return; }
        if (text.length > INPUT_LIMIT) { json(res, 400, { error: "message too long" }); return; }
        const r = await api.sendInput(text);
        json(res, 200, { ok: true, queued: r.queued });
        return;
      }
      if (req.method === "POST" && url === "/stop") {
        json(res, 200, api.stopAgent());
        return;
      }
      if (req.method === "POST" && url === "/logout") {
        if (token) tokens.delete(token);
        json(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeader() });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (res.headersSent) { res.end(); return; }
      if (e.code === "BODY_TOO_LARGE") { json(res, 413, { error: "body too large" }); return; }
      if (e.code === "NO_CTX") { json(res, 503, { error: "session is ending" }); return; }
      json(res, 500, { error: e.message || "server error" });
    }
  }

  const web: WebServer = {
    port: opts.port,
    stop() {
      server.close();
    },
  };

  return new Promise<WebServer>((resolve, reject) => {
    server.once("error", reject); // surfaces EADDRINUSE to the caller
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") web.port = addr.port;
      resolve(web);
    });
  });
}
===== END: index.ts =====

===== FILE: selftest.ts =====
// selftest.ts — run: node selftest.ts   (Node >= 23.6, native TS type stripping)
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie, sanitizeEntry, diffLeaf, startServer, type AnyRec, LOGIN_PAGE, CHAT_PAGE } from "./index.ts";

let failed = 0, passed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed++; console.error("FAIL " + name); }
}

// ---------- password ----------
{
  const h = hashPassword("hunter22");
  check("password: hash is 64 hex chars", /^[0-9a-f]{64}$/.test(h));
  check("password: correct password verifies", verifyPassword("hunter22", h));
  check("password: wrong password rejected", !verifyPassword("hunter23", h));
  check("password: length mismatch rejected", !verifyPassword("x", h));
  check("password: malformed hash rejected", !verifyPassword("hunter22", "nothex"));
  check("password: empty hash rejected", !verifyPassword("hunter22", ""));
}

// ---------- tokens / cookie ----------
{
  const t1 = issueToken(), t2 = issueToken();
  check("token: 64 hex chars", /^[0-9a-f]{64}$/.test(t1));
  check("token: unique", t1 !== t2);
  const ch = cookieHeader(t1);
  check("cookie: header has token + HttpOnly + SameSite=Lax + Max-Age=604800",
    ch.startsWith("remote_pi_session=" + t1) && ch.includes("HttpOnly") &&
    ch.includes("SameSite=Lax") && ch.includes("Max-Age=604800"));
  check("cookie: clear header has Max-Age=0", clearCookieHeader().includes("Max-Age=0"));
  check("cookie: parse finds token among others", tokenFromCookie("a=1; remote_pi_session=abc; b=2") === "abc");
  check("cookie: parse missing -> null", tokenFromCookie("a=1") === null);
  check("cookie: parse undefined header -> null", tokenFromCookie(undefined) === null);
  check("cookie: parse empty value -> null", tokenFromCookie("remote_pi_session=") === null);
}

// ---------- entry sanitizer + leaf diff ----------
{
  const msg = sanitizeEntry({ type: "message", id: "a", parentId: "p", timestamp: "t",
    message: { role: "user", content: "hi" }, secret: 1 });
  check("sanitize: message keeps whitelisted fields only",
    JSON.stringify(msg) === JSON.stringify({ type: "message", id: "a", timestamp: "t",
      message: { role: "user", content: "hi" } }));
  check("sanitize: unknown type dropped", sanitizeEntry({ type: "???", id: "a" }) === null);

  const tree: Record<string, unknown>[] = [
    { type: "message", id: "a", parentId: null, timestamp: "1", message: { role: "user", content: "m1" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2", message: { role: "assistant", content: [{ type: "text", text: "r1" }] } },
    { type: "message", id: "c", parentId: "b", timestamp: "3", message: { role: "user", content: "m2" } },
    { type: "message", id: "d", parentId: "c", timestamp: "4", message: { role: "assistant", content: [{ type: "text", text: "r2" }] } },
    { type: "model_change", id: "e", parentId: "a", timestamp: "5", provider: "p", modelId: "m2" },
  ];
  const byId = new Map(tree.map((e) => [e.id as string, e]));
  check("diffLeaf: same leaf -> none", diffLeaf(byId, "d", "d").kind === "none");
  const app = diffLeaf(byId, "a", "d");
  check("diffLeaf: descendant -> append [b,c,d] oldest-first",
    app.kind === "append" && (app as { entries: AnyRec[] }).entries.map((x) => x.id).join(",") === "b,c,d");
  check("diffLeaf: non-descendant -> resync", diffLeaf(byId, "d", "e").kind === "resync");
  check("diffLeaf: unknown new leaf -> resync", diffLeaf(byId, "a", "zz").kind === "resync");
  check("diffLeaf: null last leaf -> resync", diffLeaf(byId, null, "d").kind === "resync");
}

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

// ---------- http server (fake pi api) ----------
async function httpTests(): Promise<void> {
  const entries: Record<string, unknown>[] = [
    { type: "message", id: "a", parentId: null, timestamp: "1", message: { role: "user", content: "hi" } },
    { type: "message", id: "b", parentId: "a", timestamp: "2", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ];
  const byId = new Map(entries.map((e) => [e.id as string, e]));
  const sent: string[] = [];
  let stopCalls = 0;
  const api = {
    getSnapshot: () => ({
      entries: entries.map((e) => sanitizeEntry(e) as AnyRec),
      meta: { cwd: "/tmp", model: "p/m", sessionName: null, leafId: entries.length ? entries[entries.length - 1].id as string : null },
    }),
    allEntries: () => byId,
    sendInput: async (t: string) => { sent.push(t); return { queued: true }; },
    stopAgent: () => { stopCalls++; return { aborted: true }; },
  };
  const tokens = new Set<string>();
  const ws = await startServer({ host: "127.0.0.1", port: 0, passwordHash: hashPassword("testpw123"), tokens, api });
  const base = "http://127.0.0.1:" + ws.port;
  check("server: binds to requested (ephemeral) port", ws.port > 0);

  const loginPage = await fetch(base + "/").then((r) => r.text());
  check("http: / unauthenticated serves login page", loginPage.includes('type="password"'));

  check("http: login wrong password -> 401",
    (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "wrong" }) })).status === 401);

  const good = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "testpw123" }) });
  const setCookie = good.headers.get("set-cookie") ?? "";
  check("http: login ok -> 200 + Set-Cookie", good.status === 200 && setCookie.startsWith("remote_pi_session="));
  const cookie = setCookie.split(";")[0];

  const chatPage = await fetch(base + "/", { headers: { cookie } }).then((r) => r.text());
  check("http: / with cookie serves chat page", chatPage.includes("new EventSource('/events')"));

  check("http: bad json login -> 401 (empty password)",
    (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" })).status === 401);

  // deviation: brief's `(async () => { ... })()` IIFE passes a Promise where check() takes a boolean
  // (fails tsc; truthy-promise also made the check a false positive and raced the next check).
  // Direct await, same condition.
  const inputOk = await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "hello agent" }) });
  check("http: /input ok -> 200 queued",
    inputOk.status === 200 && ((await inputOk.json()) as { queued?: boolean }).queued === true && sent[0] === "hello agent");

  check("http: /input without cookie -> 401",
    (await fetch(base + "/input", { method: "POST", body: JSON.stringify({ text: "x" }) })).status === 401);

  check("http: /input blank -> 400",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "   " }) })).status === 400);

  check("http: /input bad json -> 400",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: "{nope" })).status === 400);

  check("http: /input oversized -> 413",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "x".repeat(200000) }) })).status === 413);

  const st = await fetch(base + "/stop", { method: "POST", headers: { cookie } });
  check("http: /stop -> 200 + stopAgent called", st.status === 200 && stopCalls === 1);

  // deviation: same IIFE fix as above
  const logout = await fetch(base + "/logout", { method: "POST", headers: { cookie } });
  check("http: /logout -> 200 + clears cookie",
    logout.status === 200 && (logout.headers.get("set-cookie") ?? "").includes("Max-Age=0"));

  check("http: token invalid after logout",
    (await fetch(base + "/input", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ text: "x" }) })).status === 401);

  ws.stop();
}

await httpTests();

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);===== END: selftest.ts =====
