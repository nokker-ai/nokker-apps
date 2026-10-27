/** Deck multi-machines (X15, LOKKAL §7.19) — règles d'affichage pures, testées. Langue de l'interface en dernier
 * paramètre (le français par défaut). */
import type { DeckAgent, DeckLoad, DeckMachine, DeckSession } from "@nokker-apps/sdk";
import { cw, type Lang } from "./i18n.js";

/** RAM occupée et CPU relatif en pourcentages bornés, plus une ligne lisible. */
export function loadSummary(load: DeckLoad | null, lang: Lang = "fr"): { ramPct: number; cpuPct: number; text: string } | null {
  if (!load) return null;
  const used = Math.max(0, load.ram.total_mb - load.ram.free_mb);
  const ramPct = load.ram.total_mb > 0 ? Math.min(100, Math.round((used / load.ram.total_mb) * 100)) : 0;
  const cpuPct = Math.min(100, Math.round(Math.max(0, load.cpu.rel) * 100));
  const gb = (mb: number): string => {
    const v = (mb / 1024).toFixed(mb >= 10240 ? 0 : 1);
    return lang === "fr" ? v.replace(".", ",") : v;
  };
  const gpu = load.gpus.length ? ` · ${load.gpus.length} GPU` : "";
  return { ramPct, cpuPct, text: cw(lang, "freeOf", { free: gb(load.ram.free_mb), total: gb(load.ram.total_mb), cpu: cpuPct, gpu }) };
}

export function sessionStateLabel(st: DeckSession["state"], lang: Lang = "fr"): string {
  return st === "idle" ? cw(lang, "sIdle") : st === "working" ? cw(lang, "sWorking") : cw(lang, "sAwaiting");
}

/** La carte respire tant qu'un passage vit (statut `running`, ou `live_run` d'un agent `auto` placé ailleurs). */
export const agentBreathes = (a: Pick<DeckAgent, "status" | "live_run">): boolean => a.status === "running" || !!a.live_run;

/** « vue il y a 3 min » à partir d'un âge en secondes. */
export function ageLabel(ageS: number | null, lang: Lang = "fr"): string {
  if (ageS === null) return cw(lang, "neverSeen");
  if (ageS < 60) return cw(lang, "justNow");
  if (ageS < 3600) return cw(lang, "agoMin", { n: Math.floor(ageS / 60) });
  if (ageS < 86400) return cw(lang, "agoH", { n: Math.floor(ageS / 3600) });
  return cw(lang, "agoD", { n: Math.floor(ageS / 86400) });
}

/** Destinations d'un déménagement : nokker.ai, automatique, puis chaque machine (sauf celle où l'agent est déjà). */
export function moveTargets(machines: Pick<DeckMachine, "machine_id" | "name" | "online">[], current: string | null, lang: Lang = "fr"): { to: string; label: string }[] {
  const all = [
    { to: "web", label: cw(lang, "hostedTarget") },
    { to: "auto", label: cw(lang, "autoTarget") },
    ...machines.map((m) => ({ to: m.machine_id, label: `${m.name}${m.online ? "" : cw(lang, "offlineSuffix")}` })),
  ];
  return all.filter((t) => t.to !== (current ?? "web"));
}
