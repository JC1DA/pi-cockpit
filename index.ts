/**
 * remote-pi-ext — browse and drive the current pi session from a web browser.
 *
 *   /webserve start [port]   (default 8765) — asks for a password, serves the session
 *   /webserve stop
 *   /webserve status
 *
 * Zero external runtime dependencies: node:http + node:crypto + node:os + node:fs,
 * plus pi's own bundled @earendil-works/pi-tui (matchesKey/visibleWidth) for the
 * terminal-side questionnaire of the ask bridge. The pi-coding-agent import is
 * type-only (erased at runtime).
 */
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { closeSync, openSync, readSync } from "node:fs";

export type AnyRec = Record<string, unknown>;

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
}

// ---------------------------------------------------------------------------
// Entry sanitizer (spec §5: strip everything except what the web view needs)
// ---------------------------------------------------------------------------

const ENTRY_FIELDS: Record<string, string[]> = {
  message: ["type", "id", "timestamp", "message"],
  compaction: ["type", "id", "timestamp", "summary", "tokensBefore"],
  branch_summary: ["type", "id", "timestamp", "fromId", "summary"],
  model_change: ["type", "id", "timestamp", "provider", "modelId"],
  thinking_level_change: ["type", "id", "timestamp", "thinkingLevel"],
  session_info: ["type", "id", "timestamp", "name"],
  custom_message: ["type", "id", "timestamp", "customType", "content", "display"],
  custom: ["type", "id", "timestamp", "customType", "data"],
  label: ["type", "id", "timestamp", "targetId", "label"],
};

/** Whitelist one entry's fields. `parentId` is never sent; unknown types -> null. */
export function sanitizeEntry(e: AnyRec): AnyRec | null {
  const fields = ENTRY_FIELDS[e.type as string];
  if (!fields) return null;
  const out: AnyRec = {};
  for (const f of fields) {
    if (e[f] !== undefined) out[f] = e[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leaf diff (spec §5 streaming protocol: append vs resync per client)
// ---------------------------------------------------------------------------

export type LeafDiff =
  | { kind: "none" }
  | { kind: "append"; entries: AnyRec[] } // raw entries, oldest-first, excludes lastLeaf
  | { kind: "resync" };                   // caller sends a full snapshot

/**
 * Decide what one SSE client needs when the session leaf moved from
 * `lastLeaf` to `newLeaf`. Walks parentId links from newLeaf back to lastLeaf;
 * any break in the chain (tree nav, resume, compaction re-root, unknown id)
 * means the client must resync. A 100k-step guard defeats pathological cycles.
 */
export function diffLeaf(
  byId: Map<string, AnyRec>,
  lastLeaf: string | null,
  newLeaf: string | null,
): LeafDiff {
  if (!newLeaf || newLeaf === lastLeaf) return { kind: "none" };
  if (!lastLeaf) return { kind: "resync" };
  const path: AnyRec[] = [];
  let cur: string | null = newLeaf;
  let guard = 0;
  while (cur !== lastLeaf) {
    const e = byId.get(cur);
    if (!e) return { kind: "resync" };
    path.push(e);
    cur = (e.parentId as string | null) ?? null;
    if (cur === null) return { kind: "resync" };
    if (++guard > 100000) return { kind: "resync" };
  }
  path.reverse();
  return { kind: "append", entries: path };
}

// Delivery options for user input (TUI parity). "/" input keeps the proven
// command path: registered commands execute immediately (even while streaming),
// skills/prompt templates expand, delivery is followUp while busy. Chat
// messages are delivered with the given mode: the web's Send steers the
// running agent like the terminal's Enter, while "followUp" (available via
// the /input API) queues until the agent finishes. Idle = direct delivery.
export function inputOpts(text: string, idle: boolean, mode: "steer" | "followUp" = "steer"): { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean } {
  const cmd = text.startsWith("/");
  return {
    deliverAs: idle ? undefined : cmd ? "followUp" : mode,
    expandPromptTemplates: cmd,
  };
}

/** One-line preview of a message entry's text (whitespace-collapsed, capped) for the /tree picker. */
export function entryPreview(e: AnyRec): string {
  const c = (e.message as AnyRec | undefined)?.content;
  let t = "";
  if (typeof c === "string") t = c;
  else if (Array.isArray(c)) t = c.map((b) => (b && typeof (b as AnyRec).text === "string" ? (b as AnyRec).text : "")).join(" ");
  return t.replace(/\s+/g, " ").trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// ask_user_question bridge — answer the agent's questions from the web
// ---------------------------------------------------------------------------
// The rpiv-ask-user-question extension's tool blocks on a terminal TUI
// overlay. This bridge intercepts the tool call (pi's tool_call hook, which
// runs before the tool executes and can short-circuit it with a result the
// model sees), shows the questions in the web viewer AND in a minimal
// terminal overlay, and feeds whichever answer arrives first back as the
// tool's result text — word-for-word the wording the tool itself produces.
// When no web client is connected the hook stays out of the way and the
// tool's own (richer) TUI flow runs unchanged.
// ---------------------------------------------------------------------------

export interface AskOption {
  label: string;
  description?: string;
  /** Capped at PREVIEW_LIMIT when forwarded to the web (keeps SSE payloads sane). */
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface AskAnswer {
  index: number; // question index
  kind: "option" | "custom" | "multi";
  answer?: string | null; // option label or typed text; null for multi
  selected?: string[]; // chosen labels (multi only)
  notes?: string;
}

export interface AskOutcome {
  cancelled: boolean;
  answers: AskAnswer[];
}

/** Option labels the rpiv tool rejects at runtime; we let its own validator report those. */
export const ASK_RESERVED_LABELS = ["Other", "Type something.", "Next"];

const PREVIEW_LIMIT = 2000;

/** Normalize raw `event.input.questions` into AskQuestion[]. null = malformed. */
export function extractAskQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof (q as AnyRec).question !== "string") return null;
    const optsRaw = (q as AnyRec).options;
    if (!Array.isArray(optsRaw) || optsRaw.length < 2 || optsRaw.length > 4) return null;
    const options: AskOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof (o as AnyRec).label !== "string" || typeof (o as AnyRec).description !== "string") return null;
      const opt: AskOption = { label: (o as AnyRec).label as string, description: (o as AnyRec).description as string };
      if (typeof (o as AnyRec).preview === "string") opt.preview = ((o as AnyRec).preview as string).slice(0, PREVIEW_LIMIT);
      options.push(opt);
    }
    const outQ: AskQuestion = { question: (q as AnyRec).question as string, options };
    if (typeof (q as AnyRec).header === "string") outQ.header = (q as AnyRec).header as string;
    if (typeof (q as AnyRec).multiSelect === "boolean") outQ.multiSelect = (q as AnyRec).multiSelect as boolean;
    out.push(outQ);
  }
  return out;
}

const ASK_DECLINE = "User declined to answer questions";
const ASK_NO_INPUT = "(no input)";

/**
 * Build the tool result text for an outcome — word-for-word what
 * rpiv-ask-user-question returns for the same answers (the agent is
 * conditioned on this wording, so it must match exactly; pinned by selftest).
 */
export function buildAskEnvelope(questions: AskQuestion[], outcome: AskOutcome): string {
  if (outcome.cancelled) return ASK_DECLINE;
  const segs: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const a = outcome.answers.find((x) => x.index === i);
    if (!a) continue; // partial submission: unanswered questions contribute no segment
    const scalar = a.kind === "multi"
      ? (a.selected && a.selected.length > 0 ? a.selected.join(", ") : ASK_NO_INPUT)
      : (a.answer && a.answer.length > 0 ? a.answer : ASK_NO_INPUT);
    const parts = ['"' + questions[i].question + '"="' + scalar + '"'];
    if (a.notes && a.notes.length > 0) parts.push("user notes: " + a.notes);
    segs.push(parts.join(". ") + ".");
  }
  if (segs.length === 0) return ASK_DECLINE;
  return "User has answered your questions: " + segs.join(" ") + " You can now continue with the user's answers in mind.";
}

// --- Minimal terminal questionnaire (terminal side of the bridge) ---

function fitText(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  const chars = [...s];
  while (chars.length > 0 && visibleWidth(chars.join("")) > max) chars.pop();
  return chars.join("");
}

