/** Deck multi-machines (X15, LOKKAL §7.19) — règles d'affichage pures, testées. */
import type { DeckAgent, DeckLoad, DeckMachine, DeckSession } from "@nokker-apps/sdk";

/** RAM occupée et CPU relatif en pourcentages bornés, plus une ligne lisible. */
export function loadSummary(load: DeckLoad | null): { ramPct: number; cpuPct: number; text: string } | null {
  if (!load) return null;
  const used = Math.max(0, load.ram.total_mb - load.ram.free_mb);
  const ramPct = load.ram.total_mb > 0 ? Math.min(100, Math.round((used / load.ram.total_mb) * 100)) : 0;
  const cpuPct = Math.min(100, Math.round(Math.max(0, load.cpu.rel) * 100));
  const gb = (mb: number): string => (mb / 1024).toFixed(mb >= 10240 ? 0 : 1).replace(".", ",");
  const gpu = load.gpus.length ? ` · ${load.gpus.length} GPU` : "";
  return { ramPct, cpuPct, text: `${gb(load.ram.free_mb)} Go libres sur ${gb(load.ram.total_mb)} · CPU ${cpuPct} %${gpu}` };
}

export const SESSION_STATE_LABEL: Record<DeckSession["state"], string> = {
  idle: "au repos",
  working: "travaille",
  awaiting_approval: "attend une décision",
};

/** La carte respire tant qu'un passage vit (statut `running`, ou `live_run` d'un agent `auto` placé ailleurs). */
export const agentBreathes = (a: Pick<DeckAgent, "status" | "live_run">): boolean => a.status === "running" || !!a.live_run;

/** « vue il y a 3 min » à partir d'un âge en secondes. */
export function ageLabel(ageS: number | null): string {
  if (ageS === null) return "jamais vue";
  if (ageS < 60) return "à l'instant";
  if (ageS < 3600) return `il y a ${Math.floor(ageS / 60)} min`;
  if (ageS < 86400) return `il y a ${Math.floor(ageS / 3600)} h`;
  return `il y a ${Math.floor(ageS / 86400)} j`;
}

/** Destinations d'un déménagement : nokker.ai, automatique, puis chaque machine (sauf celle où l'agent est déjà). */
export function moveTargets(machines: Pick<DeckMachine, "machine_id" | "name" | "online">[], current: string | null): { to: string; label: string }[] {
  const all = [
    { to: "web", label: "nokker.ai (hébergé)" },
    { to: "auto", label: "Automatique (la machine la moins chargée)" },
    ...machines.map((m) => ({ to: m.machine_id, label: `${m.name}${m.online ? "" : " (hors ligne)"}` })),
  ];
  return all.filter((t) => t.to !== (current ?? "web"));
}
