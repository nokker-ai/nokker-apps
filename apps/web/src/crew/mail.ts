/**
 * Déclencheur `mail:<filtre>` d'un agent (BUBBLES §9.5 « Courrier », LOKKAL §7.25) : textes FR/EN, contrôle du filtre
 * AVANT l'envoi (même sous-ensemble que `parse_mail_filter` du noyau, qui reste seul juge) et traduction de ses refus.
 * Le noyau répond `400 {error: {message, code}}` : `no_mail_trigger`, `mailbox_unlinked`, `bad_mail_filter` (train
 * 5fe8785) ; un noyau plus ancien n'a que le message, reconnu alors à son texte.
 */
import { NokkerApiError, type AgentMailWatch } from "@nokker-apps/sdk";
import { trIn } from "../i18n/index.js";

export type Lang = "fr" | "en";

const FR = {
  kind: "Déclencheur",
  manual: "À la demande",
  schedule: "Planifié (cron)",
  once: "Une fois",
  alert: "Sur alerte",
  webhook: "Sur appel externe (webhook)",
  mail: "À la réception d'un mail",
  cron: "Cron (5 champs)",
  cronPh: "0 7 * * 1-5",
  tz: "Fuseau",
  at: "Date et heure",
  alertName: "Nom de l'alerte",
  alertPh: "DiskAlmostFull",
  webhookId: "Identifiant du webhook",
  webhookPh: "facturation",
  filter: "Filtre",
  filterPh: "from:factures@example.com subject:facture",
  anyMail: "Tout nouveau message",
  filterHelp: "Tous les termes doivent correspondre : from:, to:, cc:, subject: (valeur ou \"entre guillemets\"), is:unread, is:read, is:starred, mots libres, - devant un terme pour l'exclure. 8 termes au plus.",
  filterNote: "La relève lit la boîte de réception reliée au compte (Connecteurs), sans rien marquer comme lu. Un agent déclenché par un mail ne lève jamais d'écriture.",
  edit: "Modifier le déclencheur",
  save: "Enregistrer",
  cancel: "Annuler",
  saved: "Déclencheur enregistré.",
  savedPaused: "Déclencheur enregistré. L'agent est au repos : arme-le pour lancer la relève.",
  newAgent: "Nouvel agent",
  name: "Nom",
  namePh: "Tri des factures",
  role: "Mission",
  rolePh: "Classe chaque facture reçue et me prévient si une échéance tombe cette semaine.",
  create: "Créer",
  created: "Agent « {name} » créé.",
  createdPaused: "Agent « {name} » créé au repos : arme-le pour qu'il tourne.",
  watch: "Relève du courrier",
  w_off: "à l'arrêt (agent au repos)",
  w_waiting: "armée, première relève à venir",
  w_ok: "en marche",
  w_error: "en erreur",
  every: "toutes les {s} s, {folder}",
  lastPoll: "dernière relève {at}",
  nextPoll: "prochaine {at}",
  pending: "{n} message(s) en attente",
  runs: "{n} passage(s) sur {max} cette heure",
  resync: "dossier reconstruit {at} : nouvelle ligne de base, rien n'est rejoué",
  e_no_trigger: "Le déclenchement par mail n'est pas disponible ici : aucune relève du courrier sur ce serveur. À la place : un déclencheur planifié dont la mission lit la boîte, ou un webhook appelé par le service de courrier.",
  e_no_mailbox: "Aucune boîte mail n'est reliée à ce compte : relie-la d'abord (onglet Connecteurs), la relève lit celle-là.",
  e_filter: "Filtre refusé : {why}",
  e_required: "Champ requis.",
  f_empty: "filtre vide (* = tout nouveau message)",
  f_control: "caractère de contrôle interdit",
  f_quote: "guillemet non fermé",
  f_terms: "8 termes au plus",
  f_bool: "pas de {op} : tous les termes doivent correspondre (un agent par alternative)",
  f_paren: "pas de parenthèse : tous les termes doivent correspondre",
  f_star: "* s'emploie seul",
  f_is: "« is:{v} » refusé : is:unread, is:read ou is:starred",
  f_date: "« {k}: » refusé : la relève ne voit que les messages arrivés après l'armement",
  f_folder: "« {k}: » refusé : la relève lit la boîte de réception seulement",
  f_key: "« {k}: » refusé : from:, to:, cc:, subject:, is: ou mots libres",
  f_value: "« {k} » sans valeur",
  f_long: "valeur de « {k} » au-delà de 100 caractères",
  f_inner: "guillemet mal placé dans « {k} »",
};
type Key = keyof typeof FR;

