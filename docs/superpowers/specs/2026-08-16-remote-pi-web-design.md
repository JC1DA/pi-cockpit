# Remote Pi Web — Design Spec

**Date:** 2026-08-16
**Status:** Approved in chat (user decisions: LAN binding, follow-up-when-busy, TUI-dialog password, port auto-increment)

A pi extension that starts a password-protected local web server streaming the current
pi session to a browser, with input from the browser injected as real user messages.

## 1. Purpose

Let a user watch a running pi coding session from a web browser on another device on the
LAN, and optionally steer it by typing messages from the browser. The user enables and
disables the server per session; access is gated by a password the user sets at start time.

## 2. Deliverables

```
remote_pi_ext/
├── index.ts            # the entire extension (server + event plumbing + inline web page)
├── description.md      # what the extension does, usage, security notes
└── docs/superpowers/specs/2026-08-16-remote-pi-web-design.md
```

- Single file, zero npm dependencies. Only `node:http`, `node:crypto`, `node:net`,
  `node:os` built-ins plus `@earendil-works/pi-coding-agent` types.
- No `package.json` needed.
- Install: place this directory at `~/.pi/agent/extensions/remote_pi_ext/`
  (auto-discovered as a subdirectory extension) or reference it from `settings.json`
  `extensions`.

## 3. Commands

| Command | Behavior |
|---|---|
| `/webserve start [port]` | Start the server. `port` optional, default **8765**. Prompts for a password via `ctx.ui.input("Web viewer password", "min 4 chars")`. Binds **0.0.0.0** (LAN). On success: `ctx.ui.notify` with the actual URL(s) and `ctx.ui.setStatus("webserve", "web :PORT")`. |
| `/webserve stop` | Stops the server if running; clears status. Idempotent. |
| `/webserve status` | Reports running/stopped and actual port. |

Rules:
- The server is **never** started from the extension factory (pi rule: no background
  resources from factory; it may run in invocations that never start a session).
- `/webserve start` while already running → notify "already running on port X", no-op.
- If no password is provided at the prompt (empty / cancelled) → do not start, notify.
- On `session_shutdown` the server is stopped idempotently (session-scoped resource).
  After `/new`, `/resume`, `/reload` the extension instance is fresh: the server is
  stopped and the user must `/webserve start` again. No cross-instance state.

### Port conflict handling

On `EADDRINUSE` (e.g. another pi terminal already serves the default port), retry with
`port+1`, up to **10 attempts**. The first free port is used; the notification and status
always show the **actual** port. If all 10 are taken, error-notify and stay stopped.
Multiple pi terminals = multiple servers on consecutive ports, each streaming its own
session. (Cross-session browsing in one page: future work, not v1.)

## 4. Architecture

```
pi TUI ── /webserve start ──► password dialog ──► node:http server (0.0.0.0:PORT)
   │
   │ extension instance (per session) subscribes to:
   │   message_update, message_end, tool_execution_start, tool_execution_end,
   │   agent_start, agent_settled, model_select, session_compact, session_tree,
   │   session_info_changed, session_shutdown
   ▼
browser (LAN):  GET /  → login page or chat page
                GET /events  → SSE stream
                POST /login  → password check → token cookie
                POST /input  → pi.sendUserMessage(...)
                POST /logout → drop token
```

In-memory state (never persisted to the session file):
- `passwordHash: string` — SHA-256 hex of the password set at start.
- `tokens: Set<string>` — issued login tokens.
- Per SSE client: `{ res, lastLeaf: string | null, subscribed: true }`.
- `server: http.Server | null`, `port: number | null`.
- The `ctx` of the `/webserve start` command, captured for `abort()` (and shared with
  the input path). A command ctx is session-bound: it stays valid until session
  replacement, and replacement triggers `session_shutdown`, which stops the server —
  so the captured ctx can never go stale while the server is running.

## 5. HTTP protocol

All responses JSON unless noted. Body limit **100 KB**; oversized → 413. JSON parse
errors → 400.

### Auth

- `POST /login` — body `{"password": "..."}`.
  - Password is hashed (SHA-256) and compared to `passwordHash` with
    `crypto.timingSafeEqual` (constant-time; both sides padded to equal length).
  - Success: generate `crypto.randomBytes(32).toString("hex")`, add to `tokens`,
    respond 200 with `Set-Cookie: remote_pi_session=<token>; Path=/; HttpOnly;
    SameSite=Lax; Max-Age=604800` (7 days).
  - Failure: 401 `{"error":"bad password"}`.
  - The **only** endpoint not requiring a valid token cookie.
