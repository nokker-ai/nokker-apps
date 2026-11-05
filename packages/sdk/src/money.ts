/**
 * Montants AFFICHÉS — un seul format pour le SDK, le web et le terminal (décision du 05.11.2026) : `Intl.NumberFormat`
 * en style currency, locale fr-CH en français (« 42.90 CHF », « 1 234.50 CHF »), en-CH en anglais (« CHF 42.90 »).
 * Espaces insécables comprises (U+00A0 avant la devise, U+202F pour les milliers en fr-CH) : le montant ne se coupe
 * jamais de sa devise. Pour les DONNÉES (corps de requête, textes recopiés du noyau), garder `formatMinor`, qui suit
 * exactement le `format_minor` du noyau.
 */
import { currencyExponent } from "./payments.js";

export type MoneyLang = "fr" | "en";

export interface MoneyOptions {
  /** Montant entier sans décimales (« 19 CHF ») : pour les PRIX des formules seulement, comme la page tarifs. Les coûts
   * et les paiements gardent toujours leurs deux décimales (« 42.90 CHF »). */
  whole?: boolean;
}

const LOCALE: Record<MoneyLang, string> = { fr: "fr-CH", en: "en-CH" };

/** Montant en unités de la devise (42.9 = 42,90 CHF) → « 42.90 CHF » (fr) / « CHF 42.90 » (en). */
export function formatMoney(amount: number, currency: string, lang: MoneyLang = "fr", opts: MoneyOptions = {}): string {
  const cur = currency.toUpperCase();
  const v = Number.isFinite(amount) ? amount : 0;
  const bare = opts.whole === true && Number.isInteger(v);
  try {
    const digits = bare ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {};
    return new Intl.NumberFormat(LOCALE[lang] ?? LOCALE.fr, { style: "currency", currency: cur, ...digits }).format(v);
  } catch {
    // Code de devise que l'Intl ne connaît pas : même forme, sans séparateur de milliers.
    const digits = bare ? 0 : currencyExponent(cur);
    return lang === "en" ? `${cur} ${v.toFixed(digits)}` : `${v.toFixed(digits)} ${cur}`;
  }
}

/** Unités mineures (4290 centimes) → montant affiché. */
export function formatMoneyMinor(minor: number, currency: string, lang: MoneyLang = "fr"): string {
  return formatMoney(minor / 10 ** currencyExponent(currency), currency, lang);
}