const EN: Record<Key, string> = {
  kind: "Trigger",
  manual: "On demand",
  schedule: "Scheduled (cron)",
  once: "Once",
  alert: "On alert",
  webhook: "On external call (webhook)",
  mail: "When a mail arrives",
  cron: "Cron (5 fields)",
  cronPh: "0 7 * * 1-5",
  tz: "Time zone",
  at: "Date and time",
  alertName: "Alert name",
  alertPh: "DiskAlmostFull",
  webhookId: "Webhook id",
  webhookPh: "billing",
  filter: "Filter",
  filterPh: "from:invoices@example.com subject:invoice",
  anyMail: "Any new message",
  filterHelp: "Every term must match: from:, to:, cc:, subject: (value or \"in quotes\"), is:unread, is:read, is:starred, free words, - before a term to exclude it. 8 terms at most.",
  filterNote: "The watch reads the inbox linked to the account (Connectors) and marks nothing as read. An agent triggered by a mail never lifts a write.",
  edit: "Change the trigger",
  save: "Save",
  cancel: "Cancel",
  saved: "Trigger saved.",
  savedPaused: "Trigger saved. The agent is paused: arm it to start the watch.",
  newAgent: "New agent",
  name: "Name",
  namePh: "Invoice sorting",
  role: "Mission",
  rolePh: "Files every invoice received and tells me when a due date falls this week.",
  create: "Create",
  created: "Agent “{name}” created.",
  createdPaused: "Agent “{name}” created paused: arm it so it runs.",
  watch: "Mail watch",
  w_off: "stopped (agent paused)",
  w_waiting: "armed, first check to come",
  w_ok: "running",
  w_error: "failing",
  every: "every {s} s, {folder}",
  lastPoll: "last check {at}",
  nextPoll: "next {at}",
  pending: "{n} message(s) waiting",
  runs: "{n} of {max} run(s) this hour",
  resync: "folder rebuilt {at}: new baseline, nothing replayed",
  e_no_trigger: "Mail triggers are not available here: this server has no mail watch. Instead: a scheduled trigger whose mission reads the mailbox, or a webhook called by the mail service.",
  e_no_mailbox: "No mailbox is linked to this account: link it first (Connectors tab), the watch reads that one.",
  e_filter: "Filter refused: {why}",
  e_required: "Required field.",
  f_empty: "empty filter (* = any new message)",
  f_control: "control character not allowed",
  f_quote: "unclosed quote",
  f_terms: "8 terms at most",
  f_bool: "no {op}: every term must match (one agent per alternative)",
  f_paren: "no parentheses: every term must match",
  f_star: "* is used alone",
  f_is: "“is:{v}” refused: is:unread, is:read or is:starred",
  f_date: "“{k}:” refused: the watch only sees messages arriving after arming",
  f_folder: "“{k}:” refused: the watch reads the inbox only",
  f_key: "“{k}:” refused: from:, to:, cc:, subject:, is: or free words",
  f_value: "“{k}” without a value",
  f_long: "value of “{k}” over 100 characters",
  f_inner: "misplaced quote in “{k}”",
};

export const TEXTS: Record<Lang, Record<Key, string>> = { fr: FR, en: EN };

export function m(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  return TEXTS[lang][key].replace(/\{(\w+)\}/g, (s, k: string) => (k in vars ? String(vars[k]) : s));
}

