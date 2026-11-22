/**
 * « L'agent qui montre » (V3) — mock du contrat noyau docs/BROWSER-LIVE.md (v3, 07.11), drapeau `MOCK_BROWSER_LIVE=1`.
 *
 * Aligné sur le noyau p2/v-agent-montre-core f0603e0 (docs/BROWSER-LIVE.md fait foi).
 * Une session navigateur scriptée, déclenchée par « réserve … » / « book … » : une bulle `browser` dans le fil, des
 * `browser.frame` (images SVG générées, URL signée 60 s, `no-store`) et `browser.action` sur le flux, une carte
 * d'approbation qui nomme sa règle (`rule_label`, `rule_source` du foyer) et s'ancre sur une frame (`context.browser`),
 * puis une reprise en main 2FA (`browser.handoff` → `POST …/resume` → `browser.resumed`), et `browser.ended`.
 * Rien n'est gardé au-delà des 20 dernières frames ; une frame `sensitive` n'a pas d'image du tout.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argsSha256 } from "@nokker-apps/sdk";
import type { Approval, BrowserAction, BrowserPoint, BrowserEndReason, BrowserFrame, BrowserHandoff, BrowserSessionStatus, BrowserSessionView } from "@nokker-apps/sdk";
import { createBubble, updateBubble } from "./bubbles.js";
import { timedSpeech } from "./persona.js";
import { hexId, randomId, type MockState } from "./state.js";

const KEY = randomBytes(32);
const FRAME_TTL_MS = 60_000;
const TAKEOVER_TTL_MS = 5 * 60_000;

interface Session {
  id: string;
  threadId: string;
  bubbleId: string;
  status: BrowserSessionStatus;
  seq: number;
  frames: (BrowserFrame & { svg?: string; webp?: Buffer; fid?: string })[];
  actions: BrowserAction[];
  handoff: BrowserHandoff | null;
  ended: { session_id: string; seq: number; reason: BrowserEndReason; at: string } | null;
  /** Cookies de reprise émis (valeur → expiration), liés à cette session. */
  screenCookies: Map<string, number>;
  takeoverCodes: Map<string, number>;
  points: BrowserPoint[];
  approvalId: string | null;
  fr: boolean;
}

const sessions = new WeakMap<MockState, Map<string, Session>>();
const all = (state: MockState): Map<string, Session> => {
  let m = sessions.get(state);
  if (!m) sessions.set(state, (m = new Map()));
  return m;
};

const HOST = "restaurant.example";
/** Pas de l'agent, en ms (court : la démo et les e2e attendent). */
const STEP = Number(process.env.MOCK_BROWSER_STEP_MS ?? 700);

const sign = (fid: string, exp: number): string => createHmac("sha256", KEY).update(`${fid}.${exp}`).digest("base64url");

function frameUrl(fid: string): string {
  const exp = Date.now() + FRAME_TTL_MS;
  return `/v1/browser/frames/${fid}.webp?exp=${exp}&sig=${sign(fid, exp)}`;
}

