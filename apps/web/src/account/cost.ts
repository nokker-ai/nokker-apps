/**
 * Coût d'un tour, d'une session, d'un jour : en CHF seulement, sur nokker.ai comme en Lokkal (« tous les prix en
 * CHF », décision du 05.11.2026 ; la démo own_card affichait « < 0,01 $ » en Lokkal). Le web ne convertit aucun
 * montant : il lit `cost_chf` du noyau (taux de sa config) ; sans lui, un coût qui n'est pas en CHF n'est pas affiché,
 * la ligne garde les jetons.
 */
import type { CostByCurrency } from "@nokker-apps/sdk";

export function chfOnly<T extends { cost?: CostByCurrency | null; cost_chf?: number | null }>(summary: T): T {
  // `cost_chf` (noyau 6aaccb4) : le total converti par le noyau ; `null` = pas de taux ou pas de prix. Un noyau plus
  // ancien ne l'envoie pas : seul un montant déjà en CHF s'affiche.
  const chf = summary.cost_chf !== undefined ? summary.cost_chf : (summary.cost?.CHF ?? summary.cost?.chf ?? null);
  return { ...summary, cost: typeof chf === "number" ? { CHF: chf } : null };
}
