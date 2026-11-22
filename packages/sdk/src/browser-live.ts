/**
 * « L'agent qui montre » (V3) — contrat noyau docs/BROWSER-LIVE.md (p2/v-agent-montre-core f0603e0, drapeau
 * `browser_live`, exposé dans `GET /v1/capabilities`).
 *
 * - Une bulle `kind: "browser"` par session navigateur, créée par le noyau dans le fil du tour ; `state` n'est mis à
 *   jour qu'aux transitions (running → handoff → running → ended).
 * - Sur `/v1/events`, rattachés par `session_id` : `browser.frame` (capture, au plus 1/s), `browser.action` (ce que fait
 *   l'agent), `browser.handoff` (2FA, connexion, CAPTCHA : la personne prend la main), `browser.resumed`, `browser.ended`.
 * - `GET /v1/browser/sessions/{id}` : l'état courant (source de vérité à l'ouverture et après une reconnexion).
 * - Captures : URL signée de même origine (`frame_url`, 60 s, `no-store`), jamais gardées dans le cloud ; une frame
 *   `sensitive` (champ mot de passe, carte, code à usage unique… focalisé OU non vide) n'est JAMAIS capturée.
 * - `browser.action` de `type` ne porte jamais le texte saisi.
 */

export type BrowserSessionStatus = "running" | "handoff" | "ended";
export type BrowserActionKind = "navigate" | "click" | "type" | "scroll" | "read" | "wait";
export type BrowserHandoffReason = "2fa" | "login" | "captcha" | "challenge";
export type BrowserEndReason = "done" | "cancelled" | "error" | "timeout";

/** `state` de la bulle `browser`. `task` : résumé court (≤ 120 car.), sans valeur saisie. */
export interface BrowserBubbleState {
  session_id: string;
  state: BrowserSessionStatus;
  url_host?: string;
  title?: string;
  task?: string;
}

export interface BrowserFrame {
  session_id: string;
  seq: number;
  /** ISO 8601 UTC à la milliseconde. */
  ts: string;
  url_host: string;
  title: string;
  /** `null` quand `sensitive` : aucun pixel gardé. WebP ≈ 640 px (≤ 1280). */
  frame_url?: string | null;
  w: number | null;
  h: number | null;
  sensitive: boolean;
}

export interface BrowserAction {
  session_id: string;
  seq: number;
  /** ISO 8601 UTC à la milliseconde. */
  ts: string;
  kind: BrowserActionKind;
  /** Nom accessible de la cible (≤ 80 car.) ; pour `type` : « texte saisi (n car.) », jamais le texte. */
  target_label: string;
  url_host: string;
  /** Position normalisée 0–1 dans la capture (curseur). */
  cursor?: { x: number; y: number };
  /** `false` : le geste a été tenté et a échoué. Un geste REFUSÉ par une règle n'émet jamais d'action (seule la carte
   * d'approbation, avec `context.browser`, le représente). */
  ok?: boolean;
}

/** `browser.point` (outil noyau `browser_point`) : Nina désigne une zone de la frame de CE `seq` (la dernière non
 * sensible), `box` normalisée 0–1 comme `cursor` ; `why` (≤ 120 car.) est sa bulle d'explication. Jamais émis sur
 * une cible sensible ni pendant une passation. */
export interface BrowserPoint {
  session_id: string;
  seq: number;
  ts: string;
  box: { x: number; y: number; w: number; h: number };
  label: string;
  why: string;
}

export interface BrowserHandoff {
  session_id: string;
  seq: number;
  reason: BrowserHandoffReason;
  url_host: string;
  /** `/v1/browser/takeover/<code>`, usage unique : `POST` authentifié → `{session_id, screen_url}` + cookie
   * `nk_browser_takeover` (HttpOnly, Strict, chemin de l'écran) ; un lien nu ne marche pas (voulu). Expire à 10 min. */
  takeover_url: string;
  expires_at: string;
}

export interface BrowserEnded {
  session_id: string;
  seq: number;
  reason: BrowserEndReason;
}

/** `GET /v1/browser/sessions/{id}` (404 : inconnue, hors audience ou oubliée 15 min après la fin). */
export interface BrowserSessionView {
  session_id?: string;
  state: BrowserSessionStatus;
  seq?: number;
  last_frame: BrowserFrame | null;
  actions: BrowserAction[];
  /** Les 20 dernières désignations (présentatrice) : un écran ouvert en cours de route les retrouve. */
  points?: BrowserPoint[];
  url_host?: string;
  title?: string;
  bubble_id?: string;
  handoff?: BrowserHandoff | null;
  ended?: { reason: BrowserEndReason; at?: string; seq?: number } | null;
}

/** Réponse de l'échange du code de reprise (`POST takeover_url`). */
export interface BrowserTakeover {
  session_id: string;
  screen_url: string;
}

