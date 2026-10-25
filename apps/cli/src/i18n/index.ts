/**
 * Libellés du client terminal : anglais par défaut, français quand la langue choisie commence par `fr`. Le texte source
 * est l'anglais (`t("Once")`) ; la traduction vient du catalogue `fr.ts` (ses parties `fr-*.ts` comprises), seul endroit
 * où une chaîne française a le droit d'être écrite (test `i18n.test.ts`).
 *
 * Langue : `--lang en|fr` > `NOKKER_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG` (règle POSIX : la première variable non vide
 * l'emporte) ; `C`/`POSIX`/rien : anglais.
 */
import type { CostLang } from "@nokker-apps/sdk";
import { FR } from "./fr.js";

export type Lang = "en" | "fr";

/** Langue d'après l'environnement (sans `--lang`). */
export function detectLang(env: Record<string, string | undefined> = process.env): Lang {
  const v = env.NOKKER_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return /^fr/i.test(v.trim()) ? "fr" : "en";
}

/** `--lang` : `en`/`fr` (et `fr_CH`, `fr-FR`…) ; `null` si la valeur n'est pas une langue connue. */
export function parseLang(v: string | undefined): Lang | null {
  if (!v) return null;
  if (/^fr([_-]\w+)?$/i.test(v)) return "fr";
  if (/^en([_-]\w+)?$/i.test(v)) return "en";
  return null;
}

let current: Lang = detectLang();

export function setLang(l: Lang): void {
  current = l;
}

export function lang(): Lang {
  return current;
}

/** Langue des montants et des jetons du SDK (`formatCostLine`, `formatTokens`). */
export function costLang(): CostLang {
  return current;
}

/** `{0}`, `{1}`… remplacés par les arguments. */
export function formatMessage(message: string, args: ReadonlyArray<string | number | boolean>): string {
  return message.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Traduction d'un libellé source anglais. La clé DOIT être un littéral entre guillemets doubles (le test les relève). */
export function t(message: string, ...args: Array<string | number | boolean>): string {
  return formatMessage(current === "fr" ? (FR[message] ?? message) : message, args);
}
