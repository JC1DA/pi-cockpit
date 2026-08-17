# Task 1 Report: Scaffolding + password helpers

## What I implemented

Followed the task brief (`2026-08-16-remote-pi-web/task-1-brief.md`) steps in order, TDD-shaped:

1. Created `package.json` (verbatim from brief): `type: module`, `pi.extensions: ["./index.ts"]`, devDependencies `typescript ^5.5.0`, `@types/node ^22.0.0`, `@earendil-works/pi-coding-agent ^0.84.2`.
2. Created `tsconfig.json` (verbatim from brief): strict, es2022, nodenext module/resolution, noEmit, skipLibCheck, allowImportingTsExtensions, types `["node"]`, include `index.ts` + `selftest.ts`.
3. Ran `npm install` — succeeded; `node_modules/` created, `tsc` available, `package-lock.json` generated as a standard `npm install` side effect.
4. Created `selftest.ts` (verbatim from brief): 6 checks covering hash format, correct-password verify (round-trip), wrong password, length mismatch, malformed hash, empty hash.
5. RED: ran `node selftest.ts` before `index.ts` existed — failed with module-not-found, as expected.
6. Created `index.ts` (verbatim from brief): `AnyRec` type, `hashPassword` (SHA-256 hex via `node:crypto`), `verifyPassword` (constant-time `timingSafeEqual` with length guards so it never throws on malformed input).
7. GREEN: ran `node selftest.ts && npx tsc -p tsconfig.json` — all pass, exit 0.

No scope was widened: exactly the four files from the brief's Files list, verbatim content (machine-diffed against the brief's fenced code blocks: all four match byte-for-byte after trailing newline normalization). `index.ts` runtime import is `node:crypto` only, per the Global Constraints; no pi package import.

## TDD Evidence

### RED
Command: `cd /home/jc1da/Programs/LanyTek/remote_pi_ext && node selftest.ts` (after selftest.ts created, before index.ts)

Output:
```
node:internal/modules/esm/resolve:275
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/jc1da/Programs/LanyTek/remote_pi_ext/index.ts' imported from /home/jc1da/Programs/LanyTek/remote_pi_ext/selftest.ts
    at finalizeResolution (node:internal/modules/esm/resolve:275:11)
    at moduleResolve (node:internal/modules/esm/resolve:226:15)
    ...
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///home/jc1da/Programs/LanyTek/remote_pi_ext/index.ts'
}
exit=1
```
Why expected: `selftest.ts` imports from `./index.ts`, which did not exist yet; the module resolver fails before any test logic runs. Exactly the red the brief predicts.

### GREEN
Command: `cd /home/jc1da/Programs/LanyTek/remote_pi_ext && node selftest.ts && npx tsc -p tsconfig.json`

Output:
```
(node:2139525) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where this warning was created)
ok   password: hash is 64 hex chars
ok   password: correct password verifies
ok   password: wrong password rejected
ok   password: length mismatch rejected
ok   password: malformed hash rejected
ok   password: empty hash rejected

6 passed, 0 failed
exit=0
```
tsc ran as part of the same command chain and produced no output (silent = clean).

## Files changed

- `package.json` (created, verbatim)
- `tsconfig.json` (created, verbatim)
- `selftest.ts` (created, verbatim)
- `index.ts` (created, verbatim)
- `package-lock.json` (created by `npm install`, not hand-written)
- `node_modules/` (created by `npm install`)

## Self-review findings

- Implemented exactly what the brief specifies, nothing more — all four files machine-verified byte-identical to the brief's code blocks.
- Tests verify real behavior: SHA-256 round-trip (hash then verify), rejection of wrong password, length mismatch, malformed (non-hex) hash, and empty hash. The "never throws on malformed input" contract is covered by the malformed/empty checks.
- Test output is pristine with respect to code behavior (all `ok`, `0 failed`, exit 0; tsc silent). One stderr line is the Node v23 runtime `ExperimentalWarning: Type Stripping...` — emitted by Node itself for any natively-stripped .ts file, not by our code; the brief's prescribed command (`node selftest.ts`) produces it by design on this Node version.
- RED and GREEN evidence captured above.
- No git repo exists (no `.git`); no git commands run; nothing staged.

## Issues / concerns

- npm was available and `npm install` succeeded. Only output was a deprecation warning for transitive dep `node-domexception@1.0.0` (pulled in by `@earendil-works/pi-coding-agent`) — harmless, not an error.
- The `ExperimentalWarning: Type Stripping` appears on stderr of `node selftest.ts` on Node v23.11.1. It does not affect the exit code or test results and cannot be removed from the brief's verbatim command without deviating from it. Later tasks running the same command will see the same line.
- No deviations from the brief's code were needed — everything compiled and passed as written.