/** Page fictive dessinée en SVG : barre d'adresse, titre, formulaire ; `focus` encadre la cible de l'action. */
function pageSvg(step: number, fr: boolean, focus?: { x: number; y: number; w: number; h: number }): string {
  const t = (a: string, b: string): string => (fr ? a : b);
  const field = (y: number, label: string, value: string): string =>
    `<text x="120" y="${y - 10}" font-size="18" fill="#5b4b45">${label}</text><rect x="120" y="${y}" width="520" height="48" rx="8" fill="#fff" stroke="#d9c9c2"/><text x="136" y="${y + 31}" font-size="20" fill="#2b2220">${value}</text>`;
  const body =
    step === 0
      ? `<text x="120" y="250" font-size="40" font-weight="700" fill="#2b2220">La Table du Lac</text><text x="120" y="292" font-size="20" fill="#5b4b45">${t("Cuisine de saison · Ouvert ce soir", "Seasonal food · Open tonight")}</text><rect x="120" y="340" width="220" height="56" rx="28" fill="#e2574c"/><text x="160" y="376" font-size="22" font-weight="700" fill="#fff">${t("Réserver", "Book")}</text>`
      : step < 4
        ? `<text x="120" y="210" font-size="32" font-weight="700" fill="#2b2220">${t("Votre réservation", "Your booking")}</text>${field(270, t("Date", "Date"), t("samedi 19:30", "Saturday 19:30"))}${field(370, t("Personnes", "Guests"), "4")}${field(470, t("Nom", "Name"), step >= 2 ? "••••••••" : "")}<rect x="120" y="560" width="260" height="56" rx="28" fill="#e2574c"/><text x="150" y="596" font-size="22" font-weight="700" fill="#fff">${t("Envoyer la demande", "Send the request")}</text>`
        : step === 4
          ? `<text x="120" y="230" font-size="32" font-weight="700" fill="#2b2220">${t("Vérification", "Verification")}</text><text x="120" y="280" font-size="20" fill="#5b4b45">${t("Un code a été envoyé à votre téléphone.", "A code was sent to your phone.")}</text>`
          : `<circle cx="160" cy="250" r="34" fill="#3aa76d"/><path d="M144 250l12 12 22-24" stroke="#fff" stroke-width="6" fill="none"/><text x="220" y="262" font-size="32" font-weight="700" fill="#2b2220">${t("Demande envoyée", "Request sent")}</text><text x="120" y="330" font-size="20" fill="#5b4b45">${t("Le restaurant confirme par e-mail.", "The restaurant confirms by e-mail.")}</text>`;
  const ring = focus ? `<rect x="${focus.x - 6}" y="${focus.y - 6}" width="${focus.w + 12}" height="${focus.h + 12}" rx="12" fill="none" stroke="#e2574c" stroke-width="3" stroke-dasharray="8 6"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="#faf6f3"/><rect width="1280" height="64" fill="#efe6e1"/><circle cx="32" cy="32" r="7" fill="#e2574c"/><circle cx="56" cy="32" r="7" fill="#e7a33e"/><circle cx="80" cy="32" r="7" fill="#3aa76d"/><rect x="120" y="16" width="720" height="32" rx="16" fill="#fff"/><text x="140" y="38" font-size="16" fill="#7a6a64">https://${HOST}/</text>${body}${ring}</svg>`;
}

function publishFrame(state: MockState, s: Session, step: number, sensitive: boolean, focus?: { x: number; y: number; w: number; h: number }): BrowserFrame {
  s.seq += 1;
  const fid = sensitive ? undefined : hexId("frm");
  // Frame sensible : émise, mais sans URL ni taille (aucun pixel gardé), comme le noyau.
  const f: BrowserFrame & { svg?: string; fid?: string } = { session_id: s.id, seq: s.seq, ts: new Date().toISOString(), url_host: HOST, title: "La Table du Lac", w: sensitive ? null : 1280, h: sensitive ? null : 800, sensitive, frame_url: null };
  if (fid) {
    f.fid = fid;
    f.svg = pageSvg(step, s.fr, focus);
  }
  s.frames = [...s.frames, f].slice(-20);
  const out = publicFrame(f);
  state.publish({ type: "browser.frame", ...out });
  return out;
}

function publicFrame(f: BrowserFrame & { svg?: string; webp?: Buffer; fid?: string }): BrowserFrame {
  const { svg: _s, webp: _w, fid, ...rest } = f;
  void _s;
  void _w;
  return { ...rest, frame_url: fid ? frameUrl(fid) : null };
}

/** Nina désigne une zone de la dernière frame (présentatrice) : `box` normalisée 0–1. */
function point(state: MockState, s: Session, box: BrowserPoint["box"], label: string, why: string): void {
  const f = [...s.frames].reverse().find((x) => !x.sensitive);
  if (!f || s.status === "handoff") return;
  s.seq += 1;
  const p: BrowserPoint = { session_id: s.id, seq: f.seq, ts: new Date().toISOString(), box, label: label.slice(0, 80), why: why.slice(0, 120) };
  s.points = [...s.points, p].slice(-20);
  state.publish({ type: "browser.point", ...p });
}