export type BrowserFrameEvent = { type: "browser.frame" } & BrowserFrame;
export type BrowserActionEvent = { type: "browser.action" } & BrowserAction;
export type BrowserHandoffEvent = { type: "browser.handoff" } & BrowserHandoff;
export type BrowserPointEvent = { type: "browser.point" } & BrowserPoint;
export type BrowserResumedEvent = { type: "browser.resumed"; session_id: string; seq: number; reason?: "done" };
export type BrowserEndedEvent = { type: "browser.ended" } & BrowserEnded;
export type BrowserEvent = BrowserFrameEvent | BrowserActionEvent | BrowserPointEvent | BrowserHandoffEvent | BrowserResumedEvent | BrowserEndedEvent;

export const BROWSER_EVENT_TYPES = ["browser.frame", "browser.action", "browser.point", "browser.handoff", "browser.resumed", "browser.ended"] as const;

/** Origine d'une règle de carte (« bloqué par : … ») : celle du foyer porte le nom que le foyer lui a donné. */
export interface ApprovalRuleSource {
  kind: "system" | "household";
  name?: string;
}

/** Ce qu'une carte affiche après « Bloqué par : » — le nom donné par le foyer, sinon le libellé, sinon l'identifiant. */
export function blockedByText(a: { rule: string; rule_label?: string | null; rule_source?: ApprovalRuleSource | null }): string | null {
  if (!a.rule_label && !a.rule_source) return null;
  if (a.rule_source?.kind === "household" && a.rule_source.name?.trim()) return a.rule_source.name.trim();
  return a.rule_label?.trim() || a.rule;
}

/** Fenêtre gardée par session dans l'interface (même borne que le noyau). */
export const BROWSER_KEEP = 20;

export interface BrowserLive {
  session_id: string;
  status: BrowserSessionStatus;
  frames: BrowserFrame[];
  actions: BrowserAction[];
  /** Désignations de Nina (présentatrice), les 20 dernières. */
  points: BrowserPoint[];
  handoff: BrowserHandoff | null;
  ended: BrowserEnded | null;
  /** Plus grand `seq` vu (les événements en retard ou rejoués sont ignorés). */
  seq: number;
}

export const emptyBrowserLive = (session_id: string): BrowserLive => ({ session_id, status: "running", frames: [], actions: [], points: [], handoff: null, ended: null, seq: 0 });

const keepLast = <T extends { seq: number }>(list: T[], item: T): T[] => {
  if (list.some((x) => x.seq === item.seq)) return list;
  return [...list, item].sort((a, b) => a.seq - b.seq).slice(-BROWSER_KEEP);
};

/** Réducteur pur : un événement `browser.*` (rejeu par Last-Event-ID compris) → l'état de la session. */
export function applyBrowserEvent(s: BrowserLive, e: BrowserEvent): BrowserLive {
  if (e.session_id !== s.session_id) return s;
  const seq = Math.max(s.seq, e.seq);
  switch (e.type) {
    case "browser.frame": {
      const { type: _t, ...f } = e;
      void _t;
      return { ...s, seq, frames: keepLast(s.frames, f) };
    }
    case "browser.action": {
      const { type: _t, ...a } = e;
      void _t;
      return { ...s, seq, actions: keepLast(s.actions, a) };
    }
    case "browser.point": {
      const { type: _t, ...p } = e;
      void _t;
      return { ...s, seq, points: keepLast(s.points ?? [], p) };
    }
    case "browser.handoff": {
      if (s.ended || e.seq < s.seq) return { ...s, seq };
      const { type: _t, ...h } = e;
      void _t;
      return { ...s, seq, status: "handoff", handoff: h };
    }
    case "browser.resumed":
      if (s.ended || (s.handoff && e.seq < s.handoff.seq)) return { ...s, seq };
      return { ...s, seq, status: "running", handoff: null };
    case "browser.ended": {
      const { type: _t, ...x } = e;
      void _t;
      return { ...s, seq, status: "ended", handoff: null, ended: x };
    }
    default:
      return s;
  }
}

/** État courant lu par `GET /v1/browser/sessions/{id}` → état d'interface (la vue du noyau fait foi). */
export function browserLiveFromView(session_id: string, v: BrowserSessionView, prev?: BrowserLive): BrowserLive {
  let frames = prev?.frames.filter((f) => f.seq < (v.last_frame?.seq ?? Infinity)) ?? [];
  if (v.last_frame) frames = keepLast(frames, v.last_frame);
  let actions = prev?.actions ?? [];
  for (const a of v.actions) actions = keepLast(actions, a);
  const seqs = [prev?.seq ?? 0, v.seq ?? 0, v.last_frame?.seq ?? 0, ...v.actions.map((a) => a.seq), v.handoff?.seq ?? 0, v.ended?.seq ?? 0];
  const seq = Math.max(...seqs);
  const ended = v.state === "ended" && v.ended ? { session_id, seq: v.ended.seq ?? seq, reason: v.ended.reason } : v.state === "ended" ? { session_id, seq, reason: "done" as const } : null;
  let points = prev?.points ?? [];
  for (const p of v.points ?? []) points = keepLast(points, p);
  return { session_id, status: v.state, frames, actions, points, handoff: v.state === "handoff" ? (v.handoff ?? null) : null, ended, seq };
}
