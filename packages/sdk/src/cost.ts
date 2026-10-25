/**
 * Mise en forme du coût par tour (LOKKAL.md §7.8) — partagée par le client terminal et le web pour qu'ils affichent la
 * MÊME ligne : « 12,4 k jetons · 0,03 € », jetons seuls quand aucun prix n'est connu. Aucun montant n'est recalculé
 * ni converti ici : les devises viennent telles quelles du noyau.
 */
import type { CostByCurrency, CostTokens } from "./types.js";

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", CHF: "CHF", GBP: "£" };

/** Décimale à la française (virgule), sans séparateur de milliers ambigu. */
function fr(n: number, digits: number): string {
  return n.toFixed(digits).replace(".", ",");
}

/** Sans zéros inutiles après la virgule : « 12,0 » → « 12 », « 1,20 » → « 1,2 ». */
function trim(s: string): string {
  return s.includes(",") ? s.replace(/0+$/, "").replace(/,$/, "") : s;
}

/** 850 → « 850 », 12 400 → « 12,4 k », 1 230 000 → « 1,23 M ». */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 999_500) {
    const k = n / 1_000;
    return `${trim(fr(k, k < 100 ? 1 : 0))} k`;
  }
  const m = n / 1_000_000;
  return `${trim(fr(m, m < 10 ? 2 : 1))} M`;
}

/** 0,0312 € → « 0,03 € » ; sous le centime : « < 0,01 € » ; zéro exact : « 0 € ». */
export function formatAmount(amount: number, currency: string): string {
  const sym = SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return `0 ${sym}`;
  if (amount < 0.01) return `< 0,01 ${sym}`;
  return `${fr(amount, 2)} ${sym}`;
}

/** Les montants d'un coût par devise, joints par « + » (vide si aucun prix). */
export function formatCost(cost: CostByCurrency | null | undefined): string {
  if (!cost) return "";
  return Object.keys(cost)
    .sort()
    .map((cur) => formatAmount(cost[cur] ?? 0, cur))
    .join(" + ");
}

/** La ligne de fin de tour : « 12,4 k jetons · 0,03 € », ou « 12,4 k jetons » sans prix. */
export function formatCostLine(summary: Pick<CostTokens, "total_tokens"> & { cost?: CostByCurrency | null }): string {
  const tokens = `${formatTokens(summary.total_tokens)} jetons`;
  const money = formatCost(summary.cost);
  return money ? `${tokens} · ${money}` : tokens;
}
