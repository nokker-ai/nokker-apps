/**
 * Panneau de chat (webview). Aucun accès réseau ni jeton : il affiche ce que l'extension lui envoie et lui renvoie les
 * gestes de l'utilisateur. Tout texte venu du noyau est posé par `textContent` (jamais `innerHTML`).
 */
import type { FromView, ToView, ViewCard, ViewLive, ViewTool } from "../protocol.js";
import { parseMarkdown, type Inline } from "./markdown.js";

declare function acquireVsCodeApi(): { postMessage(m: FromView): void };
const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const log = $<HTMLElement>("log");
const status = $<HTMLElement>("status");
const input = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const stopBtn = $<HTMLButtonElement>("stop");
const contextBox = $<HTMLElement>("context");
const fileBtn = $<HTMLButtonElement>("file");
const reviewBox = $<HTMLElement>("review");

/** Libellés traduits par l'extension (`webviewStrings`), posés dans `data-strings` de la page. */
let strings: Record<string, string> = {};
try {
  strings = JSON.parse(document.body.dataset.strings ?? "{}") as Record<string, string>;
} catch {
  strings = {};
}
const L = (key: string, ...args: Array<string | number>): string =>
  (strings[key] ?? key).replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));

let busy = false;
let connected = false;
let assistant: { el: HTMLElement; text: string } | null = null;
const tools = new Map<string, HTMLElement>();
const lives = new Map<string, ViewLive>();
const cards = new Map<string, HTMLElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function scrollDown(): void {
  log.scrollTop = log.scrollHeight;
}

function inlines(parent: HTMLElement, xs: Inline[]): void {
  for (const x of xs) {
    if (x.kind === "text") parent.append(document.createTextNode(x.text));
    else parent.append(el(x.kind === "code" ? "code" : x.kind === "strong" ? "strong" : "em", undefined, x.text));
  }
}

function renderMarkdown(target: HTMLElement, src: string): void {
  target.replaceChildren();
  for (const b of parseMarkdown(src)) {
    if (b.kind === "code") {
      const pre = el("pre");
      pre.append(el("code", b.lang ? `lang-${b.lang}` : undefined, b.text));
      target.append(pre);
    } else if (b.kind === "list") {
      const ul = el("ul");
      for (const it of b.items) {
        const li = el("li");
        inlines(li, it);
        ul.append(li);
      }
      target.append(ul);
    } else {
      const p = el(b.kind === "quote" ? "blockquote" : "p");
      inlines(p, b.inlines);
      target.append(p);
    }
  }
}

function addMessage(role: "user" | "assistant", text: string, context: string[] = []): HTMLElement {
  const box = el("div", `msg ${role}`);
  box.append(el("div", "who", role === "user" ? L("you") : L("nokker")));
  const body = el("div", "body");
  if (role === "user") {
    for (const c of context) body.append(el("div", "ctx", `⧉ ${c}`));
    body.append(el("div", "plain", text));
  } else renderMarkdown(body, text);
  box.append(body);
  log.append(box);
  scrollDown();
  return body;
}

function rowFor(callId: string, depth: number): HTMLElement {
  let row = tools.get(callId);
  if (!row) {
    row = el("div", `tool depth${Math.min(depth, 1)}`);
    tools.set(callId, row);
    log.append(row);
    assistant = null; // le texte qui suit un outil ouvre un nouveau bloc
  }
  return row;
}

/** Bloc vivant (écriture en direct) sous la ligne d'outil : les dernières lignes que le modèle propose. */
function liveBlock(v: ViewLive): HTMLElement {
  const box = el("div", `live${v.done ? " done" : ""}${v.discarded ? " discarded" : ""}`);
  const head = el("div", "live-head");
  head.append(el("span", undefined, v.discarded ? L("liveDiscarded") : L("writing", v.path ?? v.name)));
  if (!v.discarded) {
    const open = el("button", "link", L("liveOpen"));
    open.type = "button";
    open.addEventListener("click", () => vscode.postMessage({ type: "openLive", callId: v.callId }));
    head.append(open);
  }
  box.append(head);
  if (v.tail.length) box.append(el("pre", undefined, v.tail.join("\n")));
  if (v.truncated) box.append(el("div", "live-head", L("liveTruncated")));
  return box;
}

