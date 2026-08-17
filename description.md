# pi-cockpit

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
1. Put this directory at `~/.pi/agent/extensions/<this directory>/`
   (auto-discovered) or list it in `settings.json` under `extensions`.
   (Or install from GitHub: `pi install git:github.com/JC1DA/pi-cockpit`.)
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
- The web input box also accepts commands: `/new` starts a new session,
  `/compact [instructions]` compacts the context, and `/model [provider/model-id]`
  switches the model. Bare `/model` opens a one-click picker modal listing all
  available models (the current one marked; picking one is the same as typing
  the switch command). Commands execute immediately, even while the agent is
  busy, and results show as notes in the web view.
  Other `/`-prefixed input follows terminal semantics (skills, prompt
  templates; unknown text goes to the model as literal text).
- The **Stop** button in the web header behaves like Esc in the terminal.
- **Answering agent questions from the web** — when the agent calls
  `ask_user_question` (the rpiv-ask-user-question extension) while a web
  client is connected, the questions appear in a web modal (options, a
  `Type something.` row, optional note, live previews) AND in a minimal
  terminal overlay; whichever answer lands first wins, the other surface
  closes, and the agent continues with the answer in the tool's standard
  result wording. With no web client connected, the tool's own terminal flow
  runs unchanged. Note: pi marks blocked calls as error results internally;
  the web view renders answered/declined questionnaires without error styling.
- The header also shows live context usage as `45k/200k (23%)` — current context
  tokens / the model's context window / percent (same source as the terminal's
  `/context`). It updates after each agent run and on model change, and reads
  `—` right after `/compact` until the next assistant response. On narrow
  screens (≤640px) the working-directory segment is hidden and the rest wraps.
- The server stops when pi quits or on `/reload`. It survives session
  replacement (`/new`, `/fork`, same-directory `/resume`) and resyncs every web
  client to the new session. A cross-directory `/resume` makes pi re-import the
  extension (module cache is keyed by cwd), so the server is stopped there to
  avoid an orphaned, uncontrollable zombie.
- Multiple pi terminals each get their own server: 8765, 8766, ...

## Tests
- `npm install` (dev-only type deps), then:
  - `node selftest.ts` — unit + HTTP-protocol checks (password, tokens/cookie,
    sanitizer, leaf diff, page syntax + usage/meta formatting, full server
    against a fake pi api, ask bridge: envelope wording, TUI component,
    HTTP ask flow, tool_call hook wiring — first-answer-wins, decline,
    duplicate 409, client-left fallback).
  - `npx tsc -p tsconfig.json` — strict type check.
- Manual e2e checklist: `pi -e ./index.ts` → `/webserve start` → login in a
  browser → watch live streaming → send a message from the web (appears in the
  TUI) → `/compact` and `/new` from the web (new session shows in the view) →
  ask the agent an ambiguous question to trigger `ask_user_question` → answer
  from the web modal (agent continues with the answer; also try answering in
  the terminal, and with both open at once — first answer wins) → Stop mid-run
  → `/webserve stop` → second terminal lands on port 8766.
