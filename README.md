# pi-cockpit

Stream your pi session to a web browser. Watch the agent work from another
machine on your LAN, type messages back into it, and stop the run. One file,
zero runtime dependencies.

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
- **Stop** in the header interrupts the run, exactly like Esc.
- The header shows session name, model, working directory, and a busy
  indicator.

The server shuts down automatically when the session ends (`/new`, `/resume`,
exit, `/reload`). Each pi terminal gets its own server (8765, 8766, ...).

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
node selftest.ts          # 46 checks: password, tokens, sanitizer, leaf diff,
                          # page JS, full HTTP protocol, live SSE
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
| `docs/superpowers/specs/` | design spec |
| `docs/superpowers/plans/` | implementation plan |