function liveUpdate(v: ViewLive): void {
  lives.set(v.callId, v);
  const row = rowFor(v.callId, 0);
  if (!row.querySelector(".head")) {
    // Les deltas arrivent AVANT le `tool.call` : une ligne provisoire, complétée par l'outil.
    const head = el("div", "head");
    head.append(el("span", "icon", "✎"), el("span", "name", v.name));
    if (v.path) head.append(el("span", "target", v.path));
    row.append(head);
  }
  row.querySelector(".live")?.remove();
  if (!v.done || v.discarded) row.append(liveBlock(v));
  scrollDown();
}

function toolLine(t: ViewTool): void {
  const row = rowFor(t.callId, t.depth);
  row.replaceChildren();
  row.dataset.status = t.status;
  const icon = t.status === "in_progress" ? "⟳" : t.status === "completed" ? "✓" : "✗";
  const head = el("div", "head");
  head.append(el("span", "icon", icon), el("span", "name", t.name));
  if (t.target) head.append(el("span", "target", t.target));
  if (t.status === "in_progress" && t.effect) head.append(el("span", "effect", t.effect));
  if (t.ms !== null && t.status !== "in_progress") head.append(el("span", "ms", `${t.ms} ms`));
  row.append(head);
  const lv = lives.get(t.callId);
  if (lv && t.status === "in_progress" && !lv.discarded) row.append(liveBlock(lv));
  for (const d of t.diffs) {
    const b = el("button", "diff link", d.created ? L("viewCreated", d.relPath) : `${L("viewDiff", d.relPath)}${d.fragment ? ` ${L("excerpt")}` : ""}`);
    b.type = "button";
    b.addEventListener("click", () => vscode.postMessage({ type: "openDiff", id: d.id }));
    row.append(b);
  }
  if (t.preview && t.status !== "in_progress") {
    const det = el("details", "preview");
    det.append(el("summary", undefined, L("preview")), el("pre", undefined, t.preview.split("\n").slice(0, 12).join("\n")));
    row.append(det);
  }
  scrollDown();
}

function card(c: ViewCard): void {
  const shown = cards.get(c.id);
  if (shown) {
    // Même carte renvoyée : une carte forte partie au téléphone change de texte, rien d'autre.
    const where = shown.querySelector(".phone");
    if (where && c.strongText) where.textContent = strongLine(c);
    return;
  }
  const box = el("div", "card");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", L("cardTitle"));
  box.append(el("div", "title", L("cardTitle")));
  const what = el("div", "what");
  what.append(el("span", "name", c.tool), el("span", "effect", c.effect));
  box.append(what);
  if (c.target) box.append(el("pre", "target", c.target));
  box.append(el("div", "reason", c.reason));
  if (!c.choices) {
    box.classList.add("strong");
    box.append(el("div", "phone", strongLine(c)));
  } else {
    const row = el("div", "choices");
    for (const ch of c.choices) {
      const b = el("button", ch.id === "reject" ? "secondary" : undefined, `${ch.key}. ${ch.label}`);
      b.type = "button";
      if (ch.rule) {
        b.title = L("ruleTitle", ch.rule);
        b.append(el("span", "rule", ch.rule));
      }
      b.addEventListener("click", () => {
        for (const x of row.querySelectorAll("button")) (x as HTMLButtonElement).disabled = true;
        vscode.postMessage({ type: "decide", id: c.id, index: ch.index });
      });
      row.append(b);
    }
    box.append(row);
  }
  cards.set(c.id, box);
  log.append(box);
  assistant = null;
  scrollDown();
}

function strongLine(c: ViewCard): string {
  return `${c.forwarded ? "📱" : "⌨"} ${c.strongText ?? ""}`;
}

