/** X18 : petites règles pures des écrans Incidents et Plan (testées à part). */
import { NokkerApiError, type Incident, type PlanCard } from "@nokker-apps/sdk";

export const APPROVAL_STATUS_LABEL: Record<string, string> = { pending: "à décider", approved: "approuvée", rejected: "refusée", expired: "expirée", forwarded: "transmise" };

export function opsError(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: { code?: string; message?: string } | string } | undefined;
    const code = typeof b?.error === "string" ? b.error : b?.error?.code;
    if (code === "computed") return "Le statut d'une carte qui a des filles se calcule tout seul.";
    if (e.status === 409) return "Déjà fait : la page n'était plus à jour.";
    if (e.status === 404) return "Introuvable : supprimé entre-temps ?";
    return (typeof b?.error === "object" ? b.error.message : undefined) ?? `refus du serveur (${e.status})`;
  }
  return "nokker.ai ne répond pas.";
}

/** Le plus urgent d'abord : ouvert, puis en cours, puis résolu ; dans chaque groupe, le plus récent. */
export function sortIncidents(l: Incident[]): Incident[] {
  const rank = { open: 0, in_progress: 1, resolved: 2 } as const;
  return [...l].sort((a, b) => rank[a.state] - rank[b.state] || b.last_seen_at.localeCompare(a.last_seen_at));
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
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
  return m[3] === "1-5" ? `en semaine à ${hh}` : `chaque jour à ${hh}`;
}