const FIELDS = ["from", "to", "cc", "subject"];
const IS = ["unread", "read", "starred"];
const TOKEN = /-?[A-Za-z_]+:"[^"]*"|-?"[^"]*"|\S+/g;
const MAX_TERMS = 8;
const MAX_VALUE = 100;

export type FilterCheck = { ok: true; filter: string } | { ok: false; key: Key; vars?: Record<string, string> };

/** Le sous-ensemble sûr de `parse_mail_filter` (nokker/agents/mailwatch.py) : le filtre normalisé (termes séparés par
 * une espace), ou la raison du refus. */
export function checkMailFilter(text: string): FilterCheck {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) return { ok: false, key: "f_control" };
  const raw = text.trim();
  if (!raw) return { ok: false, key: "f_empty" };
  if (raw === "*") return { ok: true, filter: "*" };
  if ((raw.match(/"/g) ?? []).length % 2) return { ok: false, key: "f_quote" };
  const tokens = raw.match(TOKEN) ?? [];
  if (tokens.length > MAX_TERMS) return { ok: false, key: "f_terms" };
  const value = (v: string, k: string): FilterCheck | null => {
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!v.trim()) return { ok: false, key: "f_value", vars: { k } };
    if (v.includes('"')) return { ok: false, key: "f_inner", vars: { k } };
    if (v.length > MAX_VALUE) return { ok: false, key: "f_long", vars: { k } };
    return null;
  };
  for (const tok of tokens) {
    const t = tok.startsWith("-") && tok.length > 1 ? tok.slice(1) : tok;
    if (t === "OR" || t === "AND" || t === "NOT") return { ok: false, key: "f_bool", vars: { op: t } };
    if (t.startsWith("(") || t.endsWith(")")) return { ok: false, key: "f_paren" };
    if (t === "*") return { ok: false, key: "f_star" };
    const i = t.indexOf(":");
    const k = i > 0 ? t.slice(0, i) : "";
    if (i > 0 && /^[A-Za-z_]+$/.test(k)) {
      const key = k.toLowerCase();
      const v = t.slice(i + 1);
      if (FIELDS.includes(key)) {
        const bad = value(v, `${key}:`);
        if (bad) return bad;
      } else if (key === "is") {
        if (!IS.includes(v.toLowerCase())) return { ok: false, key: "f_is", vars: { v: v.slice(0, 20) } };
      } else if (key === "after" || key === "before") return { ok: false, key: "f_date", vars: { k: key } };
      else if (key === "in" || key === "label") return { ok: false, key: "f_folder", vars: { k: key } };
      else return { ok: false, key: "f_key", vars: { k: key } };
    } else {
      const bad = value(t, ""); // terme libre : son nom (« word » / « mot ») est dit à l'affichage, par `filterReason`
      if (bad) return bad;
    }
  }
  return { ok: true, filter: tokens.join(" ") };
}

export function filterReason(lang: Lang, c: Extract<FilterCheck, { ok: false }>): string {
  // `k` vide : un terme libre, nommé dans la langue de l'écran.
  const vars = c.vars && c.vars.k === "" ? { ...c.vars, k: trIn(lang, "word") } : c.vars;
  return m(lang, c.key, vars);
}

// texte du noyau, comparé tel quel
const NO_TRIGGER = "pas disponible (aucune relève du courrier";
// texte du noyau, comparé tel quel
const NO_MAILBOX = "aucune boîte mail reliée";
// texte du noyau, comparé tel quel
const FILTER_PREFIX = "trigger.event mail:<filtre> : ";

/** Refus du noyau sur un déclencheur mail, traduit ; null si ce n'en est pas un (l'appelant garde son texte). Le `code`
 * d'abord ; le texte en repli seulement (noyau d'avant les codes). */
export function mailTriggerError(lang: Lang, e: unknown): string | null {
  if (!(e instanceof NokkerApiError) || e.status !== 400) return null;
  const err = (e.body as { error?: { message?: unknown; code?: unknown } } | undefined)?.error;
  const msg = typeof err?.message === "string" ? err.message : "";
  const why = (): string => (msg.startsWith(FILTER_PREFIX) ? msg.slice(FILTER_PREFIX.length) : msg);
  if (err?.code === "no_mail_trigger") return m(lang, "e_no_trigger");
  if (err?.code === "mailbox_unlinked") return m(lang, "e_no_mailbox");
  if (err?.code === "bad_mail_filter") return m(lang, "e_filter", { why: why() });
  if (typeof err?.code === "string" || !msg) return null;
  if (msg.includes(NO_TRIGGER)) return m(lang, "e_no_trigger");
  if (msg.includes(NO_MAILBOX)) return m(lang, "e_no_mailbox");
  if (msg.startsWith(FILTER_PREFIX)) return m(lang, "e_filter", { why: why() });
  return null;
}

/** Une date de relève dans la langue de l'écran : l'heure seule le jour même, sinon le jour et l'heure. */
export function whenText(lang: Lang, iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(lang, { day: "numeric", month: "short" })} ${time}`;
}

/** Les lignes de l'état de la relève, dans l'ordre d'affichage. */
export function watchLines(lang: Lang, w: AgentMailWatch, fmt: (iso: string) => string): string[] {
  const out = [m(lang, `w_${w.state}` as Key), m(lang, "every", { s: w.poll_s, folder: w.folder })];
  if (w.last_poll_at) out.push(m(lang, "lastPoll", { at: fmt(w.last_poll_at) }));
  if (w.next_poll_at && w.state !== "off") out.push(m(lang, "nextPoll", { at: fmt(w.next_poll_at) }));
  if (w.pending) out.push(m(lang, "pending", { n: w.pending }) + (w.held ? ` (${w.held})` : ""));
  if (w.runs_last_hour !== undefined && w.state !== "off") out.push(m(lang, "runs", { n: w.runs_last_hour, max: w.max_runs_per_hour }));
  if (w.resync_at) out.push(m(lang, "resync", { at: fmt(w.resync_at) }));
  return out;
}
