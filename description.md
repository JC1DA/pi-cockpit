# pi-cockpit

Browse and drive the current pi session from a web browser.

## What it does
Starts a password-protected web server that streams the current pi session
(user/assistant messages, tool calls, tool results, model changes, compaction
markers) to a browser via Server-Sent Events, so you can watch the agent work
from another machine on your LAN and type messages back into the agent. The
web message box also runs `! <command>` / `!! <command>` on the pi host, like
the terminal's bash mode. Assistant text renders as markdown (headings,
lists, quotes, code, links, fenced code blocks with a copy button); user
messages stay literal. When the model thinks, the reasoning streams dimmed
and folds into a collapsed block above the answer.

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
- The web view renders assistant text as markdown. While a message is
  streaming it shows as plain text and switches to rendered markdown when it
  finalizes; code blocks get a copy button (clipboard API, with an
  execCommand fallback for plain-HTTP contexts), and links open in a new
  tab (only http/https/mailto URLs become links). Reasoning models: the
  thinking streams dimmed in the pending bubble while it happens, and on
  finalize folds into a collapsed 💭 block above the answer (click to
  expand); non-reasoning models render exactly as before.
- Messages sent from the web appear in the terminal exactly as if typed there.
  While the agent is busy, Send steers the running agent (terminal Enter
  parity); while idle it starts a run. The web has no queue path — the
  terminal's alt+enter follow-up stays terminal-only. Commands keep the
  command path in both cases.
  pi 0.84.x persists each message only after its `message_end` handlers ran,
  so the web client sees the reply start streaming before the user entry is
  persisted — and for a steer the entry can even land after the reply has
  already finalized (the common case with a long first reply). The view
  records a marker (the last chat element present when the bubble was sent)
  and re-anchors the optimistic user bubble right after it when the entry
  arrives, so the bubble sits above its own answer either way, and the
  run's trailing entry is flushed at `agent_settled`, so the final answer
  finalizes as markdown immediately instead of waiting for the next
  interaction.
- **Image upload** — the **📎** button in the footer (or paste, or drag & drop
  onto the input) attaches up to 3 images (png/jpeg/webp/gif, 4 MB each) to
  the next message; they travel as base64 image-content parts through the
  same steer path and render as thumbnails in the chat (images pasted into
  the terminal render in the web view too). The selected model must be
  vision-capable for the model to see them. Images persist in the session
  file as base64 and count against the context until compaction. `/input` is
  the only route with a body cap above the spec's 100 KB (12 MB, to carry
  the images); other routes keep the 100 KB limit.
- **`! <command>` / `!! <command>` in the web message box** — the web
  equivalent of the terminal's `!` / `!!`: the command runs on the pi host
  in the session's working directory, in the user's shell (settings
  `shellPath` and `shellCommandPrefix`, exactly like the terminal), with pi's
  own bash machinery (same spawn/env/process-tree handling as the agent's
  bash tool). Output streams live into the view (up to 200 KB shown), and
  on completion a `bashExecution` entry is recorded in the session file in
  pi's own format (tail-truncated at 50 KB / 2000 lines, overflow captured
  to a temp file). A single `!` makes the output visible to the agent from
  the next LLM request on (via pi's `context` hook; `!!` stays invisible,
  same as the terminal), and the entry persists across restarts and shows
  to other web clients. Bare `!` (no command) is sent as a normal message,
  matching the terminal. The bang line itself never becomes a chat bubble —
  pi records no user entry for it (only the `bashExecution` entry), so the
  live bash card is its only representation (TUI parity); a bubble would have
  no entry to anchor to and would have stuck pinned at the bottom. One bash
  command at a time: a second one while a
  command runs is rejected with a note (the terminal has the same rule). The
  web has no Esc, so a hung command is killed after 10 minutes and recorded
  as cancelled. Terminal `!` / `!!` behavior is unchanged. This is the one
  feature that imports `@earendil-works/pi-coding-agent` at runtime (for the
  bash machinery); like the rest of the extension it targets pi 0.84.x. Known
  v1 limitation: a web `!` running while a terminal resync happens is not
  shown as a live card in the terminal (its entry lands there on the next
  sync).