function act(state: MockState, s: Session, kind: BrowserAction["kind"], target_label: string, cursor?: { x: number; y: number }): void {
  s.seq += 1;
  const a: BrowserAction = { session_id: s.id, seq: s.seq, ts: new Date().toISOString(), kind, target_label: target_label.slice(0, 80), url_host: HOST, ...(cursor ? { cursor } : {}) };
  s.actions = [...s.actions, a].slice(-20);
  state.publish({ type: "browser.action", ...a });
}

function setStatus(state: MockState, s: Session, status: BrowserSessionStatus, failed = false): void {
  s.status = status;
  updateBubble(state, s.bubbleId, { status: status === "ended" ? (failed ? "failed" : "done") : "working", state: { state: status } });
}

function end(state: MockState, s: Session, reason: BrowserEndReason): void {
  if (s.ended) return;
  s.seq += 1;
  s.handoff = null;
  s.ended = { session_id: s.id, seq: s.seq, reason, at: new Date().toISOString() };
  s.takeoverCodes.clear();
  s.screenCookies.clear();
  setStatus(state, s, "ended", reason === "error" || reason === "timeout");
  state.publish({ type: "browser.ended", session_id: s.id, seq: s.seq, reason });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Carte « envoi externe » nommant la règle du foyer, ancrée sur la frame `seq`. */
function requestSend(state: MockState, s: Session, seq: number): Approval {
  const args = { url_host: HOST, form: "booking", fields: ["date", "guests", "name"] };
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: s.threadId,
    turn_index: 0,
    channel: "web",
    tool_name: "browser_submit",
    arguments: args,
    args_sha256: argsSha256(args),
    effect: "send_external",
    rule: "effect:send_external:allowlist",
    // Libellés de nokker/approvals/rule_labels.py ; `rule_source` est toujours `system` dans le noyau d'aujourd'hui.
    rule_label: s.fr ? "Envoi à un destinataire autorisé" : "Sending to an allowed recipient",
    rule_labels: { fr: "Envoi à un destinataire autorisé", en: "Sending to an allowed recipient", de: "Senden an einen erlaubten Empfänger", it: "Invio a un destinatario autorizzato" },
    rule_source: { kind: "system" },
    context: { browser: { session_id: s.id, seq } },
    reason: s.fr ? `Envoyer la demande de réservation à ${HOST}` : `Send the booking request to ${HOST}`,
    advice: null,
    strength: "standard",
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
  } as Approval;
  state.approvals.set(approval.id, approval);
  state.approvalEffects.set(approval.id, () => `booking request sent to ${HOST}`);
  state.publish({ type: "approval.requested", approval });
  return approval;
}

async function until(pred: () => boolean, maxMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (pred()) return true;
    await wait(150);
  }
  return pred();
}

