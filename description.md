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
- The web input box also accepts commands: `/new` starts a new session and
  `/compact [instructions]` compacts the context. Commands execute immediately,
  even while the agent is busy, and results show as notes in the web view.
  Other `/`-prefixed input follows terminal semantics (skills, prompt
  templates; unknown text goes to the model as literal text).
- The **Stop** button in the web header behaves like Esc in the terminal.
- The server stops when pi quits or on `/reload`. It survives session
  replacement (`/new`, `/fork`, same-directory `/resume`) and resyncs every web
  client to the new session. A cross-directory `/resume` makes pi re-import the
  extension (module cache is keyed by cwd), so the server is stopped there to
  avoid an orphaned, uncontrollable zombie.
- Multiple pi terminals each get their own server: 8765, 8766, ...

## Tests
- `npm install` (dev-only type deps), then:
  - `node selftest.ts` — unit + HTTP-protocol checks (password, tokens/cookie,
    sanitizer, leaf diff, page syntax, full server against a fake pi api).
  - `npx tsc -p tsconfig.json` — strict type check.
- Manual e2e checklist: `pi -e ./index.ts` → `/webserve start` → login in a
  browser → watch live streaming → send a message from the web (appears in the
  TUI) → `/compact` and `/new` from the web (new session shows in the view) →
  Stop mid-run → `/webserve stop` → second terminal lands on port 8766.