- The web input box also accepts commands: `/new` starts a new session,
  `/compact [instructions]` compacts the context, `/model [provider/model-id]`
  switches the model, and `/tree [entry-id]` jumps to a previous point in the
  session tree. Bare `/model` opens a one-click picker modal of all available
  models; bare `/tree` opens a one-click picker of the session's user messages
  (the current leaf marked; picking one is the same as typing the command).
  Commands execute immediately, even while the agent is busy. In the web view
  each command shows as a solid user bubble in place (pi records no user entry
  for registered commands, so there is nothing to re-anchor) with its results
  as notes directly below it.
  Other `/`-prefixed input follows terminal semantics (skills, prompt
  templates; unknown text goes to the model as literal text).
- The **Stop** button in the web header behaves like Esc in the terminal.
- **Finish notifications** — the **🔔** button in the web header asks for
  browser notification permission (click again to toggle off; the state is
  remembered per browser via localStorage). While the tab is hidden, each
  finished run fires a browser notification with the session name and a 150-char
  snippet of the last assistant message; clicking the notification refocuses
  the tab. The tab title always shows an ⏳ prefix while a run is in progress
  (no permission needed). Browsers gate the Notification API behind a secure
  context, so on plain-HTTP LAN pages the 🔔 button hides itself and only the
  ⏳ title indicator is available; via `ssh -L` (localhost) or HTTPS it works
  fully.
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
- **Tool-output toolbar** — a thin bar above the messages has a filter
  dropdown (`All` / `Errors only` / `Hidden`) and a `Collapse all` toggle. The
  filter is a single body class that CSS uses to gate every tool card (current
  and future) — `Hidden` leaves only user/assistant text, `Errors only` shows
  only errored calls — and the choice is remembered per-browser in
  localStorage. `Collapse all` / `Expand all` opens or closes every tool card
  at once; individual cards stay click-to-expand regardless of the filter.
- The server stops when pi quits or on `/reload`. It survives session
  replacement (`/new`, `/fork`, same-directory `/resume`) and resyncs every web
  client to the new session. A cross-directory `/resume` makes pi re-import the
  extension (module cache is keyed by cwd), so the server is stopped there to
  avoid an orphaned, uncontrollable zombie.
- Multiple pi terminals each get their own server: 8765, 8766, ...

## Tests
- `npm install` (dev-only type deps), then:
  - `node selftest.ts` — 207 unit + HTTP-protocol checks (password,
    tokens/cookie, sanitizer, leaf diff, page syntax + usage/meta formatting,
    tab-title ⏳ prefix, finish-notification decision matrix, image upload:
    /input size caps + MIME/count validation, page attach UI, thinking stream
    + collapsed finalize, web ! bash: parser, output cleaning, tail
    truncation + full-output temp file, real-shell runs, SSE streaming,
    session recording, agent-context injection, one-at-a-time, full server
    against a fake pi api, ask bridge: envelope wording, TUI component,
    HTTP ask flow, tool_call hook wiring — first-answer-wins, decline,
    duplicate 409, client-left fallback, agent_settled trailing-entry flush,
    web-client ordering under the pi persist-after-emit contract, run by
    driving the real page script in a DOM stub).
  - `npx tsc -p tsconfig.json` — strict type check.
- Manual e2e checklist: `pi -e ./index.ts` → `/webserve start` → login in a
  browser → watch live streaming → send a message from the web (appears in the
  TUI) → `! ls` and `!! env` from the web (output streams live into the view;
  `! ls` output is in the agent's next context, `!! env` is not) →
  attach an image (📎, paste, or drag & drop) and send it (thumbnail
  shows in the view; the model sees it if vision-capable) → with a
  reasoning model at thinking level ≥ low, watch the dimmed thinking stream
  and the collapsed 💭 block on the finalized answer → `/compact` and
  `/new` from the web (new session shows in the view) →
  ask the agent an ambiguous question to trigger `ask_user_question` → answer
  from the web modal (agent continues with the answer; also try answering in
  the terminal, and with both open at once — first answer wins) → click 🔔
  (allow), send a message, and hide the tab — a notification arrives when the
  run finishes (on plain-HTTP LAN the 🔔 is hidden; instead the tab title
  shows ⏳ while busy) → Stop mid-run → `/webserve stop` → second terminal
  lands on port 8766.
