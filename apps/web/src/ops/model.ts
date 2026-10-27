/** X18 : petites règles pures des écrans Incidents et Plan (testées à part). */
import { NokkerApiError, type Incident, type IncidentState, type PlanCard, type PlanCardKind, type PlanCardStatus } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

/** Libellé du statut d'une carte du plan. */
export function planStatusLabel(s: PlanCardStatus): string {
  switch (s) {
    case "todo":
      return tr("to do");
    case "in_progress":
      return tr("in progress");
    case "blocked":
      return tr("blocked");
    case "done":
      return tr("done");
  }
}
/** Libellé du type d'une carte du plan. */
export function planKindLabel(k: PlanCardKind): string {
  switch (k) {
    case "goal":
      return tr("goal");
    case "milestone":
      return tr("milestone");
    case "task":
      return tr("task");
  }
}
/** Libellé de l'état d'un incident. */
export function incidentStateLabel(s: IncidentState): string {
  switch (s) {
    case "open":
      return tr("open");
    case "in_progress":
      return tr("in progress");
    case "resolved":
      return tr("resolved");
  }
}

/** Libellé d'un statut d'approbation (le statut brut du noyau s'il est inconnu). */
export function approvalStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return tr("to decide");
    case "approved":
      return tr("approved");
    case "rejected":
      return tr("rejected");
    case "expired":
      return tr("expired");
    case "forwarded":
      return tr("forwarded");
    case "executed":
      return tr("executed");
    default:
      return status;
  }
}

export function opsError(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: { code?: string; message?: string } | string } | undefined;
    const code = typeof b?.error === "string" ? b.error : b?.error?.code;
    if (code === "computed") return tr("The status of a card that has sub-cards is computed automatically.");
    if (e.status === 409) return tr("Already done: the page was out of date.");
    if (e.status === 404) return tr("Not found: deleted in the meantime?");
    return (typeof b?.error === "object" ? b.error.message : undefined) ?? tr("server refused ({0})", e.status);
  }
  return tr("nokker.ai is not responding.");
}

/** Le plus urgent d'abord : ouvert, puis en cours, puis résolu ; dans chaque groupe, le plus récent. */
export function sortIncidents(l: Incident[]): Incident[] {
  const rank = { open: 0, in_progress: 1, resolved: 2 } as const;
  return [...l].sort((a, b) => rank[a.state] - rank[b.state] || b.last_seen_at.localeCompare(a.last_seen_at));
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return tr("just now");
  if (s < 3600) return tr("{0} min ago", Math.round(s / 60));
  if (s < 86400) return tr("{0} h ago", Math.round(s / 3600));
  return tr("{0} d ago", Math.round(s / 86400));
}

/** Arbre du plan : racines puis filles, dans l'ordre de `children` (les cartes inconnues sont ignorées). */
export function planTree(cards: PlanCard[]): { roots: PlanCard[]; kids: (c: PlanCard) => PlanCard[] } {
  const by = new Map(cards.map((c) => [c.id, c]));
  return {
    roots: cards.filter((c) => !c.parent_id || !by.has(c.parent_id)).sort((a, b) => a.position - b.position),
    kids: (c) => c.children.map((id) => by.get(id)).filter((x): x is PlanCard => !!x),
  };
}

/** Une entrée par ligne, vides retirées. */
export const lines = (t: string): string[] => t.split("\n").map((x) => x.trim()).filter(Boolean);

/** Cron du brief en clair pour les cas courants, sinon le cron brut. */
export function cronHuman(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron.trim());
  if (!m) return cron;
  const hh = `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
  return m[3] === "1-5" ? tr("weekdays at {0}", hh) : tr("every day at {0}", hh);
}
