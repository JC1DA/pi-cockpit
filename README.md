# pi-cockpit

Stream your pi session to a web browser. Watch the agent work from another
machine on your LAN, type messages back into it, stop the run, and answer the
agent's questions. One file; the only non-node: import is pi's own bundled
`pi-tui` (for the terminal-side question dialog).

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

- Assistant text appears token by token; tool calls render as cards with
  their input and output.
- The message box sends real pi user messages. While the agent is busy they
  queue as follow-ups; while idle they start a run.
- The message box also accepts commands: `/new` starts a new session,
  `/compact [instructions]` compacts the context, and `/model
  [provider/model-id]` switches the model (bare `/model` lists the available
  ones) — all run immediately, even while busy, and results appear as notes in
  the view.
- **Stop** in the header interrupts the run, exactly like Esc.
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
node selftest.ts          # 109 checks: password, tokens, sanitizer, leaf diff,
                          # input dispatch, page JS (incl. usage/meta formatting), HTTP protocol,
                          # live SSE, pi wiring (factory re-run across session replacement,
                          # usage refresh, /resume cwd policy), ask bridge (envelope wording,
                          # TUI component, HTTP ask flow, first-answer-wins hook wiring)
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