/**
 * Déclencheur `mail:<filtre>` du Crew (BUBBLES §9.5 « Courrier », LOKKAL §7.25) — mock. Mêmes refus, au mot près, que
 * le noyau (`nokker/agents/spec.py`, `nokker/agents/mailwatch.py`) : `400 {error: {message, code}}` avec `code` =
 * `no_mail_trigger` | `mailbox_unlinked` | `bad_mail_filter` (train 5fe8785). Relève
 * simulée : option `crewMail` ou `MOCK_CREW_MAIL` = `on` (défaut : moteur et boîte reliée), `off` (pas de relève :
 * NO_MAIL_TRIGGER), `nobox` (aucune boîte reliée). Réglage : `POST /v1/dev/crew-mail {watch?, agent?, state?: "ok" |
 * "error", fire?: true}` (un mail qui passe le filtre : un passage).
 */
import type { Agent, AgentMailWatch } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

export type CrewMail = "on" | "off" | "nobox";

export const NO_MAIL_TRIGGER =
  "trigger.event mail:<filtre> : pas disponible (aucune relève du courrier ne déclenche un agent, il ne tournerait jamais) — à la place : un déclencheur schedule dont la mission lit la boîte (mail_search), ou webhook:<id> appelé par le service de courrier";
export const NO_MAILBOX = "trigger.event mail:<filtre> : aucune boîte mail reliée à ce compte — relier la boîte d'abord (Connecteurs), la relève lit celle-là";

const POLL_S = 120;
const MAX_RUNS = 12;
const FIELDS = ["from", "to", "cc", "subject"];
const IS = ["unread", "read", "starred"];
const WHY: Record<string, string> = {
  after: "la relève ne voit que les messages arrivés après l'armement (son curseur s'en charge)",
  before: "la relève ne voit que les messages arrivés après l'armement (son curseur s'en charge)",
  in: "la relève lit la boîte de réception (INBOX) seulement en v1",
  label: "la relève lit la boîte de réception (INBOX) seulement en v1",
};
const TOKEN = /-?[A-Za-z_]+:"[^"]*"|-?"[^"]*"|\S+/g;

export class MailFilterError extends Error {}
const bad = (msg: string): MailFilterError => new MailFilterError(`trigger.event mail:<filtre> : ${msg}`);

function value(v: string, what: string): void {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!v.trim()) throw bad(`${what} sans valeur`);
  if (v.includes('"')) throw bad(`guillemet mal placé dans « ${what} »`);
  if (v.length > 100) throw bad(`valeur de « ${what} » au-delà de 100 caractères`);
}

/** `parse_mail_filter` du noyau : le filtre normalisé, ou `MailFilterError` avec sa raison. */
export function parseMailFilter(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) throw bad("caractère de contrôle interdit");
  const raw = text.trim();
  if (!raw) throw bad("filtre vide (mail:* = tout nouveau message)");
  if (raw === "*") return "*";
  if ((raw.match(/"/g) ?? []).length % 2) throw bad("guillemet non fermé");
  const tokens = raw.match(TOKEN) ?? [];
  if (tokens.length > 8) throw bad("8 termes au plus");
  for (const tok of tokens) {
    const t = tok.startsWith("-") && tok.length > 1 ? tok.slice(1) : tok;
    if (t === "OR" || t === "AND" || t === "NOT") throw bad(`pas de ${t} en v1 : tous les termes doivent correspondre (un agent par alternative)`);
    if (t.startsWith("(") || t.endsWith(")")) throw bad("pas de parenthèse en v1 : tous les termes doivent correspondre");
    if (t === "*") throw bad("* s'emploie seul (mail:*)");
    const i = t.indexOf(":");
    const key = i > 0 ? t.slice(0, i) : "";
    if (i > 0 && /^[A-Za-z_]+$/.test(key)) {
      const k = key.toLowerCase();
      const v = t.slice(i + 1);
      if (FIELDS.includes(k)) value(v, `${k}:`);
      else if (k === "is") {
        if (!IS.includes(v.toLowerCase())) throw bad(`« is:${v.slice(0, 20)} » refusé — is:unread, is:read ou is:starred`);
      } else throw bad(`critère « ${k}: » refusé — ${WHY[k] ?? "critère hors du sous-ensemble (from:, to:, cc:, subject:, is:, mots libres)"}`);
    } else value(t, "mot");
  }
  return tokens.join(" ");
}

export const mailFilterOf = (a: Pick<Agent, "trigger">): string | null =>
  a.trigger?.kind === "event" && a.trigger.event.startsWith("mail:") ? a.trigger.event.slice(5) : null;

export interface MailRefusal {
  message: string;
  code: "no_mail_trigger" | "mailbox_unlinked" | "bad_mail_filter";
}

/** Refus du noyau pour un `mail:` (création, PATCH, armement) selon la relève de l'instance, ou null. */
export function mailRefusal(state: MockState): MailRefusal | null {
  if (state.crewMail === "off") return { message: NO_MAIL_TRIGGER, code: "no_mail_trigger" };
  if (state.crewMail === "nobox") return { message: NO_MAILBOX, code: "mailbox_unlinked" };
  return null;
}

interface W {
  state: "ok" | "error" | null;
  last: string | null;
  runs: number;
}
const watches = new WeakMap<MockState, Map<string, W>>();
function w(state: MockState, id: string): W {
  let m = watches.get(state);
  if (!m) watches.set(state, (m = new Map()));
  let x = m.get(id);
  if (!x) m.set(id, (x = { state: null, last: null, runs: 0 }));
  return x;
}

/** Désarmé, déclencheur changé, supprimé : le curseur est oublié (réarmé : nouvelle ligne de base). */
export function forgetWatch(state: MockState, id: string): void {
  watches.get(state)?.delete(id);
}

/** `mail_watch` de la carte d'un agent (`MailWatcher.describe`) : absent hors `mail:` ou sans relève. */
export function describeWatch(state: MockState, a: Agent): AgentMailWatch | null {
  if (mailFilterOf(a) === null || state.crewMail === "off") return null;
  const base = { folder: "INBOX", poll_s: POLL_S, max_runs_per_hour: MAX_RUNS };
  if (a.status === "paused") return { state: "off", ...base };
  const x = w(state, a.id);
  if (!x.state) return { state: "waiting", ...base, runs_last_hour: x.runs, pending: 0, error: null };
  const next = new Date(Date.parse(x.last!) + POLL_S * 1000).toISOString();
  return {
    state: x.state,
    ...base,
    runs_last_hour: x.runs,
    last_poll_at: x.last,
    last_ok_at: x.state === "ok" ? x.last : null,
    next_poll_at: next,
    error: x.state === "error" ? "imap_auth: identifiants refusés par le serveur de courrier (démo)" : null,
    pending: 0,
    held: null,
    uidvalidity: 1,
    resync_at: null,
    last_run_id: null,
  };
}

/** Une relève de démo : `ok` (et un passage si `fire`) ou `error`. */
export function pollWatch(state: MockState, id: string, st: "ok" | "error", fired: boolean): void {
  const x = w(state, id);
  x.state = st;
  x.last = new Date().toISOString();
  if (fired) x.runs += 1;
}
