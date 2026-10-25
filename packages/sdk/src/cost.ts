/**
 * Mise en forme du coût par tour (LOKKAL.md §7.8) — partagée par le client terminal et le web pour qu'ils affichent la
 * MÊME ligne : « 12,4 k jetons · 0,03 € », jetons seuls quand aucun prix n'est connu. Aucun montant n'est recalculé
 * ni converti ici : les devises viennent telles quelles du noyau.
 *
 * `lang: "en"` (facultatif, extension VS Code en anglais) : « 12.4k tokens · €0.03 ». Défaut : français, inchangé.
 */
import type { CostByCurrency, CostTokens } from "./types.js";

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", CHF: "CHF", GBP: "£" };

export type CostLang = "fr" | "en";

/** Décimale à la française (virgule), sans séparateur de milliers ambigu. */
function fr(n: number, digits: number): string {
  return n.toFixed(digits).replace(".", ",");
}

/** Sans zéros inutiles après la virgule : « 12,0 » → « 12 », « 1,20 » → « 1,2 ». */
function trim(s: string): string {
  return s.includes(",") ? s.replace(/0+$/, "").replace(/,$/, "") : s;
}

/** Même nombre en anglais : point décimal. */
const en = (s: string): string => s.replace(",", ".");

/** 850 → « 850 », 12 400 → « 12,4 k », 1 230 000 → « 1,23 M » (`en` : « 12.4k », « 1.23M »). */
export function formatTokens(n: number, lang: CostLang = "fr"): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 999_500) {
    const k = n / 1_000;
    const v = trim(fr(k, k < 100 ? 1 : 0));
    return lang === "en" ? `${en(v)}k` : `${v} k`;
  }
  const m = n / 1_000_000;
  const v = trim(fr(m, m < 10 ? 2 : 1));
  return lang === "en" ? `${en(v)}M` : `${v} M`;
}

/** 0,0312 € → « 0,03 € » ; sous le centime : « < 0,01 € » ; zéro exact : « 0 € » (`en` : « €0.03 », « < €0.01 »,
 * « CHF 0.03 »). */
export function formatAmount(amount: number, currency: string, lang: CostLang = "fr"): string {
  const sym = SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase();
  if (lang === "en") {
    const put = (v: string): string => (sym.length === 1 ? `${sym}${v}` : `${sym} ${v}`);
    if (!Number.isFinite(amount) || amount <= 0) return put("0");
    if (amount < 0.01) return `< ${put("0.01")}`;
    return put(amount.toFixed(2));
  }
  if (!Number.isFinite(amount) || amount <= 0) return `0 ${sym}`;
  if (amount < 0.01) return `< 0,01 ${sym}`;
  return `${fr(amount, 2)} ${sym}`;
}

/** Les montants d'un coût par devise, joints par « + » (vide si aucun prix). */
export function formatCost(cost: CostByCurrency | null | undefined, lang: CostLang = "fr"): string {
  if (!cost) return "";
  return Object.keys(cost)
    .sort()
    .map((cur) => formatAmount(cost[cur] ?? 0, cur, lang))
    .join(" + ");
}

/** La ligne de fin de tour : « 12,4 k jetons · 0,03 € », ou « 12,4 k jetons » sans prix (`en` : « 12.4k tokens ·
 * €0.03 »). */
export function formatCostLine(summary: Pick<CostTokens, "total_tokens"> & { cost?: CostByCurrency | null }, lang: CostLang = "fr"): string {
  const tokens = lang === "en" ? `${formatTokens(summary.total_tokens, "en")} tokens` : `${formatTokens(summary.total_tokens)} jetons`;
  const money = formatCost(summary.cost, lang);
  return money ? `${tokens} · ${money}` : tokens;
}
