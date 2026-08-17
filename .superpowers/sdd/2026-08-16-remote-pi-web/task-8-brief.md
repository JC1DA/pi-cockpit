### Task 8: `description.md`

**Files:**
- Create: `description.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Create `description.md`** with exactly this content:

```markdown
# remote-pi-ext

Browse and drive the current pi session from a web browser.

## What it does
Starts a password-protected web server that streams the current pi session
(user/assistant messages, tool calls, tool results, model changes, compaction
markers) to a browser via Server-Sent Events, so you can watch the agent work
from another machine on your LAN and type messages back into the agent.

## Commands
- `/webserve start [port]` — asks for a password (min 4 chars), starts the server
  on `0.0.0.0` (default port 8765; if taken, tries the next port, up to 10), and
  prints the URL(s) in the terminal.
- `/webserve stop` — stops the server.
- `/webserve status` — shows running/stopped and the actual port.

## Install / use
1. Put this directory at `~/.pi/agent/extensions/remote-pi-ext/`
   (auto-discovered) or list it in `settings.json` under `extensions`.
2. In a pi session: `/webserve start`, type the password, open the printed URL,
   unlock in the browser.

## Security notes
- HTTP is unencrypted: the password and all session content travel in the clear
  on your LAN. Do not expose this port to the internet. For remote access use
  `ssh -L 8765:localhost:8765 user@pi-host`.
- The password is held in memory only (as a SHA-256 hash) for as long as the
  server runs; it is never written to session files or logs.
- Login issues a random 256-bit token cookie (HttpOnly, 7 days).
- Session content is sensitive (the agent can read your code) — choose the
  password accordingly. No login rate limiting (LAN assumption).

## Behavior
- Messages sent from the web appear in the terminal exactly as if typed there.
  While the agent is busy they queue until it finishes (follow-up delivery).
- The **Stop** button in the web header behaves like Esc in the terminal.
- The server stops when the session ends (exit, /new, /resume, /reload);
  start it again with `/webserve start`.
- Multiple pi terminals each get their own server: 8765, 8766, ...

## Tests
- `npm install` (dev-only type deps), then:
  - `node selftest.ts` — unit + HTTP-protocol checks (password, tokens/cookie,
    sanitizer, leaf diff, page syntax, full server against a fake pi api).
  - `npx tsc -p tsconfig.json` — strict type check.
- Manual e2e checklist: `pi -e ./index.ts` → `/webserve start` → login in a
  browser → watch live streaming → send a message from the web (appears in the
  TUI) → Stop mid-run → `/webserve stop` → second terminal lands on port 8766.
```

- [ ] **Step 2: Gate**

Run: `node selftest.ts && npx tsc -p tsconfig.json`
Expected: all `ok`, `0 failed`, tsc silent. (Documentation change; gates must stay green.)

---

## Self-Review (performed)

1. **Spec coverage:** §3 commands → Task 7; §4 architecture/state → Tasks 5/6/7; §5 endpoints (login/input/stop/logout/SSE incl. snapshot/append/resync/update/toolstart/status/meta, body limits, auth rules) → Tasks 5/6; §6 UI → Task 4; §7 security (hash, timingSafeEqual, token cookie, 0.0.0.0, ponytail TLS/rate-limit notes) → Tasks 1/2/5/7 + description.md; §8 error table → Task 5 handler; §9 tests (selftest + manual e2e incl. two-terminal/8766) → all tasks + Task 7 Step 4 + description.md. No gaps.
2. **Placeholder scan:** every code step contains paste-ready code; the only defined interim state is Task 5's unhandled `/events` (explicitly documented as added in Task 6, no stub).
3. **Type consistency:** `WebApi`/`WebServer`/`SnapshotMeta` names and signatures used identically in Tasks 5/6/7; `sanitizeEntry`/`diffLeaf` signatures match Task 3 in all later uses; page element ids (`dot`, `meta`, `stop`, `logout`, `msgs`, `input`, `send`) consistent within CHAT_PAGE; SSE event names (`snapshot`, `append`, `resync`, `update`, `toolstart`, `status`, `meta`) identical in server, page, and spec.
```
