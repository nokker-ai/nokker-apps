/** Deck Crew (X14, BUBBLES.md §9.5) — libellés purs, testés. La couleur n'est jamais le seul signal. */
import type { AgentRun, AgentRunStatus, AgentTrigger } from "@nokker-apps/sdk";

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const pad = (n: string): string => n.padStart(2, "0");

/** Quelques formes de cron courantes en français ; sinon le cron brut (jamais faux, au pire technique). */
export function cronLabel(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return `cron ${cron}`;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const fixed = /^\d+$/.test(min) && /^\d+$/.test(hour);
  const at = fixed ? `à ${pad(hour)}:${pad(min)}` : "";
  if (dom === "*" && mon === "*") {
    if (min === "*" && hour === "*" && dow === "*") return "chaque minute";
    if (/^\d+$/.test(min) && hour === "*" && dow === "*") return `chaque heure à :${pad(min)}`;
    if (/^\*\/(\d+)$/.test(min) && hour === "*" && dow === "*") return `toutes les ${min.slice(2)} min`;
    if (fixed && dow === "*") return `chaque jour ${at}`;
    if (fixed && dow === "1-5") return `chaque jour ouvré ${at}`;
    if (fixed && /^[0-6]$/.test(dow)) return `chaque ${DAYS[Number(dow)]} ${at}`;
  }
  if (fixed && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `le ${dom} de chaque mois ${at}`;
  return `cron ${cron}`;
}

export function shortDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `aujourd'hui ${time}` : `${d.toLocaleDateString("fr-CH", { day: "numeric", month: "short" })} ${time}`;
}

/** Ce qui déclenche l'agent, en une ligne. */
export function triggerLabel(t: AgentTrigger | undefined): string {
  if (!t || t.kind === "manual") return "à la demande";
  if (t.kind === "schedule") return cronLabel(t.cron);
  if (t.kind === "once") return `une fois, ${shortDate(t.at)}`;
  const [src, rest] = [t.event.slice(0, t.event.indexOf(":")), t.event.slice(t.event.indexOf(":") + 1)];
  if (src === "alert") return `sur alerte « ${rest} »`;
  if (src === "webhook") return `sur appel externe (${rest})`;
  return `sur événement ${t.event}`;
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

export const runActive = (r: Pick<AgentRun, "status">): boolean => r.status === "queued" || r.status === "running" || r.status === "waiting_approval";

/** Durée d'un passage, « 42 s », « 3 min », ou null si pas fini. */
export function runDuration(r: Pick<AgentRun, "started_at" | "ended_at">): string | null {
  if (!r.started_at || !r.ended_at) return null;
  const s = Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export function runCost(r: Pick<AgentRun, "cost">): string | null {
  if (!r.cost) return null;
  const money = (amount: number, cur: string): string => `${amount.toFixed(amount < 0.1 ? 3 : 2)} ${cur}`;
  // Plusieurs devises : `amounts` (jamais de conversion côté client).
  const amounts = r.cost.amounts && Object.keys(r.cost.amounts).length > 1
    ? Object.keys(r.cost.amounts).sort().map((c) => money(r.cost!.amounts![c]!, c)).join(" + ")
    : money(r.cost.amount, r.cost.currency);
  return r.cost.calls !== undefined ? `${amounts} · ${r.cost.calls} appel${r.cost.calls > 1 ? "s" : ""}` : amounts;
}

/** Fusionne un passage reçu par événement dans la liste affichée (le plus récent d'abord). */
export function mergeRun(list: AgentRun[], run: AgentRun): AgentRun[] {
  const i = list.findIndex((r) => r.run_id === run.run_id);
  if (i === -1) return [run, ...list];
  const next = list.slice();
  next[i] = run;
  return next;
}