/** « réserve une table… » : la session scriptée, dans le fil. */
export function startBrowserSession(state: MockState, threadId: string, fr: boolean): string {
  const id = hexId("bs");
  const task = fr ? "Réserver une table pour 4 samedi soir à La Table du Lac" : "Book a table for 4 on Saturday evening at La Table du Lac";
  const b = createBubble(state, threadId, { kind: "browser", title: fr ? "Navigateur" : "Browser", status: "working", state: { session_id: id, state: "running", url_host: HOST, title: "La Table du Lac", task } });
  const s: Session = { id, threadId, bubbleId: b.id, status: "running", seq: 0, frames: [], actions: [], handoff: null, ended: null, takeoverCodes: new Map(), screenCookies: new Map(), points: [], approvalId: null, fr };
  all(state).set(id, s);
  void (async () => {
    await wait(STEP);
    act(state, s, "navigate", `https://${HOST}/`);
    publishFrame(state, s, 0, false);
    await wait(STEP);
    act(state, s, "click", fr ? "Bouton « Réserver »" : "“Book” button", { x: 0.18, y: 0.46 });
    publishFrame(state, s, 1, false, { x: 120, y: 270, w: 520, h: 48 });
    await wait(STEP);
    act(state, s, "type", fr ? "texte saisi (8 car.)" : "typed text (8 chars)", { x: 0.3, y: 0.62 });
    // Champ « Nom » rempli (marqué par le coffre) : la frame qui suit n'est PAS capturée.
    publishFrame(state, s, 2, true);
    await wait(STEP);
    point(state, s, { x: 0.09, y: 0.69, w: 0.21, h: 0.08 }, fr ? "Bouton « Envoyer la demande »" : "“Send the request” button", fr ? "Tout est rempli : samedi 19:30, 4 personnes." : "Everything is filled in: Saturday 19:30, 4 guests.");
    await wait(STEP);
    act(state, s, "click", fr ? "Bouton « Envoyer la demande »" : "“Send the request” button", { x: 0.2, y: 0.73 });
    const anchor = publishFrame(state, s, 3, false, { x: 120, y: 560, w: 260, h: 56 });
    const a = requestSend(state, s, anchor.seq);
    s.approvalId = a.id;
    await until(() => state.approvals.get(a.id)!.status !== "pending" || !!s.ended, 10 * 60_000);
    if (s.ended) return;
    const st = state.approvals.get(a.id)!.status;
    if (st !== "approved" && st !== "executed") return end(state, s, "cancelled");
    await wait(STEP);
    act(state, s, "wait", fr ? "Page de vérification" : "Verification page");
    publishFrame(state, s, 4, false);
    // 2FA : la personne prend la main.
    s.seq += 1;
    const code = randomBytes(18).toString("base64url");
    s.takeoverCodes.set(code, Date.now() + TAKEOVER_TTL_MS);
    // (noyau : la passation expire au bout de 10 min → browser.ended timeout)
    s.handoff = { session_id: s.id, seq: s.seq, reason: "2fa", url_host: HOST, takeover_url: `/v1/browser/takeover/${code}`, expires_at: new Date(Date.now() + TAKEOVER_TTL_MS).toISOString() };
    setStatus(state, s, "handoff");
    state.publish({ type: "browser.handoff", ...s.handoff });
    await until(() => s.status !== "handoff", 10 * 60_000);
    if (s.ended) return;
    await wait(STEP);
    act(state, s, "read", fr ? "Confirmation de la demande" : "Request confirmation");
    publishFrame(state, s, 5, false);
    await wait(STEP);
    end(state, s, "done");
  })();
  return id;
}

function view(s: Session): BrowserSessionView {
  const last = s.frames[s.frames.length - 1];
  return {
    session_id: s.id,
    state: s.status,
    seq: s.seq,
    last_frame: last ? publicFrame(last) : null,
    actions: s.actions,
    points: s.points,
    url_host: HOST,
    title: "La Table du Lac",
    bubble_id: s.bubbleId,
    handoff: s.handoff,
    ended: s.ended ? { reason: s.ended.reason, at: s.ended.at } : null,
  };
}

