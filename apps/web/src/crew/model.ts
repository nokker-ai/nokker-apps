/** Deck Crew (X14, BUBBLES.md §9.5) — libellés purs, testés. La couleur n'est jamais le seul signal. Langue de l'interface
 * en dernier paramètre (le français par défaut). */
import type { AgentRun, AgentRunStatus, AgentTrigger } from "@nokker-apps/sdk";
import { trIn } from "../i18n/index.js";
import { DAYS, cw, type Lang } from "./i18n.js";

const pad = (n: string): string => n.padStart(2, "0");
const locale = (lang: Lang): string => (lang === "fr" ? "fr-CH" : "en-GB");

/** Quelques formes de cron courantes en clair ; sinon le cron brut (jamais faux, au pire technique). */
export function cronLabel(cron: string, lang: Lang = "fr"): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cw(lang, "cron", { expr: cron });
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const fixed = /^\d+$/.test(min) && /^\d+$/.test(hour);
  const at = fixed ? cw(lang, "atTime", { hh: pad(hour), mm: pad(min) }) : "";
  if (dom === "*" && mon === "*") {
    if (min === "*" && hour === "*" && dow === "*") return cw(lang, "everyMinute");
    if (/^\d+$/.test(min) && hour === "*" && dow === "*") return cw(lang, "everyHourAt", { m: pad(min) });
    if (/^\*\/(\d+)$/.test(min) && hour === "*" && dow === "*") return cw(lang, "everyNMin", { n: min.slice(2) });
    if (fixed && dow === "*") return cw(lang, "everyDay", { at });
    if (fixed && dow === "1-5") return cw(lang, "everyWorkday", { at });
    if (fixed && /^[0-6]$/.test(dow)) return cw(lang, "everyWeekday", { day: DAYS[lang][Number(dow)]!, at });
  }
  if (fixed && /^\d+$/.test(dom) && mon === "*" && dow === "*") return cw(lang, "monthly", { dom, at });
  return cw(lang, "cron", { expr: cron });
}

export function shortDate(iso: string, now = Date.now(), lang: Lang = "fr"): string {
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(locale(lang), { hour: "2-digit", minute: "2-digit" });
  return sameDay ? cw(lang, "today", { time }) : `${d.toLocaleDateString(locale(lang), { day: "numeric", month: "short" })} ${time}`;
}

/** Ce qui déclenche l'agent, en une ligne. */
export function triggerLabel(t: AgentTrigger | undefined, lang: Lang = "fr"): string {
  if (!t || t.kind === "manual") return cw(lang, "onDemand");
  if (t.kind === "schedule") return cronLabel(t.cron, lang);
  if (t.kind === "once") return cw(lang, "once", { at: shortDate(t.at, Date.now(), lang) });
  const [src, rest] = [t.event.slice(0, t.event.indexOf(":")), t.event.slice(t.event.indexOf(":") + 1)];
  if (src === "alert") return cw(lang, "onAlert", { name: rest });
  if (src === "webhook") return cw(lang, "onWebhook", { id: rest });
  if (src === "mail") return rest === "*" ? cw(lang, "onAnyMail") : cw(lang, "onMail", { filter: rest });
  return cw(lang, "onEvent", { event: t.event });
}

export const RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  queued: "en file",
  running: "en cours",
  waiting_approval: "attend ton feu vert",
  succeeded: "réussi",
  failed: "en échec",
  cancelled: "annulé",
  skipped: "sauté",
};

const RUN_STATUS_EN: Record<AgentRunStatus, string> = {
  queued: "queued",
  running: "running",
  waiting_approval: "waiting for your go-ahead",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
};

export function runStatusLabel(st: AgentRunStatus, lang: Lang = "fr"): string {
  return (lang === "en" ? RUN_STATUS_EN : RUN_STATUS_LABEL)[st] ?? st;
}

export const runActive = (r: Pick<AgentRun, "status">): boolean => r.status === "queued" || r.status === "running" || r.status === "waiting_approval";

/** Durée d'un passage, « 42 s », « 3 min », ou null si pas fini. */
export function runDuration(r: Pick<AgentRun, "started_at" | "ended_at">): string | null {
  if (!r.started_at || !r.ended_at) return null;
  const s = Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export function runCost(r: Pick<AgentRun, "cost">, lang: Lang = "fr"): string | null {
  if (!r.cost) return null;
  const money = (amount: number, cur: string): string => `${amount.toFixed(amount < 0.1 ? 3 : 2)} ${cur}`;
  // Plusieurs devises : `amounts` (jamais de conversion côté client).
  const amounts = r.cost.amounts && Object.keys(r.cost.amounts).length > 1
    ? Object.keys(r.cost.amounts).sort().map((c) => money(r.cost!.amounts![c]!, c)).join(" + ")
    : money(r.cost.amount, r.cost.currency);
  if (r.cost.calls === undefined) return amounts;
  const n = r.cost.calls;
  return `${amounts} · ${n > 1 ? trIn(lang, "{0} calls", n) : trIn(lang, "{0} call", n)}`;
}

/** Fusionne un passage reçu par événement dans la liste affichée (le plus récent d'abord). */
export function mergeRun(list: AgentRun[], run: AgentRun): AgentRun[] {
  const i = list.findIndex((r) => r.run_id === run.run_id);
  if (i === -1) return [run, ...list];
  const next = list.slice();
  next[i] = run;
  return next;
}