function wrapText(s: string, max: number, maxLines = 3): string[] {
  const out: string[] = [];
  let line = "";
  const breakLine = (next: string): void => {
    const sp = line.lastIndexOf(" ");
    if (sp > 0 && sp < line.length - 1) {
      out.push(line.slice(0, sp));
      line = line.slice(sp + 1) + next;
    } else {
      if (line) out.push(fitText(line, max));
      line = fitText(next, max);
    }
    if (out.length > maxLines) {
      out.length = maxLines;
      const last = out[maxLines - 1];
      out[maxLines - 1] = fitText(last.endsWith("…") ? last : last + "…", max);
    }
  };
  for (const ch of s) {
    if (visibleWidth(line + ch) > max) breakLine(ch);
    else line += ch;
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}

function boxTop(title: string, inner: number): string {
  const label = " " + title + " ";
  return "┌─" + label + "─".repeat(Math.max(0, inner - visibleWidth(label) - 1));
}

function boxLine(content: string, inner: number): string {
  const body = fitText(content, inner);
  return "│" + body + " ".repeat(Math.max(0, inner - visibleWidth(body))) + "│";
}

function boxBottom(inner: number): string {
  return "└" + "─".repeat(inner - 1);
}

/**
 * One-question-at-a-time terminal questionnaire. ↑/↓ move, Enter picks
 * (single-select) or advances (multi-select), Space toggles (multi-select),
 * the "Type something." row takes free text, Esc cancels the whole thing.
 * `done(outcome)` answers; `done(null)` (via close()) means "no answer, the
 * web side won" — the overlay hides either way.
 */
export class AskTuiComponent implements Component {
  private questions: AskQuestion[];
  private tui: { requestRender(): void };
  private done: (o: AskOutcome | null) => void;
  private qIndex = 0;
  private cursor = 0;
  private mode: "list" | "type" = "list";
  private draft = "";
  private selected: boolean[];
  private answers: AskAnswer[] = [];
  private settled = false;

  constructor(questions: AskQuestion[], tui: { requestRender(): void }, done: (o: AskOutcome | null) => void) {
    this.questions = questions;
    this.tui = tui;
    this.done = done;
    this.selected = new Array(this.questions[0].options.length).fill(false);
  }

  invalidate(): void { this.rerender(); }
  dispose(): void { /* nothing to release */ }

  render(width: number): string[] {
    const q = this.questions[this.qIndex];
    const inner = Math.max(24, Math.min(width, 80) - 2);
    const lines: string[] = [];
    lines.push(boxTop("Ask you (" + (this.qIndex + 1) + "/" + this.questions.length + ")", inner));
    for (const l of wrapText(q.question, inner)) lines.push(boxLine(l, inner));
    lines.push(boxLine("", inner));
    q.options.forEach((o, i) => {
      const mark = this.mode === "list" && this.cursor === i ? ">" : " ";
      const check = q.multiSelect ? (this.selected[i] ? "x" : " ") : " ";
      const text = o.label + (o.description ? " — " + o.description : "");
      lines.push(boxLine(" " + mark + " " + check + " " + (i + 1) + ". " + text, inner));
    });
    const cmark = this.mode === "list" && this.cursor === q.options.length ? ">" : " ";
    lines.push(boxLine(" " + cmark + "     " + ASK_RESERVED_LABELS[1], inner));
    if (this.mode === "type") lines.push(boxLine("    > " + this.draft, inner));
    lines.push(boxLine("", inner));
    const hint = q.multiSelect ? "↑/↓ move  Space toggle  Enter next  Esc cancel" : "↑/↓ move  Enter pick  Esc cancel";
    lines.push(boxLine(hint, inner));
    lines.push(boxBottom(inner));
    return lines;
  }

  handleInput(data: string): void {
    if (this.settled) return;
    const q = this.questions[this.qIndex];
    if (matchesKey(data, "escape")) { this.finish(true); return; }
    if (this.mode === "type") {
      if (matchesKey(data, "enter")) {
        const text = this.draft.trim();
        this.answers.push({ index: this.qIndex, kind: "custom", answer: text.length > 0 ? text : null });
        this.advance();
        return;
      }
      if (matchesKey(data, "backspace")) { this.draft = this.draft.slice(0, -1); this.rerender(); return; }
      if (matchesKey(data, "ctrl+u")) { this.draft = ""; this.rerender(); return; }
      if (data.length === 1 && data >= " " && data <= "\u007e") { this.draft += data; this.rerender(); } // space is a normal char here
      return;
    }
    const rows = q.options.length + 1;
    if (matchesKey(data, "up")) { this.cursor = (this.cursor + rows - 1) % rows; this.rerender(); return; }
    if (matchesKey(data, "down")) { this.cursor = (this.cursor + 1) % rows; this.rerender(); return; }
    if (matchesKey(data, "space")) {
      if (q.multiSelect && this.cursor < q.options.length) { this.selected[this.cursor] = !this.selected[this.cursor]; this.rerender(); }
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.cursor < q.options.length) {
        if (q.multiSelect) {
          this.answers.push({ index: this.qIndex, kind: "multi", answer: null, selected: q.options.filter((_, i) => this.selected[i]).map((o) => o.label) });
          this.advance();
        } else {
          this.answers.push({ index: this.qIndex, kind: "option", answer: q.options[this.cursor].label });
          this.advance();
        }
      } else {
        this.mode = "type";
        this.draft = "";
        this.rerender();
      }
    }
  }

  private rerender(): void { if (!this.settled) this.tui.requestRender(); }

  private advance(): void {
    this.mode = "list";
    this.draft = "";
    this.cursor = 0;
    this.qIndex++;
    if (this.qIndex >= this.questions.length) this.finish(false);
    else {
      this.selected = new Array(this.questions[this.qIndex].options.length).fill(false);
      this.rerender();
    }
  }

  private finish(cancelled: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.tui.requestRender();
    this.done({ cancelled, answers: this.answers });
  }

  /**
   * Close without an answer (the web side won). done(null) = "not an answer".
   * ponytail: pi's hideOverlay() pops the TOPMOST overlay — if the user stacked
   * another overlay over ours, it gets popped instead (same structure as the
   * rpiv-ask-user-question overlay; no per-overlay close API exists).
   */
  close(): void {
    if (this.settled) return;
    this.settled = true;
    this.tui.requestRender();
    this.done(null);
  }
}

// ---------------------------------------------------------------------------
// Pages (spec §6). No backticks / ${...} inside page JS — they nest in
// template literals below.
// ---------------------------------------------------------------------------