/** Routes publiques signées (frames, vue de reprise) : AVANT l'authentification, comme les images d'aperçu. */
export function handleBrowserPublic(state: MockState, method: string, url: URL, cookie: string | undefined, sendJson: (st: number, obj: unknown) => void, sendRaw: (st: number, type: string, body: string | Buffer, headers: Record<string, string>) => void): boolean {
  const fm = /^\/v1\/browser\/frames\/(frm_[0-9a-f]+)\.webp$/.exec(url.pathname);
  if (method === "GET" && fm) {
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    if (!exp || sign(fm[1]!, exp) !== sig) return void sendJson(403, { error: { code: "bad_signature", message: "bad signature" } }), true;
    if (Date.now() > exp) return void sendJson(410, { error: { code: "frame_expired", message: "frame expired" } }), true;
    for (const s of all(state).values()) {
      const f = s.frames.find((x) => x.fid === fm[1]);
      if (f?.webp) return void sendRaw(200, "image/webp", f.webp, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }), true;
      if (f?.svg) return void sendRaw(200, "image/svg+xml", f.svg, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }), true;
    }
    return void sendJson(410, { error: { code: "frame_gone", message: "frame gone" } }), true;
  }
  // Écran de reprise : seulement avec le cookie posé par l'échange du code (lié à cette session) ; le noyau redirige
  // vers noVNC, le mock sert une page de démonstration.
  const sm = /^\/v1\/browser\/sessions\/(bs_[0-9a-f]+)\/screen$/.exec(url.pathname);
  if (method === "GET" && sm) {
    const s = all(state).get(sm[1]!);
    const c = /(?:^|;\s*)nk_browser_takeover=([A-Za-z0-9_-]+)/.exec(cookie ?? "")?.[1];
    const exp = s && c ? s.screenCookies.get(c) : undefined;
    if (!s || exp === undefined || exp < Date.now()) return void sendJson(403, { error: { code: "takeover_cookie", message: "no takeover cookie" } }), true;
    if (s.status !== "handoff") return void sendJson(410, { error: { code: "not_in_handoff", message: "not in handoff" } }), true;
    const html = `<!doctype html><meta charset="utf-8"><title>${s.fr ? "Reprise en main (démo)" : "Take over (demo)"}</title><body style="font:16px system-ui;margin:40px"><h1>${HOST}</h1><p>${s.fr ? "Vue interactive de l'onglet (démo). Saisissez le code, puis revenez dans Nokker et touchez « J'ai fini »." : "Interactive view of the tab (demo). Enter the code, then go back to Nokker and tap “I'm done”."}</p></body>`;
    return void sendRaw(200, "text/html; charset=utf-8", html, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }), true;
  }
  return false;
}

/** Routes de la session du titulaire. */
export function handleBrowserSession(state: MockState, method: string, path: string, sendJson: (st: number, obj: unknown, headers?: Record<string, string>) => void): boolean {
  // Échange du code de reprise (Bearer du titulaire) → URL de l'écran + cookie lié à la session ; usage unique.
  const tm = /^\/v1\/browser\/takeover\/([A-Za-z0-9_-]{24})$/.exec(path);
  if (tm && (method === "POST" || method === "GET")) {
    for (const s of all(state).values()) {
      const exp = s.takeoverCodes.get(tm[1]!);
      if (exp === undefined) continue;
      s.takeoverCodes.delete(tm[1]!);
      if (exp < Date.now() || s.status !== "handoff") break;
      const v = randomBytes(24).toString("base64url");
      s.screenCookies.set(v, Date.now() + 900_000);
      const screen_url = `/v1/browser/sessions/${s.id}/screen`;
      const cookie = `nk_browser_takeover=${v}; Path=${screen_url}; HttpOnly; Secure; SameSite=Strict; Max-Age=900`;
      if (method === "GET") return void sendJson(302, { screen_url }, { Location: screen_url, "Set-Cookie": cookie }), true;
      return void sendJson(200, { session_id: s.id, screen_url }, { "Set-Cookie": cookie, "Cache-Control": "no-store" }), true;
    }
    return void sendJson(410, { error: { code: "takeover_used", message: "used or expired" } }), true;
  }
  // Narration d'un point (contrat noyau : texte = le `why` que le noyau a déjà émis pour ce seq, jamais du client).
  // MOCK_NARRATION : « 404 » = route absente (noyau d'avant), « 503 » = synthèse éteinte, « 429 » = trop de demandes.
  const nm = /^\/v1\/browser\/sessions\/(bs_[0-9a-f]+)\/narrations\/(\d+)\/speech\/timed$/.exec(path);
  if (nm && method === "POST") {
    const mode = process.env.MOCK_NARRATION ?? "1";
    if (mode === "404" || mode === "off") return void sendJson(404, { error: { code: "not_found", message: "not found" } }), true;
    if (mode === "503") return void sendJson(503, { error: { code: "tts_off", message: "speech is off" } }), true;
    if (mode === "429") return void sendJson(429, { error: { code: "rate_limited", message: "slow down" } }, { "Retry-After": "30" }), true;
    const sess = all(state).get(nm[1]!);
    const pt = sess?.points.find((x) => x.seq === Number(nm[2]));
    const text = pt ? pt.why || pt.label : "";
    if (!text) return void sendJson(404, { error: { code: "not_found", message: "nothing to say for this seq" } }), true;
    return void sendJson(200, timedSpeech(text), { "Cache-Control": "no-store" }), true;
  }
  const m = /^\/v1\/browser\/sessions\/(bs_[0-9a-f]+)(\/resume)?$/.exec(path);
  if (!m) return false;
  const s = all(state).get(m[1]!);
  if (!s) return void sendJson(404, { error: { code: "not_found", message: "unknown session" } }), true;
  if (method === "GET" && !m[2]) return void sendJson(200, view(s)), true;
  if (method === "POST" && m[2]) {
    if (s.status === "handoff") {
      s.seq += 1;
      s.handoff = null;
      s.takeoverCodes.clear();
      s.screenCookies.clear();
      setStatus(state, s, "running");
      state.publish({ type: "browser.resumed", session_id: s.id, seq: s.seq, reason: "done" });
    }
    return void sendJson(200, { session_id: s.id, state: s.status, seq: s.seq }), true;
  }
  return void sendJson(405, { error: { code: "method_not_allowed", message: "method not allowed" } }), true;
}

