# pi-cockpit

Stream your pi session to a web browser. Watch the agent work from another
machine on your LAN, type messages back into it, stop the run, and answer the
agent's questions. One file; the only non-node: imports are pi's own bundled packages: `pi-tui`
(for the terminal-side question dialog) and `pi-coding-agent` (web `!` bash
execution and shell settings).

## Install

Point pi at this directory (a symlink keeps it in sync with this checkout):

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/this/directory ~/.pi/agent/extensions/pi-cockpit
```

Or copy the directory there instead. Then run `/reload` in a pi session
(restart pi if `/webserve` is not listed). There is no build step:
`node_modules` only exists for type checking, pi never loads it.

## Use

```
/webserve start          # default port 8765; tries 8766..8775 if taken
/webserve start 9000     # custom port
/webserve status
/webserve stop
```

`start` asks for a password (4+ characters) and prints the URL(s). Open one
in a browser, enter the password, and the session streams live:

- Assistant text streams token by token and renders as markdown when it
  finalizes: headings, lists, quotes, bold/code/links, and fenced code blocks
  with a copy button (links open in a new tab; only http/https/mailto URLs
  become links); tool calls render as cards with their input and output. A
  toolbar above the messages filters the tool cards (All / Errors only /
  Hidden) and can collapse or expand them all at once.
- **Thinking** — with reasoning models, the model's thinking streams dimmed
  in the live bubble and folds into a collapsed 💭 block above the finalized
  answer (click to expand).
- The message box sends real pi user messages. While the agent is busy,
  Send steers the running agent (like Enter in the terminal); while idle it
  starts a run. Messages always end up in chronological order above their
  answers, even though pi persists them a beat after the reply starts
  streaming, and the final answer renders as markdown the moment the run
  settles.
- **`! <command>` / `!! <command>`** — runs the command on the pi host (the
  machine running pi) in the session's working directory, with the same
  shell as the terminal's `!`. Output streams live into the view and is
  recorded in the session like terminal `!` output: with a single `!` the
  agent sees the output from the next turn on, with `!!` it stays hidden
  from the agent. The web has no Esc, so a command that hangs is killed
  after 10 minutes (recorded as cancelled); one command at a time.
- **Attach images** — the 📎 button, paste, or drag & drop onto the input
  (png, jpeg, webp, gif; up to 3 per message, 4 MB each). Images ride with
  the next message for vision-capable models and show as thumbnails in the
  chat.
- The message box also accepts commands: `/new` starts a new session,
  `/compact [instructions]` compacts the context, and `/model
  [provider/model-id]` switches the model (bare `/model` lists the available
  ones) — all run immediately, even while busy, and results appear as notes in
  the view.
- **Stop** in the header interrupts the run, exactly like Esc.
- **Finish notifications** — the 🔔 header button asks for notification
  permission; while the tab is hidden, each finished run pings you with the
  session name and a snippet of the last message. The tab title shows ⏳
  while a run is in progress (works everywhere, no permission needed); on
  plain-HTTP LAN pages the 🔔 button hides itself (browsers require a secure
  context for notifications) and only the ⏳ indicator remains.
- **Answer the agent's questions** — when the agent calls
  `ask_user_question` (rpiv-ask-user-question) and a browser is open, the
  questions appear in a web modal AND in the terminal; whichever answer lands
  first wins, the other surface closes, and the agent continues with it.
- The header shows session name, model, working directory, a busy indicator,
  and live context usage (`45k/200k (23%)`, same source as the terminal's
  `/context`; updates after each run and on model change). On narrow screens
  (≤640px) the cwd segment hides and the rest wraps.

The server shuts down when pi quits or on `/reload`. It survives session
replacement (`/new`, `/fork`, same-directory `/resume`) and resyncs every web
client to the new session; a cross-directory `/resume` stops it (pi re-imports
the extension there, which would otherwise orphan the server). Each pi terminal
gets its own server (8765, 8766, ...).

## Security

- Plain HTTP on `0.0.0.0`. Fine on a trusted LAN; do not expose the port to
  the internet. For remote access: `ssh -L 8765:localhost:8765 user@pi-host`.
- The password lives in memory only (SHA-256 hash) for the server's
  lifetime. Login issues a 256-bit HttpOnly cookie valid for 7 days.
- No login rate limiting (LAN assumption). Session content is sensitive;
  choose the password accordingly.

## Develop

```bash
npm install               # dev-only type deps
node selftest.ts          # 207 checks: password, tokens, sanitizer, leaf diff,
                          # input dispatch, web ! bash (parser, output cleaning, truncation +
                          # full-output file, real-shell runs, SSE streaming, session
                          # recording, agent-context injection, one-at-a-time), page JS (incl.
                          # usage/meta formatting, tab-title prefix, finish notifications,
                          # markdown rendering), HTTP protocol, live SSE, pi wiring (factory
                          # re-run across session replacement, usage refresh, /resume cwd
                          # policy), ask bridge (envelope wording, TUI component, HTTP ask
                          # flow, first-answer-wins hook wiring)
npx tsc -p tsconfig.json  # strict type check
```

`selftest.ts` runs with plain `node` and needs Node 23.6+ (native TypeScript
type stripping). For the manual browser e2e checklist, see `description.md`.

## Files

| file | role |
|---|---|
| `index.ts` | the whole extension: helpers, pages, HTTP/SSE server, pi wiring |
| `selftest.ts` | test suite, plain node with no framework |
| `description.md` | user-facing reference and e2e checklist |