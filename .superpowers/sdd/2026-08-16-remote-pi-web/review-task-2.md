# Review package: review-task-2.md
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

type AnyRec = Record<string, unknown>;

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
}===== END: index.ts =====

===== FILE: selftest.ts =====
// selftest.ts — run: node selftest.ts   (Node >= 23.6, native TS type stripping)
import { hashPassword, verifyPassword, issueToken, cookieHeader, clearCookieHeader, tokenFromCookie } from "./index.ts";

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

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);===== END: selftest.ts =====