- Every other endpoint: parse cookie `remote_pi_session`; token must be in `tokens`,
  else 401 `{"error":"unauthenticated"}` (for `GET /` → serve the login page instead,
  200).

### `GET /` — pages

- No valid cookie → **login page** (inline HTML): title, password field, submit →
  `POST /login`, on success redirect to `/`.
- Valid cookie → **chat page** (inline HTML + JS, described in §6).

### `GET /events` — SSE stream (token required)

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`. No CORS headers (same-origin only).

On connect, immediately send:
```
event: snapshot
data: {"entries":[...],"meta":{"cwd":...,"model":"provider/id","sessionName":...,"leafId":"..."}}
```
`entries` = `ctx.sessionManager.buildContextEntries()` — exactly the active,
compaction-aware branch the LLM currently sees. Each entry is passed through with only
these fields: `{type, id, timestamp, message?, summary?, provider?, modelId?,
thinkingLevel?, customType?, name?}` (shape per `session-format.md`; unknown extra
fields stripped, `message` kept intact).

Then live events, each as `event: <name>\ndata: <json>\n\n`:

| SSE event | Fired from pi event | Payload |
|---|---|---|
| `update` | `message_update` | the partial assistant message object (rendered live, token by token) |
| `append` | any entry-persisting event, when the session leaf moved forward | `{"entries":[...]}` — the new entries on the path from the client's `lastLeaf` to the new leaf |
| `resync` | leaf moved but is **not** a descendant of the client's `lastLeaf` (tree nav, resume, compaction re-root) | full `{"entries":[...],"meta":{...}}` like `snapshot`; client replaces its list |
| `toolstart` | `tool_execution_start` | `{"id":"...","name":"...","args":{...}}` (`id` = toolCallId, so the UI correlates calls with results) |
| `status` | `agent_start` / `agent_settled` | `{"busy":true|false}` |
| `meta` | `model_select` | `{"model":"provider/id"}` |

Change-detection rule: after handling any event that can persist an entry
(`message_end`, `tool_execution_end`, `model_select`, `session_compact`,
`session_tree`, `session_info_changed`), compute the session's
`getLeafId()`. Per client:
- `newLeaf === lastLeaf` → send nothing.
- `newLeaf` is a descendant of `lastLeaf` (walk `parentId` links) → send `append` with
  the entries on that path (excluding `lastLeaf` itself, including `newLeaf`), update
  `lastLeaf`.
- otherwise → send `resync`, reset `lastLeaf`.

Client disconnect (`res` close/abort) → remove from the client set. A periodic
~15s `: keep-alive` SSE comment keeps proxies from idling the connection.

**`append`/`resync` are broadcast to all connected clients.** Because `lastLeaf` is
per-client, clients that connected at different times each get the correct window.
Web-originated user messages flow through this same machinery (they persist as real
user-message entries and fire `message_start`/`message_end`), and appear in the TUI as
well. No special path for web input.

### `POST /input` (token required)

Body `{"text":"..."}` (min 1 char after trim, max 32 KB).
- If `ctx.isIdle()` → `pi.sendUserMessage(text)`.
- else → `pi.sendUserMessage(text, { deliverAs: "followUp" })` (queues until the agent
  settles; non-interrupting — chosen behavior).
- Respond `200 {"ok":true,"queued":<idle?false:true>}`. Errors (e.g. send rejected) →
  500 `{"error": msg}`.

### `POST /stop` (token required)

- If the agent is busy (`!ctx.isIdle()`) → `ctx.abort()` — the programmatic equivalent
  of Esc in the TUI: the in-flight LLM call/tool work is interrupted, the partial
  assistant message is finalized, queued follow-ups are delivered afterward, and
  `agent_settled` fires (→ `status {"busy":false}`).
- Respond `200 {"ok":true,"aborted":<was busy>}`. Idle → `{"ok":true,"aborted":false}`
  (no-op, not an error).

### `POST /logout` (token required)

Remove token from `tokens`; clear cookie (`Max-Age=0`); respond 200.

## 6. Web UI

One inline HTML page served by `GET /` (string constant in `index.ts`). Vanilla JS, no
libraries, no build step.

- **Login:** single password field; POST `/login`; on 401 show "wrong password".
- **Chat view:**
  - Header bar: session name (or "pi session"), cwd, model, busy/idle indicator dot,
    **Stop button** (visible only while busy; `POST /stop`), and a logout button.
  - Message list, top→bottom = branch order:
    - user messages: right-aligned bubble, accent background.
    - assistant messages: left-aligned, `white-space: pre-wrap`, **HTML-escaped**
      (no markdown rendering in v1 — noted future work).
    - toolResult messages: `<details>` collapsed by default, summary line
      `toolName: first line of input`, body = input + result output, error results
      highlighted red.
    - compaction entries: horizontal rule labeled "compacted (N tokens)".
    - model_change / thinking_level_change / session_info entries: dim one-line notes.
  - Live behavior:
    - on `update` (partial assistant message): show/refresh a "pending" assistant bubble
      at the bottom (replace previous pending).
    - on `append`: append new entries in order; if a pending bubble exists and the
      batch contains a `message` entry with `message.role === "assistant"`, replace the
      pending bubble with the last such entry in the batch (only one assistant message
      streams at a time, so this correlation is unambiguous).
    - on `resync`: replace the whole list.
    - on `status`: toggle busy indicator; while busy the input placeholder reads
      "message will be queued until the agent finishes…".
    - on `toolstart`: show a dim "▸ bash — running" line (final result replaces it via
      `append` when the toolResult entry lands).
  - **Input:** textarea + Send button, always enabled; Enter sends, Shift+Enter newline.
    After send, show the message optimistically in the pending area; the authoritative
    copy arrives via `append`.
  - Auto-scroll to bottom unless the user has scrolled up.
  - `EventSource("/events")` — the browser auto-reconnects; on reconnect the server
    re-sends `snapshot`, and the page re-renders from it. No custom reconnect logic.
  - Logout button in the header → `POST /logout`, then reload to the login page.

## 7. Security

- Bind: **0.0.0.0** (user-decided LAN access). Unencrypted HTTP — the password and
  session content travel in the clear on the LAN. `description.md` must state: do not
  expose this port to the internet; use an SSH tunnel for remote access.
  (`ponytail:` no TLS — add a reverse proxy in front if internet exposure is needed.)
- Password: min 4 chars enforced at the start dialog; stored only as SHA-256 in memory;
  constant-time compare. Never written to the session file, logs, or the web page.
- Tokens: 256-bit random, in-memory set, HttpOnly + SameSite=Lax cookie.
  `ponytail:` no login rate limiting — fine for LAN behind a password; add per-IP
  throttling if this is ever exposed beyond the LAN.
- Session content is sensitive (it contains everything the agent reads): that is the
  user's informed choice; the start notification reminds them of the URL/port.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Port in use (up to 10 attempts) | error-notify "ports 8765–8774 all in use", server not started |
| `listen` error other than EADDRINUSE | error-notify with `err.code`, server not started |
| Client disconnects mid-SSE | remove client; no crash |
| Malformed/too-large JSON body | 400 / 413 |
| Unauthenticated request | 401 (login page for `GET /`) |
| `sendUserMessage` throws | 500 with message; TUI notify |
| `/stop` while idle | 200 `{aborted:false}`, no-op |
| `session_shutdown` while serving | stop server, close all SSE clients |

## 9. Testing

- `selftest.ts` (run with `node selftest.ts`; Node ≥ 23.6 strips TS types natively):
  assert-based checks on the pure helpers, kept import-safe (module top-level must not
  start a server):
  1. `hashPassword`/`verifyPassword` — correct accept/reject, timing-safe path taken.
  2. Leaf change decision: same leaf → nothing; descendant → correct entry window
     (built from a small fake entry tree); non-descendant → resync decision.
  3. Token issue/validate/revoke; cookie parsing.
  4. Entry sanitizer keeps the whitelisted fields, strips others, keeps `message` intact.
- Manual e2e smoke (documented in `description.md`):
  `pi -e ./index.ts` → `/webserve start` → open the printed URL in a browser → login →
  watch live streaming (send a prompt in the TUI, see it appear) → type a message in
  the web input, see it appear in the TUI → `/webserve stop`. Second terminal:
  `/webserve start` → lands on 8766.

## 10. Non-goals (v1)

- Markdown/code rendering in the web view (escaped `pre-wrap` only).
- Multiple sessions in one browser page (cross-process session switching).
- TLS, rate limiting, image upload from the web input.
- Persisting the password or token across restarts.
- Steering (interrupting) delivery from the web — queued follow-up only.