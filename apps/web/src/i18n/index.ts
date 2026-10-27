/**
 * Coque du web (onglets, chat, barre des sessions, écrans sans dictionnaire propre) : le texte source est l'anglais
 * (`tr("New session")`), la traduction française vient du catalogue `fr.ts` et de ses parties `fr-*.ts`, seul endroit
 * de la coque où une chaîne française a le droit d'être écrite (test `i18n.test.ts`). Les écrans qui ont déjà leurs
 * tables FR/EN (onboarding, foyer, crew, code, sso…) les gardent.
 *
 * Langue : celle de l'interface (`uiLang` : langue mémorisée à l'onboarding, sinon celle du navigateur).
 */
import { normLang, type Lang } from "../onboarding/i18n.js";
import { readJson } from "../viewState.js";
import { FR } from "./fr.js";

export type { Lang };

let forced: Lang | null = null;

/** Langue de l'interface, lue à chaque appel (l'onboarding peut la changer en cours de route). */
export function shellLang(): Lang {
  if (forced) return forced;
  return normLang(readJson<string>("lang", "") || (typeof navigator !== "undefined" ? navigator.language : ""));
}

/** Tests : impose une langue (`null` : revient à celle de l'interface). */
export function setShellLang(l: Lang | null): void {
  forced = l;
}

/** `{0}`, `{1}`… remplacés par les arguments. */
export function formatMessage(message: string, args: ReadonlyArray<string | number>): string {
  return message.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Traduction d'un libellé source anglais dans une langue donnée (écrans qui reçoivent `lang`). La clé DOIT être un
 * littéral entre guillemets doubles (le test les relève). */
export function trIn(lang: Lang, message: string, ...args: Array<string | number>): string {
  return formatMessage(lang === "fr" ? (FR[message] ?? message) : message, args);
}

/** Traduction dans la langue de l'interface. */
export function tr(message: string, ...args: Array<string | number>): string {
  return trIn(shellLang(), message, ...args);
}