export const LOGIN_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi remote — login</title>
<style>
body{background:#111;color:#e5e5e5;font:15px ui-monospace,SFMono-Regular,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#1c1c1e;padding:28px;border-radius:12px;display:flex;flex-direction:column;gap:12px;width:280px}
h1{font-size:16px;margin:0}
input{background:#111;border:1px solid #444;color:#e5e5e5;padding:8px;border-radius:8px;font:inherit}
button{background:#2563eb;color:#fff;border:0;padding:8px;border-radius:8px;cursor:pointer;font:inherit}
.err{color:#f87171;font-size:13px;min-height:16px}
</style>
</head>
<body>
<form id="f">
<h1>pi session viewer</h1>
<input id="pw" type="password" placeholder="password" autofocus>
<button>Unlock</button>
<div class="err" id="err"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value })
  }).then(function (r) {
    if (r.ok) { location.reload(); }
    else { document.getElementById('err').textContent = 'wrong password'; }
  });
});
</script>
</body>
</html>`;

export const CHAT_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi session</title>
<style>
:root{--bg:#111;--panel:#1c1c1e;--user:#2563eb;--asst:#26262c;--tool:#1a1a1c;--text:#e5e5e5;--dim:#8a8a8a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,monospace;display:flex;flex-direction:column;height:100vh}
header{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--panel);border-bottom:1px solid #333}
header .dot{width:9px;height:9px;border-radius:50%;background:#4ade80;flex:none}
header .dot.busy{background:#facc15}
header .meta{display:flex;align-items:baseline;color:var(--dim);font-size:12px;overflow:hidden;white-space:nowrap}
header .meta .m::before{content:'·';margin:0 8px;color:#555}
header .meta .m:first-child::before{content:none;margin:0}
@media (max-width:640px){header .meta{flex-wrap:wrap}header .meta .m{white-space:normal}header .meta .m-cwd{display:none}}
header button{background:none;border:1px solid #555;color:var(--text);padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit}
header button#stop{display:none;border-color:#b91c1c}
header button#stop.show{display:inline-block}
header button#notif{opacity:.45}
header button#notif.on{opacity:1;border-color:#60a5fa}
#msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--user)}
.msg.assistant{align-self:flex-start;background:var(--asst)}
.msg.pending{opacity:.7;border:1px dashed #555}
.msg.pendinguser{opacity:.7;border:1px dashed #555;align-self:flex-end}
.msg.md{white-space:normal}
.msg.md p{margin:0 0 6px}
.msg.md p:last-child{margin-bottom:0}
.msg.md h1,.msg.md h2,.msg.md h3,.msg.md h4{margin:8px 0 4px;font-size:1.05em;font-weight:700}
.msg.md ul,.msg.md ol{margin:0 0 6px;padding-left:20px}
.msg.md li{margin:1px 0}
.msg.md blockquote{margin:0 0 6px;padding:2px 0 2px 10px;border-left:3px solid #444;color:var(--dim)}
.msg.md code{background:#0d0d0f;border:1px solid #333;border-radius:4px;padding:0 4px;font-size:12px}
.msg.md pre{margin:0;padding:8px;background:#0d0d0f;border:1px solid #333;border-radius:6px;white-space:pre-wrap;font-size:12px;color:#c8c8c8}
.msg.md a{color:#60a5fa}
.msg.md .codebox{position:relative;margin:0 0 6px}
.msg.md .codebox:last-child{margin-bottom:0}
.msg.md .clang{position:absolute;top:4px;left:8px;color:#555;font-size:11px}
.msg.md .copybtn{position:absolute;top:4px;right:4px;background:#2a2a30;border:1px solid #444;color:var(--dim);border-radius:4px;padding:1px 6px;font-size:11px;cursor:pointer}
.msg.md .copybtn:hover{color:var(--text)}
details.tool{align-self:flex-start;max-width:85%;background:var(--tool);border:1px solid #333;border-radius:8px;padding:4px 8px}
details.tool.err{border-color:#b91c1c}
details.tool summary{cursor:pointer;color:var(--dim);font-size:12px}
details.tool pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;color:#c8c8c8}
.note{align-self:center;color:var(--dim);font-size:12px;white-space:pre-wrap}
footer{display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:var(--panel);border-top:1px solid #333}
#attrow{display:flex;gap:8px}
#attstrip{display:none;gap:8px;flex-wrap:wrap}
.att{position:relative;flex:none}
.att img{width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #444}
.attx{position:absolute;top:-6px;right:-6px;width:16px;height:16px;border-radius:50%;background:#dc2626;color:#fff;font-size:11px;line-height:16px;text-align:center;cursor:pointer}
footer button#attach{background:#374151;padding:0 12px}
.msg img.attimg{display:block;max-width:240px;max-height:200px;border-radius:6px;margin:6px 0 0}
footer textarea{flex:1;resize:none;height:56px;background:#111;color:var(--text);border:1px solid #444;border-radius:8px;padding:8px;font:inherit}
footer button{background:var(--user);color:#fff;border:0;border-radius:8px;padding:0 16px;cursor:pointer;font:inherit}
#askmask,#modelmask,#treemask{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:50;display:none;align-items:flex-end;justify-content:center}
#askmask.open,#modelmask.open,#treemask.open{display:flex}
.askbox{background:var(--panel);border:1px solid #444;border-radius:12px;width:100%;max-width:640px;max-height:85vh;overflow-y:auto;padding:14px}
.asktitle{font-size:13px;color:var(--dim);margin:0 0 10px}
.askq{margin:12px 0;padding:10px;background:#161618;border:1px solid #2a2a30;border-radius:8px}
.qchip{display:inline-block;background:#2a2a30;border-radius:4px;padding:1px 6px;font-size:11px;color:#9ca3af;margin-right:6px}
.qtext{font-size:13px}
.askopt{display:flex;gap:8px;align-items:flex-start;padding:4px 6px;border-radius:6px;cursor:pointer}
.askopt:hover{background:#22222a}
.askopt input{margin-top:3px}
.olabel{font-size:13px}
.odesc{font-size:12px;color:var(--dim)}
.askcustom{margin-top:8px}
.askcustom input{width:100%;background:#111;border:1px solid #444;color:var(--text);padding:6px;border-radius:6px;font:inherit}
.askpreview{margin-top:6px;background:#0d0d0f;border:1px solid #333;border-radius:6px;padding:8px;white-space:pre-wrap;font-size:12px;color:#c8c8c8;max-height:180px;overflow-y:auto;display:none}
.askbtns{display:flex;gap:8px;margin-top:12px}
.askbtns button{flex:1;background:var(--user);color:#fff;border:0;border-radius:8px;padding:8px;cursor:pointer;font:inherit}
.askbtns .askcancel{background:#374151}
</style>
</head>
<body>
<header>
<div class="dot" id="dot"></div>
<span class="meta" id="meta"></span>
<button id="notif" title="Ping when a run finishes (tab must stay open)">🔔</button>
<button id="stop">Stop</button>
<button id="logout">Logout</button>
</header>
<div id="msgs"></div>
<footer>
<div id="attstrip"></div>
<div id="attrow">
<textarea id="input" placeholder="Message..."></textarea>
<button id="attach" title="Attach images: png, jpeg, webp, gif — up to 4 MB each, 3 per message. Paste or drop also works.">📎</button>
<button id="send">Send</button>
<input type="file" id="attachfile" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
</div>
</footer>
<script>
var msgs = document.getElementById('msgs'),
    input = document.getElementById('input'),
    dot = document.getElementById('dot'),
    metaEl = document.getElementById('meta'),
    stopBtn = document.getElementById('stop');
var curMeta = {}, pendingEl = null, userQ = [];
var busy = false, notifOn = false;

// --- image attachments: 📎 button, paste, or drag & drop onto the input ---
var attachBtn = document.getElementById('attach'),
    attachFile = document.getElementById('attachfile'),
    attStrip = document.getElementById('attstrip');
var attachments = []; // {data, mimeType} base64 images waiting to be sent
var IMG_TYPES = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/gif': 1 };
function imgThumbs(parts) {
  // whitelisted mime types only: the value goes into an img src attribute
  var h = '';
  (parts || []).forEach(function (p) {
    var s = p && p.data && IMG_TYPES[p.mimeType] ? 'data:' + p.mimeType + ';base64,' + p.data : '';
    if (s) h += '<img class="attimg" src="' + s + '">';
  });
  return h;
}
function renderAtt() {
  attStrip.innerHTML = '';
  attachments.forEach(function (a, i) {
    var d = document.createElement('div');
    d.className = 'att';
    var img = document.createElement('img');
    img.src = 'data:' + a.mimeType + ';base64,' + a.data;
    var x = document.createElement('span');
    x.className = 'attx';
    x.textContent = '×';
    x.onclick = function () { attachments.splice(i, 1); renderAtt(); };
    d.appendChild(img);
    d.appendChild(x);
    attStrip.appendChild(d);
  });
  attStrip.style.display = attachments.length ? 'flex' : 'none';
}
function addFiles(files) {
  Array.prototype.slice.call(files || []).forEach(function (f) {
    if (!IMG_TYPES[f.type]) { alert('unsupported image type: ' + f.type); return; }
    if (f.size > 4 * 1024 * 1024) { alert('image too large (max 4 MB): ' + (f.name || f.type)); return; }
    if (attachments.length >= 3) { alert('max 3 images per message'); return; }
    var r = new FileReader();
    r.onload = function () {
      var u = String(r.result);
      attachments.push({ data: u.slice(u.indexOf(',') + 1), mimeType: f.type });
      renderAtt();
    };
    r.readAsDataURL(f);
  });
}
attachBtn.addEventListener('click', function () { attachFile.value = ''; attachFile.click(); });
attachFile.addEventListener('change', function () { if (attachFile.files.length) addFiles(attachFile.files); });
input.addEventListener('paste', function (e) {
  var fs = e.clipboardData && e.clipboardData.files;
  if (fs && fs.length) { e.preventDefault(); addFiles(fs); }
});
input.addEventListener('dragover', function (e) { e.preventDefault(); });
input.addEventListener('drop', function (e) {
  e.preventDefault();
  var fs = e.dataTransfer && e.dataTransfer.files;
  if (fs && fs.length) addFiles(fs);
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function autoScroll() {
  if (msgs.scrollTop + msgs.clientHeight > msgs.scrollHeight - 80) msgs.scrollTop = msgs.scrollHeight;
}
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(function (x) { return x && x.type === 'text'; })
    .map(function (x) { return x.text || ''; }).join('');
  return '';
}
// --- markdown rendering for assistant text (applied on finalize, not per
// token — half-closed fences would flicker while streaming) ---
// esc() runs first, so model output can never inject HTML; the only tags in
// the result are the ones we add. Backticks are matched via double-backslash
// unicode escapes because this page lives in a TS template literal and must
// not contain raw backticks.
function mdInline(t) {
  var codes = [];
  t = t.replace(/\\u0060([^\\u0060]+)\\u0060/g, function (m, c) {
    codes.push(c);
    return "\\x00C" + (codes.length - 1) + "\\x00";
  });
  t = t.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\\*([^*\\s][^*\\n]*)\\*(?!\\*)/g, "$1<em>$2</em>");
  t = t.replace(/\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)/g, function (m, text, url) {
    if (/^https?:\\/\\//.test(url) || /^mailto:/.test(url)) return '<a href="' + url + '" target="_blank" rel="noopener">' + text + "</a>";
    return m;
  });
  return t.replace(/\\x00C(\\d+)\\x00/g, function (m, i) { return "<code>" + codes[Number(i)] + "</code>"; });
}
function md(src) {
  var fenceRe = /^ {0,3}\\u0060{3}(\\w*)\\s*$/;
  var headRe = /^ {0,3}(#{1,4}) +(.*)$/;
  var quoteRe = /^ {0,3}&gt; ?(.*)$/;
  var ulRe = /^ {0,3}[-*+] +(.*)$/;
  var olRe = /^ {0,3}\\d+\\. +(.*)$/;
  var lines = esc(src).split("\\n");
  var out = [];
  var para = [];
  var list = null;
  var items = [];
  var quote = [];
  var code = null;
  function codeHtml(c) {
    var lang = c.lang ? '<span class="clang">' + c.lang + "</span>" : "";
    return '<div class="codebox">' + lang + '<button type="button" class="copybtn">copy</button><pre>' + c.lines.join("\\n") + "</pre></div>";
  }
  function flushPara() {
    if (para.length > 0) { out.push("<p>" + para.map(mdInline).join("<br>") + "</p>"); para = []; }
  }
  function flushList() {
    if (list === null) return;
    out.push("<" + list + ">" + items.map(function (x) { return "<li>" + mdInline(x) + "</li>"; }).join("") + "</" + list + ">");
    list = null;
    items = [];
  }
  function flushQuote() {
    if (quote.length > 0) { out.push("<blockquote>" + quote.map(mdInline).join("<br>") + "</blockquote>"); quote = []; }
  }
  function flushAll() { flushPara(); flushList(); flushQuote(); }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].replace(/\\r$/, "");
    if (code) {
      if (fenceRe.test(ln)) { out.push(codeHtml(code)); code = null; }
      else code.lines.push(ln);
      continue;
    }
    var m = fenceRe.exec(ln);
    if (m) { flushAll(); code = { lang: m[1] || "", lines: [] }; continue; }
    if (ln.replace(/\\s/g, "") === "") { flushAll(); continue; }
    m = headRe.exec(ln);
    if (m) { flushAll(); var lvl = m[1].length; out.push("<h" + lvl + ">" + mdInline(m[2]) + "</h" + lvl + ">"); continue; }
    m = quoteRe.exec(ln);
    if (m) { flushPara(); flushList(); quote.push(m[1]); continue; }
    m = ulRe.exec(ln);
    if (m) { flushPara(); flushQuote(); if (list !== "ul") { flushList(); list = "ul"; } items.push(m[1]); continue; }
    m = olRe.exec(ln);
    if (m) { flushPara(); flushQuote(); if (list !== "ol") { flushList(); list = "ol"; } items.push(m[1]); continue; }
    flushQuote(); flushList();
    para.push(ln);
  }
  if (code) out.push(codeHtml(code));
  flushAll();
  return out.join("");
}
function addMsg(role, html, cls) {
  var d = document.createElement('div');
  d.className = 'msg ' + role + (cls ? ' ' + cls : '');
  d.innerHTML = html;
  msgs.appendChild(d);
  autoScroll();
  return d;
}
function tail(el) {
  // append at the true end, i.e. before any dashed queued-user bubbles
  var q = userQ.length ? userQ[0].el : null;
  if (q) msgs.insertBefore(el, q); else msgs.appendChild(el);
  autoScroll();
  return el;
}
function addNote(t) {
  var d = document.createElement('div');
  d.className = 'note';
  d.textContent = t;
  msgs.appendChild(d);
  autoScroll();
}
function fmtTok(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1).replace(".0", "") + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
}
function usageText(u) {
  if (!u || !u.contextWindow) return '';
  return (u.tokens == null ? '—' : fmtTok(u.tokens)) + '/' + fmtTok(u.contextWindow) + (u.percent != null ? ' (' + Math.round(u.percent) + '%)' : '');
}
function metaSeg(cls, text) {
  var s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}
function updateMetaLine() {
  metaEl.textContent = '';
  var segs = [metaSeg('m m-session', curMeta.sessionName || 'pi session'),
    metaSeg('m m-model', curMeta.model || ''),
    metaSeg('m m-cwd', curMeta.cwd || '')];
  var u = usageText(curMeta.usage);
  if (u) segs.push(metaSeg('m m-usage', u));
  for (var i = 0; i < segs.length; i++) metaEl.appendChild(segs[i]);
  document.title = (busy ? '⏳ ' : '') + (curMeta.sessionName || 'pi session');
}
function storeGet(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function storeSet(k, v) {
  try { localStorage.setItem(k, v); } catch (e) {}
}
function notifyDone() {
  if (!notifOn || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    var name = curMeta.sessionName || 'pi session';
    var body = '';
    var els = msgs.querySelectorAll('.msg.assistant.md');
    if (els.length > 0) body = (els[els.length - 1].textContent || '').slice(0, 150);
    var n = new Notification('pi: ' + name, body ? { body: body } : undefined);
    n.onclick = function () { window.focus(); n.close(); };
  } catch (e) {}
}
function setBusy(b) {
  var was = busy;
  busy = b;
  dot.classList.toggle('busy', b);
  stopBtn.classList.toggle('show', b);
  input.placeholder = b ? 'Agent busy — Send steers this run' : 'Message...';
  document.title = (busy ? '⏳ ' : '') + (curMeta.sessionName || 'pi session');
  if (was && !b) notifyDone();
}
function toolEl(id, name, state) {
  var el = document.getElementById('call-' + id);
  if (!el) {
    el = document.createElement('details');
    el.className = 'tool';
    el.id = 'call-' + id;
    tail(el);
  }
  var s = el.querySelector('summary');
  if (!s) {
    s = document.createElement('summary');
    el.insertBefore(s, el.firstChild);
  }
  s.textContent = name + ' — ' + state;
  return el;
}
function renderEntry(en) {
  if (en.type === 'message' && en.message) {
    var m = en.message;
    if (m.role === 'user') {
      var t = textOf(m.content);
      var imgParts = Array.isArray(m.content) ? m.content.filter(function (p) { return p && p.type === 'image'; }) : [];
      var i = 0, hit = null;
      for (; i < userQ.length; i++) {
        if (userQ[i].text === t && (userQ[i].images || []).length === imgParts.length) { hit = userQ[i]; break; }
      }
      if (hit) {
        userQ.splice(i, 1);
        hit.el.classList.remove('pendinguser');
        // pi 0.84.x persists a message only after its message_end handlers ran,
        // so this entry's append reaches us AFTER the reply's streaming bubble
        // was positioned above the still-pending bubble (tail() puts agent
        // content before queued user bubbles). Move the bubble ahead of the
        // streaming bubble to keep chat order: user, then its answer.
        if (pendingEl) msgs.insertBefore(hit.el, pendingEl);
      } else {
        addMsg('user', esc(t) + imgThumbs(imgParts));
      }
    } else if (m.role === 'assistant') {
      var texts = [];
      (Array.isArray(m.content) ? m.content : []).forEach(function (p) {
        if (p.type === 'text') texts.push(p.text || '');
        else if (p.type === 'toolCall') {
          var el = toolEl(p.id, p.name, 'running...');
          if (!el.querySelector('pre.in')) {
            var pre = document.createElement('pre');
            pre.className = 'in';
            pre.textContent = 'input: ' + JSON.stringify(p.arguments);
            el.appendChild(pre);
          }
        }
      });
      var full = texts.join('');
      if (pendingEl) {
        // finalize the streaming bubble in place so it keeps its position;
        // swap the raw streaming text for rendered markdown
        if (full) { pendingEl.classList.remove('pending'); pendingEl.classList.add('md'); pendingEl.innerHTML = md(full); }
        else { pendingEl.remove(); }
        pendingEl = null;
      } else if (full) { addMsg('assistant', md(full), 'md'); }
    } else if (m.role === 'toolResult') {
      var out = textOf(m.content);
      // ask bridge: pi flags blocked calls isError, but an answered/declined
      // questionnaire reads as a normal result, so don't style it as an error
      var askOk = m.toolName === 'ask_user_question' &&
        (out.indexOf('User has answered') === 0 || out.indexOf('User declined') === 0);
      var shownErr = m.isError && !askOk;
      var el2 = document.getElementById('call-' + m.toolCallId);
      if (el2) {
        var s = el2.querySelector('summary');
        if (s) s.textContent = m.toolName + ' — ' + (shownErr ? 'error' : 'done');
        el2.classList.toggle('err', shownErr);
        if (!el2.querySelector('pre.out')) {
          var pre2 = document.createElement('pre');
          pre2.className = 'out';
          pre2.textContent = 'output: ' + out;
          el2.appendChild(pre2);
        }
      } else {
        var el3 = document.createElement('details');
        el3.className = 'tool' + (shownErr ? ' err' : '');
        el3.innerHTML = '<summary>' + esc(m.toolName) + ' — ' + (shownErr ? 'error' : 'done') + '</summary>';
        var pre3 = document.createElement('pre');
        pre3.textContent = out;
        el3.appendChild(pre3);
        tail(el3);
      }
      autoScroll();
    } else if (m.role === 'bashExecution') {
      var el4 = document.createElement('details');
      el4.className = 'tool';
      el4.innerHTML = '<summary>! ' + esc(m.command || '') + '</summary>';
      var pre4 = document.createElement('pre');
      pre4.textContent = m.output || '';
      el4.appendChild(pre4);
      tail(el4);
    } else if (m.role === 'custom' || m.role === 'customMessage') {
      addNote('note: ' + textOf(m.content).slice(0, 200));
    }
    return;
  }
  if (en.type === 'compaction') addNote('— compacted (' + (en.tokensBefore || 0) + ' tokens before) —');
  else if (en.type === 'model_change') addNote('model → ' + (en.provider || '') + '/' + (en.modelId || ''));
  else if (en.type === 'thinking_level_change') addNote('thinking → ' + (en.thinkingLevel || ''));
  else if (en.type === 'branch_summary') addNote('branch: ' + String(en.summary || '').slice(0, 120));
  else if (en.type === 'session_info') addNote('name → ' + (en.name || '(cleared)'));
}
function renderSnapshot(d) {
  curMeta = d.meta || {};
  updateMetaLine();
  msgs.innerHTML = '';
  pendingEl = null;
  userQ = [];
  (d.entries || []).forEach(renderEntry);
  autoScroll();
}

var es = new EventSource('/events');
es.addEventListener('snapshot', function (e) { hideAsk(); hideModelPick(); hideTreePick(); renderSnapshot(JSON.parse(e.data)); }); // a resync means the old session (and any pending ask/picker of it) is gone
es.addEventListener('resync', function (e) { hideModelPick(); hideTreePick(); renderSnapshot(JSON.parse(e.data)); });
es.addEventListener('update', function (e) {
  var m = JSON.parse(e.data);
  if (!pendingEl) {
    pendingEl = document.createElement('div');
    pendingEl.className = 'msg assistant pending';
    tail(pendingEl);
  }
  pendingEl.textContent = textOf(m.content);
  autoScroll();
});
es.addEventListener('append', function (e) {
  (JSON.parse(e.data).entries || []).forEach(renderEntry);
});
es.addEventListener('toolstart', function (e) {
  var d = JSON.parse(e.data);
  toolEl(d.id, d.name, 'running...');
});
es.addEventListener('status', function (e) { setBusy(!!JSON.parse(e.data).busy); });
es.addEventListener('meta', function (e) {
  var d = JSON.parse(e.data);
  if (d.model !== undefined) curMeta.model = d.model || '';
  if (d.usage !== undefined) curMeta.usage = d.usage;
  updateMetaLine();
});
es.addEventListener('note', function (e) { addNote(JSON.parse(e.data).text || ''); });

// --- ask_user_question bridge: modal over the chat, answers POST /ask-answer ---
var askMask = document.createElement('div');
askMask.id = 'askmask';
document.body.appendChild(askMask);
var askState = null;

function hideAsk() {
  askState = null;
  askMask.classList.remove('open');
  askMask.innerHTML = '';
}
function mkAskQ(q, i) {
  var box = document.createElement('div');
  box.className = 'askq';
  var head = document.createElement('div');
  var chip = document.createElement('span');
  chip.className = 'qchip';
  chip.textContent = q.header || ('Q' + (i + 1));
  head.appendChild(chip);
  var qt = document.createElement('span');
  qt.className = 'qtext';
  qt.textContent = ' ' + q.question;
  head.appendChild(qt);
  box.appendChild(head);
  var type = q.multiSelect ? 'checkbox' : 'radio';
  var hasPreview = !q.multiSelect && q.options.some(function (o) { return o.preview; });
  q.options.forEach(function (o, j) {
    var row = document.createElement('label');
    row.className = 'askopt';
    var inp = document.createElement('input');
    inp.type = type;
    inp.name = 'askq' + i;
    inp.value = o.label;
    row.appendChild(inp);
    var texts = document.createElement('span');
    var lb = document.createElement('div');
    lb.className = 'olabel';
    lb.textContent = o.label;
    texts.appendChild(lb);
    if (o.description) {
      var ds = document.createElement('div');
      ds.className = 'odesc';
      ds.textContent = o.description;
      texts.appendChild(ds);
    }
    row.appendChild(texts);
    box.appendChild(row);
    if (hasPreview && o.preview) {
      var pv = document.createElement('div');
      pv.className = 'askpreview';
      pv.id = 'askpv' + i + '_' + j;
      pv.textContent = o.preview;
      box.appendChild(pv);
    }
  });
  if (hasPreview) {
    var inputs = box.querySelectorAll('input[name=askq' + i + ']');
    for (var k = 0; k < inputs.length; k++) {
      (function (kk) {
        inputs[kk].addEventListener('change', function () {
          for (var x = 0; x < inputs.length; x++) {
            var pvx = document.getElementById('askpv' + i + '_' + x);
            if (pvx) pvx.style.display = inputs[x].checked ? 'block' : 'none';
          }
        });
      })(k);
    }
  }
  var cbox = document.createElement('div');
  cbox.className = 'askcustom';
  var clab = document.createElement('div');
  clab.className = 'odesc';
  clab.textContent = 'Type something.';
  cbox.appendChild(clab);
  var cin = document.createElement('input');
  cin.type = 'text';
  cin.id = 'askc' + i;
  cin.placeholder = 'Your own answer...';
  cbox.appendChild(cin);
  box.appendChild(cbox);
  var nbox = document.createElement('div');
  nbox.className = 'askcustom';
  var nlab = document.createElement('div');
  nlab.className = 'odesc';
  nlab.textContent = 'Note (optional)';
  nbox.appendChild(nlab);
  var nin = document.createElement('input');
  nin.type = 'text';
  nin.id = 'askn' + i;
  nin.placeholder = 'Extra context for the agent...';
  nbox.appendChild(nin);
  box.appendChild(nbox);
  return box;
}
function showAsk(d) {
  hideAsk();
  askState = { id: d.id, questions: Array.isArray(d.questions) ? d.questions : [] };
  var box = document.createElement('div');
  box.className = 'askbox';
  var title = document.createElement('div');
  title.className = 'asktitle';
  title.textContent = 'The agent is asking — answer here (or in the terminal); first answer wins';
  box.appendChild(title);
  askState.questions.forEach(function (q, i) { box.appendChild(mkAskQ(q, i)); });
  var btns = document.createElement('div');
  btns.className = 'askbtns';
  var sub = document.createElement('button');
  sub.textContent = 'Submit answers';
  sub.addEventListener('click', function () { submitAsk(false); });
  var can = document.createElement('button');
  can.className = 'askcancel';
  can.textContent = 'Decline';
  can.addEventListener('click', function () { submitAsk(true); });
  btns.appendChild(sub);
  btns.appendChild(can);
  box.appendChild(btns);
  askMask.appendChild(box);
  askMask.classList.add('open');
}
function collectAsk() {
  var answers = [];
  (askState ? askState.questions : []).forEach(function (q, i) {
    var customEl = document.getElementById('askc' + i);
    var noteEl = document.getElementById('askn' + i);
    var custom = customEl ? customEl.value.trim() : '';
    var note = noteEl ? noteEl.value.trim() : '';
    var a = null;
    if (custom.length > 0) {
      a = { index: i, kind: 'custom', answer: custom };
    } else if (q.multiSelect) {
      var sel = [];
      var inputs = askMask.querySelectorAll('input[name=askq' + i + ']');
      for (var k = 0; k < inputs.length; k++) if (inputs[k].checked) sel.push(inputs[k].value);
      a = { index: i, kind: 'multi', answer: null, selected: sel };
    } else {
      var r = askMask.querySelector('input[name=askq' + i + ']:checked');
      if (r) a = { index: i, kind: 'option', answer: r.value };
    }
    if (a && note.length > 0) a.notes = note;
    if (a) answers.push(a);
  });
  return answers;
}
function submitAsk(cancelled) {
  if (!askState) return;
  var id = askState.id;
  var answers = cancelled ? [] : collectAsk();
  hideAsk();
  fetch('/ask-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, cancelled: cancelled, answers: answers })
  }).catch(function () { /* server gone; the terminal side still has the question */ });
}
es.addEventListener('ask', function (e) { showAsk(JSON.parse(e.data)); });
es.addEventListener('ask-resolved', function (e) {
  var d = JSON.parse(e.data);
  if (askState && d.id === askState.id) hideAsk();
});

// --- model picker: bare /model (server 'modelpick' event) opens a one-click
// modal; a pick re-sends '/model provider/id' through the normal input path
var modelMask = document.createElement('div');
modelMask.id = 'modelmask';
document.body.appendChild(modelMask);
function hideModelPick() {
  modelMask.classList.remove('open');
  modelMask.innerHTML = '';
}
function pickModel(c) {
  if (!modelMask.classList.contains('open')) return; // guard: label+radio click can double-fire
  hideModelPick();
  sendText('/model ' + c);
}
function showModelPick(d) {
  var box = document.createElement('div');
  box.className = 'askbox';
  var t = document.createElement('div');
  t.className = 'asktitle';
  t.textContent = 'Select model — ' + (d.current || '');
  box.appendChild(t);
  (d.choices || []).forEach(function (c) {
    var row = document.createElement('label');
    row.className = 'askopt';
    var inp = document.createElement('input');
    inp.type = 'radio';
    inp.name = 'modelpick';
    inp.value = c;
    if (c === d.current) inp.checked = true;
    row.appendChild(inp);
    var s = document.createElement('span');
    s.className = 'olabel';
    s.textContent = c + (c === d.current ? ' (current)' : '');
    row.appendChild(s);
    row.addEventListener('click', function () { pickModel(c); });
    box.appendChild(row);
  });
  var btns = document.createElement('div');
  btns.className = 'askbtns';
  var ok = document.createElement('button');
  ok.textContent = 'Switch';
  ok.addEventListener('click', function () {
    var sel = box.querySelector('input[name=modelpick]:checked');
    if (sel) pickModel(sel.value);
  });
  var cancel = document.createElement('button');
  cancel.className = 'askcancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', hideModelPick);
  btns.appendChild(ok);
  btns.appendChild(cancel);
  box.appendChild(btns);
  modelMask.innerHTML = '';
  modelMask.appendChild(box);
  modelMask.classList.add('open');
}
es.addEventListener('modelpick', function (e) { showModelPick(JSON.parse(e.data)); });
modelMask.addEventListener('click', function (e) { if (e.target === modelMask) hideModelPick(); });

// --- tree picker: bare /tree (server 'treepick' event) opens a one-click
// modal of the session's user messages; a pick re-sends '/tree <entry-id>'
// through the normal input path and the session resyncs via session_tree
var treeMask = document.createElement('div');
treeMask.id = 'treemask';
document.body.appendChild(treeMask);
function hideTreePick() {
  treeMask.classList.remove('open');
  treeMask.innerHTML = '';
}
function fmtTs(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function pickTree(id) {
  if (!treeMask.classList.contains('open')) return; // guard: label+radio click can double-fire
  hideTreePick();
  sendText('/tree ' + id);
}
function showTreePick(d) {
  var box = document.createElement('div');
  box.className = 'askbox';
  var t = document.createElement('div');
  t.className = 'asktitle';
  t.textContent = 'Jump to a previous message';
  box.appendChild(t);
  (d.points || []).forEach(function (p) {
    var row = document.createElement('label');
    row.className = 'askopt';
    var inp = document.createElement('input');
    inp.type = 'radio';
    inp.name = 'treepick';
    inp.value = p.id;
    if (p.id === d.current) inp.checked = true;
    row.appendChild(inp);
    var s = document.createElement('span');
    s.className = 'olabel';
    var when = fmtTs(p.ts);
    s.textContent = (when ? '[' + when + '] ' : '') + p.text + (p.id === d.current ? ' (current)' : '');
    row.appendChild(s);
    row.addEventListener('click', function () { pickTree(p.id); });
    box.appendChild(row);
  });
  var btns = document.createElement('div');
  btns.className = 'askbtns';
  var ok = document.createElement('button');
  ok.textContent = 'Jump';
  ok.addEventListener('click', function () {
    var sel = box.querySelector('input[name=treepick]:checked');
    if (sel) pickTree(sel.value);
  });
  var cancel = document.createElement('button');
  cancel.className = 'askcancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', hideTreePick);
  btns.appendChild(ok);
  btns.appendChild(cancel);
  box.appendChild(btns);
  treeMask.innerHTML = '';
  treeMask.appendChild(box);
  treeMask.classList.add('open');
}
es.addEventListener('treepick', function (e) { showTreePick(JSON.parse(e.data)); });
treeMask.addEventListener('click', function (e) { if (e.target === treeMask) hideTreePick(); });

function sendText(t, mode) {
  if (!t && !attachments.length) return;
  input.value = '';
  var imgs = attachments; attachments = []; renderAtt();
  if (t.charAt(0) === '/' && imgs.length) { imgs = []; alert('commands cannot carry images'); }
  var el = addMsg('user', esc(t) + imgThumbs(imgs), 'pendinguser');
  userQ.push({ el: el, text: t, images: imgs });
  fetch('/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: t, mode: mode || 'steer', images: imgs })
  }).then(function (r) {
    if (!r.ok) return r.json().then(function (d) { alert('send failed: ' + (d.error || r.status)); });
  }).catch(function (err) { alert('send failed: ' + err); });
}
// Enter steers the running agent like the terminal does; the web has no
// queue path.
function send() { sendText(input.value.trim(), 'steer'); }
input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value.trim(), 'steer'); }
});
document.getElementById('send').addEventListener('click', send);
// Copy buttons on rendered code blocks (delegated). The clipboard API needs a
// secure context; a plain-HTTP LAN falls back to execCommand.
function copyFallback(t) {
  var ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
msgs.addEventListener('click', function (e) {
  var b = e.target;
  if (!b || b.className !== 'copybtn') return;
  var pre = b.parentNode && b.parentNode.querySelector ? b.parentNode.querySelector('pre') : null;
  if (!pre) return;
  var t = pre.textContent;
  var done = function (ok) {
    b.textContent = ok ? 'copied' : 'copy failed';
    setTimeout(function () { b.textContent = 'copy'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(copyFallback(t)); });
  } else {
    done(copyFallback(t));
  }
});
stopBtn.addEventListener('click', function () {
  fetch('/stop', { method: 'POST' }).then(function () { setBusy(false); });
});
document.getElementById('logout').addEventListener('click', function () {
  fetch('/logout', { method: 'POST' }).then(function () { location.reload(); });
});
// Notification API needs a secure context (localhost/https); on plain-HTTP LAN
// the button hides itself and the ⏳ tab-title indicator covers in-progress runs.
var notifBtn = document.getElementById('notif');
if (typeof Notification === 'undefined' || Notification.permission === 'denied') {
  notifBtn.style.display = 'none';
} else {
  notifOn = Notification.permission === 'granted' && storeGet('piCockpitNotif') !== '0';
  notifBtn.classList.toggle('on', notifOn);
  notifBtn.addEventListener('click', function () {
    var apply = function (on) {
      notifOn = on;
      storeSet('piCockpitNotif', on ? '1' : '0');
      notifBtn.classList.toggle('on', on);
    };
    if (Notification.permission === 'granted') { apply(!notifOn); return; }
    var done = function (p) {
      if (p === 'granted') apply(true), addNote('Notifications on — a finished run pings you while this tab is hidden');
      else addNote('Notifications blocked — allow them in your browser site settings');
    };
    var r;
    try { r = Notification.requestPermission(function (p) { if (!r || typeof r.then !== 'function') done(p); }); }
    catch (e) { r = null; }
    if (r && typeof r.then === 'function') r.then(done);
  });
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Web server (spec §5). Zero-dependency node:http.
// ---------------------------------------------------------------------------

const BODY_LIMIT = 100 * 1024;   // spec: 100 KB body limit
// deviation from the spec's 100 KB body limit: /input also carries base64
// images, so only /input gets a larger cap (up to 3 images x ~6 MB base64).
const INPUT_BODY_LIMIT = 12 * 1024 * 1024;
const INPUT_LIMIT = 32 * 1024;   // spec: input text 32 KB
const MAX_IMAGES = 3;
const MAX_IMAGE_B64 = 6 * 1024 * 1024; // ≈ 4.5 MB raw per image
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const KEEPALIVE_MS = 15000;      // spec: SSE keep-alive comment every 15s

export interface SnapshotMeta {
  cwd: string;
  model: string;
  sessionName: string | null;
  leafId: string | null;
  usage: ContextUsage | null;
}

/** Pi-side dependency seam. Task 7 implements this against a live session. */
export interface WebApi {
  getSnapshot(): { entries: AnyRec[]; meta: SnapshotMeta };
  allEntries(): Map<string, AnyRec>;
  sendInput(text: string, mode?: "steer" | "followUp", images?: ImageInput[]): Promise<{ queued: boolean }>;
  stopAgent(): { aborted: boolean };
}

export interface WebServer {
  port: number; // actual bound port (may differ from requested)
  stop(): void;
  /** Push one SSE event to every authenticated, connected client. */
  broadcast(name: string, data: unknown): void;
  /** Full resync to every client (session replaced: /new, /resume, ...). */
  resyncAll(): void;
  /** Session leaf moved: per-client append / resync (spec §5 change-detection). */
  onSessionChanged(newLeaf: string | null): void;
  /** Currently connected SSE clients (0 = nobody is watching from the web). */
  clientCount(): number;
  /**
   * Ask for answers over SSE: broadcasts `ask {id, questions}` and resolves
   * when `POST /ask-answer` matches `id` — or null when the server stops,
   * all clients leave, or `signal` aborts first (whichever the caller should
   * fall back from). First answer wins; later posts for the same id get 409.
   */
  askUser(id: string, questions: AskQuestion[], signal?: AbortSignal): Promise<AskOutcome | null>;
  /** Resolve a pending askUser outside the HTTP path (closes the web modal). */
  settleAsk(id: string, outcome: AskOutcome | null): boolean;
}

interface SseClient {
  res: http.ServerResponse;
  hb: ReturnType<typeof setInterval>;
  lastLeaf: string | null;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        const err = new Error("body too large");
        (err as { code?: string }).code = "BODY_TOO_LARGE";
        reject(err);
        // deviation (kept from Task 5): the brief's code called req.destroy() here; that
        // also kills the socket, so the 413 could never be delivered (client saw
        // ECONNRESET, verified by the /input oversized test). Stream keeps flowing (drains
        // the body); chunks is not buffered past the limit, so memory stays bounded.
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Image attached to a web message: base64 data + MIME type. */
export type ImageInput = { data: string; mimeType: string };

/** Validates the `images` field of an /input body; returns the images or an error message. */
function parseImages(v: unknown): { ok: ImageInput[] } | { ok: null; error: string } {
  if (v === undefined || v === null) return { ok: [] };
  if (!Array.isArray(v) || v.length > MAX_IMAGES) return { ok: null, error: "too many images (max " + MAX_IMAGES + ")" };
  const out: ImageInput[] = [];
  for (const it of v) {
    const r = it as { data?: unknown; mimeType?: unknown } | null | undefined;
    if (!r || typeof r.mimeType !== "string" || !IMAGE_TYPES.has(r.mimeType) || typeof r.data !== "string" || !r.data)
      return { ok: null, error: "bad image" };
    if (r.data.length > MAX_IMAGE_B64) return { ok: null, error: "image too large (max ~4.5 MB)" };
    out.push({ data: r.data, mimeType: r.mimeType });
  }
  return { ok: out };
}

function json(res: http.ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function parseJsonBody(raw: string): AnyRec | null {
  try { return JSON.parse(raw) as AnyRec; } catch { return null; }
}

function safeWrite(res: http.ServerResponse, s: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(s); return true; } catch { return false; }
}

/** One SSE frame. JSON.stringify keeps data on a single line (newlines escaped). */
function writeSse(res: http.ServerResponse, name: string, data: unknown): boolean {
  let payload: string;
  try { payload = JSON.stringify(data); }
  catch { return false; } // deviation: non-serializable payload (circular ref/BigInt) must read as a write failure so broadcast never throws
  return safeWrite(res, "event: " + name + "\ndata: " + payload + "\n\n");
}

export function startServer(opts: {
  host?: string;
  port: number;
  passwordHash: string;
  tokens: Set<string>;
  api: WebApi;
}): Promise<WebServer> {
  const { passwordHash, tokens, api } = opts;
  const clients = new Set<SseClient>();
  const askWaiters = new Map<string, (o: AskOutcome | null) => void>();
  let closed = false;
  const server = http.createServer((req, res) => { void handle(req, res); });

  function settleAsk(id: string, outcome: AskOutcome | null): boolean {
    const w = askWaiters.get(id);
    if (!w) return false;
    askWaiters.delete(id);
    broadcast("ask-resolved", { id, outcome });
    w(outcome);
    return true;
  }

  function broadcast(name: string, data: unknown): void {
    if (closed) return;
    for (const c of [...clients]) {
      if (!writeSse(c.res, name, data)) c.res.end();
    }
  }

  // Last client left while a question was pending: nobody on the web can
  // answer anymore — wake the waiter (null) so the terminal side can finish alone.
  function checkAskOnLeave(): void {
    if (clients.size === 0) for (const id of [...askWaiters.keys()]) settleAsk(id, null);
  }

  function askUser(id: string, questions: AskQuestion[], signal?: AbortSignal): Promise<AskOutcome | null> {
    if (closed || clients.size === 0) return Promise.resolve(null);
    let onAbort: (() => void) | undefined;
    const p = new Promise<AskOutcome | null>((resolve) => {
      const finish = (o: AskOutcome | null) => {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        resolve(o);
      };
      const prev = askWaiters.get(id);
      if (prev) prev(null); // duplicate hook invocation: settle the stale waiter so the old await can't hang
      askWaiters.set(id, finish);
      onAbort = () => { settleAsk(id, null); };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
    broadcast("ask", { id, questions });
    return p;
  }

  function openSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    safeWrite(res, "retry: 2000\n\n");
    const snap = api.getSnapshot();
    writeSse(res, "snapshot", { entries: snap.entries, meta: snap.meta });
    const client: SseClient = {
      res,
      hb: setInterval(() => { if (!safeWrite(res, ": hb\n\n")) res.end(); }, KEEPALIVE_MS),
      lastLeaf: snap.meta.leafId,
    };
    clients.add(client);
    res.on("close", () => { clearInterval(client.hb); clients.delete(client); checkAskOnLeave(); });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || "/").split("?")[0];
    const token = tokenFromCookie(req.headers.cookie);
    const authed = token !== null && tokens.has(token);
    try {
      // --- public: page + login ---
      if (req.method === "GET" && url === "/") {
        html(res, 200, authed ? CHAT_PAGE : LOGIN_PAGE);
        return;
      }
      if (req.method === "POST" && url === "/login") {
        const raw = await readBody(req, BODY_LIMIT);
        const body = parseJsonBody(raw);
        const pw = typeof body?.password === "string" ? (body.password as string) : "";
        if (!verifyPassword(pw, passwordHash)) { json(res, 401, { error: "bad password" }); return; }
        const t = issueToken();
        tokens.add(t);
        json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(t) });
        return;
      }
      // --- everything below requires a valid token cookie ---
      if (!authed) { json(res, 401, { error: "unauthenticated" }); return; }

      if (req.method === "GET" && url === "/events") {
        openSse(res);
        return;
      }
      if (req.method === "POST" && url === "/input") {
        const raw = await readBody(req, INPUT_BODY_LIMIT);
        const body = parseJsonBody(raw);
        if (!body) { json(res, 400, { error: "bad json" }); return; }
        const text = typeof body.text === "string" ? (body.text as string).trim() : "";
        const img = parseImages(body.images);
        if (img.ok === null) { json(res, 400, { error: img.error }); return; }
        if (!text && img.ok.length === 0) { json(res, 400, { error: "empty message" }); return; }
        if (text.length > INPUT_LIMIT) { json(res, 400, { error: "message too long" }); return; }
        const mode = body.mode === "followUp" ? "followUp" : "steer";
        const r = await api.sendInput(text, mode, img.ok);
        json(res, 200, { ok: true, queued: r.queued });
        return;
      }
      if (req.method === "POST" && url === "/stop") {
        json(res, 200, api.stopAgent());
        return;
      }
      if (req.method === "POST" && url === "/ask-answer") {
        const raw = await readBody(req, BODY_LIMIT);
        const body = parseJsonBody(raw);
        if (!body || typeof body.id !== "string" || (body.id as string).length > 200) {
          json(res, 400, { error: "bad request" });
          return;
        }
        const cancelled = body.cancelled === true;
        const answers: AskAnswer[] = [];
        if (!cancelled) {
          const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
          for (const a of rawAnswers) {
            if (!a || typeof (a as AnyRec).index !== "number") continue;
            const kind = (a as AnyRec).kind;
            if (kind !== "option" && kind !== "custom" && kind !== "multi") continue;
            const out: AskAnswer = { index: (a as AnyRec).index as number, kind: kind as AskAnswer["kind"] };
            const ans = (a as AnyRec).answer;
            out.answer = typeof ans === "string" ? ans.slice(0, 8000) : null;
            if (Array.isArray((a as AnyRec).selected)) {
              out.selected = ((a as AnyRec).selected as unknown[])
                .filter((x): x is string => typeof x === "string")
                .slice(0, 10)
                .map((s) => s.slice(0, 200));
            }
            const notes = (a as AnyRec).notes;
            if (typeof notes === "string" && notes.length > 0) out.notes = notes.slice(0, 2000);
            answers.push(out);
          }
        }
        const ok = settleAsk(body.id as string, { cancelled, answers });
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "no pending question" });
        return;
      }
      if (req.method === "POST" && url === "/logout") {
        if (token) tokens.delete(token);
        json(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeader() });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (res.headersSent) { res.end(); return; }
      if (e.code === "BODY_TOO_LARGE") { json(res, 413, { error: "body too large" }); return; }
      if (e.code === "NO_CTX") { json(res, 503, { error: "session is ending" }); return; }
      json(res, 500, { error: e.message || "server error" });
    }
  }

  const web: WebServer = {
    port: opts.port,
    stop() {
      closed = true;
      for (const id of [...askWaiters.keys()]) settleAsk(id, null);
      const cs = [...clients];
      clients.clear();
      for (const c of cs) { clearInterval(c.hb); c.res.end(); }
      server.close();
    },
    broadcast: (name, data) => broadcast(name, data),
    resyncAll() {
      if (closed) return;
      for (const c of [...clients]) {
        let snap: { entries: AnyRec[]; meta: SnapshotMeta };
        try { snap = api.getSnapshot(); }
        catch { clearInterval(c.hb); c.res.end(); clients.delete(c); continue; }
        writeSse(c.res, "resync", { entries: snap.entries, meta: snap.meta });
        c.lastLeaf = snap.meta.leafId ?? null;
      }
    },
    onSessionChanged(newLeaf) {
      if (closed) return;
      const byId = api.allEntries();
      for (const c of [...clients]) {
        const diff = diffLeaf(byId, c.lastLeaf, newLeaf);
        if (diff.kind === "append") {
          writeSse(c.res, "append", {
            entries: diff.entries.map(sanitizeEntry).filter((x): x is AnyRec => x !== null),
          });
          c.lastLeaf = newLeaf;
        } else if (diff.kind === "resync") {
          let snap: { entries: AnyRec[]; meta: SnapshotMeta };
          try { snap = api.getSnapshot(); }
          catch { // deviation: getSnapshot can throw (e.g. NO_CTX while the session is ending); close this one client instead of propagating to the pi event handler
            clearInterval(c.hb); c.res.end(); clients.delete(c); continue;
          }
          writeSse(c.res, "resync", { entries: snap.entries, meta: snap.meta });
          c.lastLeaf = snap.meta.leafId ?? newLeaf;
        } else {
          c.lastLeaf = newLeaf;
        }
        if (c.res.writableEnded || c.res.destroyed) c.res.end();
      }
    },
    clientCount() {
      return clients.size;
    },
    askUser,
    settleAsk,
  };

  return new Promise<WebServer>((resolve, reject) => {
    server.once("error", reject); // surfaces EADDRINUSE to the caller
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") web.port = addr.port;
      resolve(web);
    });
  });
}

// ---------------------------------------------------------------------------
// Pi wiring (spec §3–§4). Server state lives at MODULE scope (in-memory, per
// pi process, never persisted): pi re-invokes the factory with a fresh closure
// on every session replacement (/new, /resume, /fork, /reload), invalidates
// the old pi/ctx (see AgentSession.dispose), but the module is imported once,
// so only module-level state survives across invocations. Handlers in the new
// closure rebind curCtx/curPi and resync the same running server — including
// the server's api object, which must route sendInput through the CURRENT pi,
// not the (invalidated) one captured when the server was started.
// ---------------------------------------------------------------------------

function lanUrls(port: number): string[] {
  const out = ["http://localhost:" + port];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push("http://" + i.address + ":" + port);
    }
  }
  return out;
}

function noCtxError(): Error {
  const e = new Error("session is ending");
  (e as { code?: string }).code = "NO_CTX";
  return e;
}

/**
 * cwd from a session JSONL file's header line, or null if unreadable.
 * Used to detect cross-cwd /resume targets (see session_shutdown below).
 */
function sessionFileCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024); // header entry is small; 64KB covers it
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString("utf8", 0, n).split("\n")[0].trim();
    if (!firstLine) return null;
    const head = JSON.parse(firstLine) as { cwd?: unknown };
    return typeof head.cwd === "string" ? head.cwd : null;
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}

let server: WebServer | null = null;
let tokens = new Set<string>();
let passwordHash = "";
let curCtx: ExtensionContext | null = null;
let curPi: ExtensionAPI | null = null;

const stopServer = (): void => {
  if (!server) return;
  server.stop();
  server = null;
  if (curCtx) curCtx.ui.setStatus("webserve", undefined);
};

export default function (pi: ExtensionAPI): void {
  curPi = pi;

  const api: WebApi = {
    getSnapshot() {
      const ctx = curCtx;
      if (!ctx) throw noCtxError();
      const sm = ctx.sessionManager;
      return {
        // deviation: pi entry types are interfaces (no implicit index signature), so a plain
        // `e as AnyRec` is a TS2352 error; the `unknown` hop is erased at runtime, behavior unchanged.
        entries: sm.buildContextEntries().map((e) => sanitizeEntry(e as unknown as AnyRec)).filter((x): x is AnyRec => x !== null),
        meta: {
          cwd: sm.getCwd(),
          model: ctx.model ? (ctx.model as { provider: string; id: string }).provider + "/" + (ctx.model as { provider: string; id: string }).id : "",
          sessionName: sm.getSessionName() ?? null,
          leafId: sm.getLeafId(),
          // Same source as the terminal's /context: last real assistant usage + estimate for trailing messages.
          usage: ctx.getContextUsage() ?? null,
        },
      };
    },
    allEntries() {
      const m = new Map<string, AnyRec>();
      if (curCtx) {
        // deviation: same interface -> AnyRec assertion fix as in getSnapshot above.
        for (const e of curCtx.sessionManager.getEntries()) m.set(e.id, e as unknown as AnyRec);
      }
      return m;
    },
    async sendInput(text, mode: "steer" | "followUp" = "steer", images: ImageInput[] = []) {
      const ctx = curCtx;
      const p = curPi;
      if (!ctx || !p) throw noCtxError();
      const idle = ctx.isIdle();
      const opts = inputOpts(text, idle, mode);
      if (images.length) {
        // Images (base64 png/jpeg/webp/gif) ride as ImageContent parts alongside text.
        const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        if (text) parts.push({ type: "text", text });
        for (const im of images) parts.push({ type: "image", data: im.data, mimeType: im.mimeType });
        p.sendUserMessage(parts, opts);
      } else {
        p.sendUserMessage(text, opts);
      }
      return { queued: !idle && opts.deliverAs === "followUp" };
    },
    stopAgent() {
      const ctx = curCtx;
      if (!ctx || ctx.isIdle()) return { aborted: false };
      ctx.abort(); // programmatic Esc (spec §5 /stop)
      return { aborted: true };
    },
  };

  const leaf = (): string | null => (curCtx ? curCtx.sessionManager.getLeafId() : null);
  const changed = (): void => { server?.onSessionChanged(leaf()); };

  // --- session lifecycle ---
  pi.on("session_start", (_e, ctx) => { curCtx = ctx; server?.resyncAll(); });
  pi.on("session_shutdown", (e, ctx) => {
    curCtx = null;
    // quit/reload: this pi (or the extension) is going away — release the server.
    if (e.reason === "quit" || e.reason === "reload") {
      stopServer();
      return;
    }
    // new/fork (and same-cwd resume): the session is being replaced — keep the
    // server; the following session_start resyncs all clients to the new session.
    if (e.reason === "resume" && e.targetSessionFile) {
      // Cross-cwd resume: pi's extension loader cache is keyed by cwd, so a
      // different-cwd target RE-IMPORTS this module — a fresh instance whose
      // module state is null, which would orphan the running server (stale
      // page, /input 503, port held, not stoppable from the new instance).
      // Stop it here so the browser gets a clean dead server instead.
      const curCwd = ctx.sessionManager.getCwd();
      const targetCwd = sessionFileCwd(e.targetSessionFile);
      if (targetCwd !== null && targetCwd !== curCwd) stopServer();
    }
  });

  // --- live stream (spec §5 SSE events) ---
  pi.on("message_update", (e, ctx) => {
    curCtx = ctx;
    server?.broadcast("update", e.message);
  });
  pi.on("message_end", (_e, ctx) => {
    curCtx = ctx;
    changed();
  });
  pi.on("tool_execution_start", (e, _ctx) => {
    server?.broadcast("toolstart", { id: e.toolCallId, name: e.toolName, args: e.args });
  });
  pi.on("tool_execution_end", (_e, ctx) => {
    curCtx = ctx;
    changed();
  });
  pi.on("model_select", (e, ctx) => {
    curCtx = ctx;
    server?.broadcast("meta", { model: (e.model as { provider: string; id: string }).provider + "/" + (e.model as { provider: string; id: string }).id, usage: ctx.getContextUsage() ?? null });
    changed();
  });
  pi.on("session_compact", (_e, ctx) => { curCtx = ctx; changed(); });
  pi.on("session_tree", (_e, ctx) => { curCtx = ctx; changed(); });
  pi.on("session_info_changed", (_e, ctx) => { curCtx = ctx; changed(); });
  pi.on("agent_start", (_e, ctx) => { curCtx = ctx; server?.broadcast("status", { busy: true }); });
  pi.on("agent_settled", (_e, ctx) => {
    curCtx = ctx;
    server?.broadcast("status", { busy: false });
    server?.broadcast("meta", { usage: ctx.getContextUsage() ?? null });
    // pi persists each message after its message_end handlers ran, so the run's
    // trailing entry was one leaf behind; the run is fully settled and persisted
    // now, so flush it and let the final message finalize as markdown without
    // waiting for the next interaction.
    changed();
  });

  // --- ask_user_question bridge: web + terminal, first answer wins ---
  // The rpiv-ask-user-question tool would otherwise block on a TUI overlay in
  // the local terminal only. When a web client is watching, we answer the
  // call from the web modal and/or a minimal terminal overlay (this hook runs
  // before the tool executes; a returned {block} becomes the tool result the
  // model sees — we use the tool's own result wording so behavior is
  // indistinguishable). No web client -> return undefined -> the tool's own
  // rich TUI flow runs exactly as before.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "ask_user_question") return;
    const questions = extractAskQuestions((event.input as AnyRec).questions);
    if (!questions) return; // malformed: the tool's own validation reports it
    if (questions.some((q) => q.options.some((o) => ASK_RESERVED_LABELS.includes(o.label)))) {
      return; // reserved label: the tool's own validator rejects it
    }
    if (!server || server.clientCount() === 0) return; // nobody on the web: TUI as usual
    const id = event.toolCallId;

    // Web side: modal in every connected client; first POST /ask-answer wins.
    const webSide = server.askUser(id, questions, ctx.signal);
    // Terminal side: our own closable overlay (only when this pi has a TUI).
    let closeTui: (() => void) | null = null;
    let termSide: Promise<AskOutcome | null> | null = null;
    if (ctx.hasUI && ctx.mode === "tui") {
      let comp: AskTuiComponent | null = null;
      termSide = ctx.ui.custom<AskOutcome | null>(
        (tui, _theme, _kb, done) => {
          comp = new AskTuiComponent(questions, tui, done);
          closeTui = () => comp?.close();
          if (ctx.signal) ctx.signal.addEventListener("abort", closeTui, { once: true }); // don't leave a stuck overlay on Esc
          return comp;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "bottom-center", width: "100%" },
        },
      ).then((r) => r ?? null).catch(() => null);
    }
    const sides = termSide ? [webSide, termSide] : [webSide];

    // First real answer wins; a null side means that surface died (all clients
    // left / server stopped / host can't render / closed by the other side),
    // so keep waiting for the rest. All dead -> undefined -> the tool's own flow.
    const outcome = await new Promise<AskOutcome | null>((resolve) => {
      let pending = sides.length;
      let done = false;
      for (const s of sides) {
        void s.then((o) => {
          if (done) return;
          if (o) {
            done = true;
            closeTui?.(); // terminal loses: hide the overlay (done(null))
            server?.settleAsk(id, null); // web loses: close the modal (broadcasts ask-resolved)
            resolve(o);
          } else if (--pending === 0) {
            done = true;
            resolve(null);
          }
        });
      }
    });
    if (!outcome) return;
    return { block: true, reason: buildAskEnvelope(questions, outcome) };
  });

  // --- web-side equivalents of built-in commands ---
  // Same names as the TUI built-ins: in the terminal pi checks the built-ins
  // first, so TUI behavior is unchanged (cosmetic conflict diagnostic only);
  // the web path reaches these handlers via inputOpts' expandPromptTemplates.
  pi.registerCommand("new", {
    description: "Start a new session",
    handler: async (_args, ctx) => {
      const r = await ctx.newSession();
      server?.broadcast("note", { text: r.cancelled ? "/new: cancelled" : "/new: new session started" });
    },
  });
  pi.registerCommand("compact", {
    description: "Compact context: /compact [instructions]",
    handler: async (args, ctx) => {
      const instructions = (args ?? "").trim();
      server?.broadcast("note", { text: "/compact: started" + (instructions ? " — " + instructions : "") });
      ctx.compact(instructions ? {
        customInstructions: instructions,
        onComplete: () => { server?.broadcast("note", { text: "/compact: done" }); },
        onError: (err) => { server?.broadcast("note", { text: "/compact failed: " + err.message }); },
      } : undefined);
    },
  });

  // /model — the built-in one is TUI-only; this gives the web viewer its own.
  // Bare /model broadcasts the selectable set (scoped models when scoping is
  // configured, else everything with valid auth — the set the TUI picker
  // shows) as a `modelpick` event; the web page renders a one-click picker
  // modal whose pick re-sends `/model provider/model-id`. A bare id
  // (unambiguous) switches too. The model_select listener above updates the
  // web header automatically.
  pi.registerCommand("model", {
    description: "Show or switch the model: /model [provider/model-id]",
    handler: async (args, ctx) => {
      const scoped = ctx.scopedModels.map((s) => s.model);
      const pool = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
      const pick = (args ?? "").trim();
      if (pick === "") {
        if (pool.length === 0) {
          server?.broadcast("note", { text: "/model: no available models — check API keys / models.json" });
          return;
        }
        const cur = ctx.model ? ctx.model.provider + "/" + ctx.model.id : "";
        server?.broadcast("modelpick", { choices: pool.map((m) => m.provider + "/" + m.id), current: cur });
        return;
      }
      const slash = pick.indexOf("/");
      let m = slash >= 0 ? ctx.modelRegistry.find(pick.slice(0, slash), pick.slice(slash + 1)) : undefined;
      if (slash < 0) {
        const cands = pool.filter((x) => x.id === pick);
        if (cands.length === 1) m = cands[0];
        else if (cands.length > 1) {
          server?.broadcast("note", { text: "/model: '" + pick + "' is ambiguous — try: " + cands.map((x) => x.provider + "/" + x.id).join(", ") });
          return;
        }
      }
      if (!m) {
        server?.broadcast("note", { text: "/model: unknown model '" + pick + "' — use bare /model to list available ones" });
        return;
      }
      const ok = await pi.setModel(m);
      server?.broadcast("note", { text: ok ? "/model: " + m.provider + "/" + m.id : "/model: no API key for " + m.provider + "/" + m.id });
    },
  });

  // /tree — the built-in one is a TUI picker; this gives the web viewer its
  // own. Bare /tree broadcasts the session's user messages as a `treepick`
  // event; the web page renders a one-click picker whose pick re-sends
  // `/tree <entry-id>`. ctx.navigateTree is the same runtime op as the TUI's
  // /tree: it throws while streaming, no-ops at the target, and fires
  // session_tree (listened above), which resyncs every web client. No branch
  // summary is requested (the TUI prompts for one; the web stays minimal).
  pi.registerCommand("tree", {
    description: "Jump to a previous point in this session: /tree [entry-id]",
    handler: async (args, ctx) => {
      const pick = (args ?? "").trim();
      const leaf = ctx.sessionManager.getLeafId();
      if (pick === "") {
        const raw = ctx.sessionManager.getEntries().map((e) => e as unknown as AnyRec);
        const points = raw
          .filter((e) => e.type === "message" && (e.message as AnyRec | undefined)?.role === "user")
          .map((e) => ({ id: e.id as string, text: entryPreview(e), ts: (e.timestamp as string) ?? "" }));
        if (points.length === 0) {
          server?.broadcast("note", { text: "/tree: no messages in this session yet" });
          return;
        }
        server?.broadcast("treepick", { points, current: leaf });
        return;
      }
      const before = leaf;
      let r: { cancelled: boolean };
      try {
        r = await ctx.navigateTree(pick);
      } catch (err) {
        server?.broadcast("note", { text: "/tree: " + (err as Error).message });
        return;
      }
      const after = ctx.sessionManager.getLeafId();
      server?.broadcast("note", { text: r.cancelled ? "/tree: cancelled" : after !== before ? "/tree: jumped to " + pick : "/tree: already at " + pick });
    },
  });

  // --- commands (spec §3) ---
  pi.registerCommand("webserve", {
    description: "Web session viewer: /webserve start [port] | stop | status",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      if (sub === undefined || sub === "start") {
        if (server) {
          ctx.ui.notify("web viewer already running on port " + server.port, "info");
          return;
        }
        const reqPort = sub === undefined ? 8765 : Number(parts[1]);
        if (!Number.isInteger(reqPort) || reqPort < 1 || reqPort > 65535) {
          ctx.ui.notify("Usage: /webserve start [port]  (port 1-65535, default 8765)", "warning");
          return;
        }
        const pw = await ctx.ui.input("Web viewer password", "min 4 chars");
        if (!pw || pw.length < 4) {
          ctx.ui.notify("password must be 4+ chars; server not started", "warning");
          return;
        }
        passwordHash = hashPassword(pw);
        tokens = new Set();
        curCtx = ctx; // command ctx is valid for this session; covers the gap before the first event
        let lastErr: { message?: string } | null = null;
        for (let p = reqPort; p < reqPort + 10; p++) {
          try {
            server = await startServer({ host: "0.0.0.0", port: p, passwordHash, tokens, api });
            break;
          } catch (err) {
            lastErr = err as { message?: string };
            if ((err as { code?: string }).code !== "EADDRINUSE") break;
          }
        }
        if (!server) {
          passwordHash = "";
          ctx.ui.notify("web viewer failed to start: " + (lastErr?.message ?? "unknown error"), "error");
          return;
        }
        ctx.ui.notify("web viewer: " + lanUrls(server.port).join("   ") + "  (password required)", "info");
        ctx.ui.setStatus("webserve", "web :" + server.port);
      } else if (sub === "stop") {
        stopServer();
        ctx.ui.notify("web viewer stopped", "info");
      } else if (sub === "status") {
        ctx.ui.notify(server ? "web viewer running on port " + server.port : "web viewer not running", "info");
      } else {
        ctx.ui.notify("Usage: /webserve start [port] | stop | status", "warning");
      }
    },
  });
}