// ---------------------------------------------------------------------------------------------
// Scène « logement » (présentatrice) : un faux site d'annonces, Nina désigne celle qui correspond.
// ---------------------------------------------------------------------------------------------

const STAY_HOST = "sejours.example";
const LISTINGS = [
  { t: "Studio Vieille-Ville", p: "2 voyageurs · 96 €/nuit", c: "#d9c9c2" },
  { t: "Chalet des Pins", p: "6 voyageurs · 210 €/nuit", c: "#c9d6c2" },
  { t: "Appartement Lac", p: "4 voyageurs · balcon · 138 €/nuit", c: "#c2cfd9" },
  { t: "Loft Gare", p: "4 voyageurs · 165 €/nuit", c: "#d9d2c2" },
];

function staySvg(): string {
  const cards = LISTINGS.map((l, i) => {
    const x = 80 + i * 290;
    return `<rect x="${x}" y="200" width="260" height="420" rx="16" fill="#fff" stroke="#e2d8d3"/><rect x="${x}" y="200" width="260" height="200" rx="16" fill="${l.c}"/><text x="${x + 18}" y="450" font-size="22" font-weight="700" fill="#2b2220">${l.t}</text><text x="${x + 18}" y="486" font-size="16" fill="#5b4b45">${l.p}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><rect width="1280" height="800" fill="#faf6f3"/><rect width="1280" height="64" fill="#efe6e1"/><rect x="120" y="16" width="720" height="32" rx="16" fill="#fff"/><text x="140" y="38" font-size="16" fill="#7a6a64">https://${STAY_HOST}/recherche</text><text x="80" y="150" font-size="34" font-weight="700" fill="#2b2220">Séjours au bord du lac</text>${cards}</svg>`;
}

export function startStaySession(state: MockState, threadId: string, fr: boolean): string {
  const id = hexId("bs");
  const task = fr ? "Trouver un logement pour 4 avec balcon, moins de 150 € la nuit" : "Find a place for 4 with a balcony, under 150 € a night";
  const b = createBubble(state, threadId, { kind: "browser", title: fr ? "Navigateur" : "Browser", status: "working", state: { session_id: id, state: "running", url_host: STAY_HOST, title: "Séjours", task } });
  const s: Session = { id, threadId, bubbleId: b.id, status: "running", seq: 0, frames: [], actions: [], handoff: null, ended: null, takeoverCodes: new Map(), screenCookies: new Map(), points: [], approvalId: null, fr };
  all(state).set(id, s);
  const frame = (): void => {
    s.seq += 1;
    const fid = hexId("frm");
    const f = { session_id: s.id, seq: s.seq, ts: new Date().toISOString(), url_host: STAY_HOST, title: "Séjours", w: 1280, h: 800, sensitive: false, frame_url: null, fid, svg: staySvg() };
    s.frames = [...s.frames, f].slice(-20);
    state.publish({ type: "browser.frame", ...publicFrame(f) });
  };
  // Comme act(), mais sur l'hôte de la scène : gardé dans la session (un grand écran ouvert plus tard le relit).
  const stayAct = (kind: BrowserAction["kind"], target_label: string): void => {
    s.seq += 1;
    const x: BrowserAction = { session_id: s.id, seq: s.seq, ts: new Date().toISOString(), kind, target_label, url_host: STAY_HOST };
    s.actions = [...s.actions, x].slice(-20);
    state.publish({ type: "browser.action", ...x });
  };
  void (async () => {
    await wait(STEP);
    stayAct("navigate", STAY_HOST);
    frame();
    await wait(STEP);
    stayAct("read", fr ? "Liste des annonces" : "Listings");
    await wait(STEP);
    point(state, s, { x: 0.512, y: 0.245, w: 0.206, h: 0.53 }, "Appartement Lac", fr ? "4 voyageurs, balcon, 138 €/nuit" : "4 guests, balcony, 138 €/night");
    // Nina reste sur l'annonce le temps de la présenter (la démo parle ; le grand écran peut s'ouvrir en cours).
    await wait(Number(process.env.MOCK_BROWSER_STAY_MS ?? 60_000));
    end(state, s, "done");
  })();
  return id;
}

// ---------------------------------------------------------------------------------------------
// Scène « Lisbonne » : l'enregistrement de séjours.test (faux site d'annonces, aucune donnée réelle) fait par le
// navigateur du pool (frames WebP 640×381 et leur `_meta` : nokker_action, nokker_box en 0–1 de la frame).
// ---------------------------------------------------------------------------------------------

const SEJOURS = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/sejours");

interface Recorded {
  frame: string;
  nokker_action: { seq: number; tool: string; label: string; url: string; title: string };
  nokker_box: { x: number; y: number; w: number; h: number } | null;
}

export function startLisbonSession(state: MockState, threadId: string, fr: boolean): string {
  // index.json : la liste des étapes telles qu'enregistrées (mêmes objets que les NN-*.json).
  const steps = JSON.parse(readFileSync(join(SEJOURS, "index.json"), "utf8")) as Recorded[];
  const host = "sejours.test";
  const id = hexId("bs");
  const task = fr ? "Trouver un logement à Lisbonne pour 4" : "Find a place in Lisbon for 4";
  const b = createBubble(state, threadId, { kind: "browser", title: fr ? "Navigateur" : "Browser", status: "working", state: { session_id: id, state: "running", url_host: host, title: "séjours — Lisbonne", task } });
  const s: Session = { id, threadId, bubbleId: b.id, status: "running", seq: 0, frames: [], actions: [], handoff: null, ended: null, takeoverCodes: new Map(), screenCookies: new Map(), points: [], approvalId: null, fr };
  all(state).set(id, s);
  void (async () => {
    for (const st of steps) {
      await wait(STEP);
      const kind: BrowserAction["kind"] = st.nokker_action.tool === "navigate" ? "navigate" : st.nokker_action.tool === "scroll" ? "scroll" : "read";
      if (st.nokker_action.tool !== "box") {
        s.seq += 1;
        const a: BrowserAction = { session_id: s.id, seq: s.seq, ts: new Date().toISOString(), kind, target_label: kind === "navigate" ? host : st.nokker_action.label.slice(0, 80), url_host: host, ok: true };
        s.actions = [...s.actions, a].slice(-20);
        state.publish({ type: "browser.action", ...a });
      }
      s.seq += 1;
      const f = { session_id: s.id, seq: s.seq, ts: new Date().toISOString(), url_host: host, title: st.nokker_action.title, w: 640, h: 381, sensitive: false, frame_url: null, fid: hexId("frm"), webp: readFileSync(join(SEJOURS, st.frame)) };
      s.frames = [...s.frames, f].slice(-20);
      state.publish({ type: "browser.frame", ...publicFrame(f) });
      if (st.nokker_box) point(state, s, st.nokker_box, "Appartement lumineux à Alfama", fr ? "4 voyageurs, lumineux, quartier d'Alfama" : "4 guests, bright, Alfama district");
    }
    await wait(Number(process.env.MOCK_BROWSER_STAY_MS ?? 60_000));
    end(state, s, "done");
  })();
  return id;
}