function cardClosed(id: string, st: string): void {
  const box = cards.get(id);
  if (!box) return;
  cards.delete(id);
  const label =
    st === "approved" || st === "executed"
      ? L("approved")
      : st === "rejected"
        ? L("rejectedCard")
        : st === "expired"
          ? L("expired")
          : st === "cancelled"
            ? L("cancelled")
            : L("decidedElsewhere");
  box.querySelector(".choices")?.remove();
  box.querySelector(".phone")?.remove();
  box.classList.add("closed");
  box.append(el("div", "outcome", label));
}

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.disabled = b || !connected;
  stopBtn.hidden = !b;
}

function renderContext(items: Array<{ id: string; label: string }>): void {
  contextBox.replaceChildren();
  for (const it of items) {
    const chip = el("span", "chip", `⧉ ${it.label}`);
    const x = el("button", "chip-x", "×");
    x.type = "button";
    x.setAttribute("aria-label", L("remove", it.label));
    x.addEventListener("click", () => vscode.postMessage({ type: "removeContext", id: it.id }));
    chip.append(x);
    contextBox.append(chip);
  }
}

function onMessage(m: ToView): void {
  switch (m.type) {
    case "state": {
      connected = m.connected;
      status.replaceChildren();
      if (m.error) status.append(el("div", "error", m.error));
      else if (m.connected) status.append(el("div", "ok", `${m.folder ?? ""} · ${L("thread", m.threadId ?? "?")}`));
      else status.append(el("div", "muted", L("connecting")));
      setBusy(m.busy);
      return;
    }
    case "history":
      log.replaceChildren();
      tools.clear();
      lives.clear();
      cards.clear();
      reviewBox.hidden = true;
      assistant = null;
      for (const h of m.messages) addMessage(h.role, h.text);
      return;
    case "user":
      addMessage("user", m.text, m.context);
      assistant = null;
      return;
    case "text":
      if (!assistant) assistant = { el: addMessage("assistant", ""), text: "" };
      assistant.text += m.append;
      renderMarkdown(assistant.el, assistant.text);
      scrollDown();
      return;
    case "textReplace":
      // Le texte final du noyau remplace le paragraphe en cours.
      if (!assistant) assistant = { el: addMessage("assistant", ""), text: "" };
      assistant.text = m.text;
      renderMarkdown(assistant.el, assistant.text);
      scrollDown();
      return;
    case "tool":
      toolLine(m.tool);
      return;
    case "card":
      card(m.card);
      return;
    case "cardClosed":
      cardClosed(m.id, m.status);
      return;
    case "cost":
      log.append(el("div", "cost", m.line));
      scrollDown();
      return;
    case "notice":
      log.append(el("div", "notice", m.text));
      assistant = null;
      scrollDown();
      return;
    case "turnEnd":
      assistant = null;
      if (m.stopReason === "cancelled") log.append(el("div", "notice", L("turnStopped")));
      return;
    case "live":
      liveUpdate(m.live);
      return;
    case "review": {
      reviewBox.replaceChildren();
      reviewBox.append(el("span", undefined, L("review", m.files)));
      const open = el("button", "link", L("reviewOpen"));
      open.type = "button";
      open.addEventListener("click", () => vscode.postMessage({ type: "openReview" }));
      reviewBox.append(open);
      reviewBox.hidden = m.files === 0;
      return;
    }
    case "prefill":
      input.value = m.text;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    case "context":
      renderContext(m.items);
      return;
    case "error":
      log.append(el("div", "error", m.text));
      scrollDown();
      return;
  }
}

function send(): void {
  const text = input.value.trim();
  if (!text || busy || !connected) return;
  input.value = "";
  vscode.postMessage({ type: "send", text });
}

sendBtn.addEventListener("click", send);
fileBtn.addEventListener("click", () => vscode.postMessage({ type: "pickFile" }));
stopBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  } else if (e.key === "Escape" && busy) {
    vscode.postMessage({ type: "cancel" });
  }
});
window.addEventListener("message", (e: MessageEvent<ToView>) => onMessage(e.data));
setBusy(false);
vscode.postMessage({ type: "ready" });
