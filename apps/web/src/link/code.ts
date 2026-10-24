import { NokkerApiError } from "@nokker-apps/sdk";
import type { Key } from "../onboarding/i18n.js";

/** Saisie d'un code `XXXX-XXXX` : majuscules, tout sauf lettres et chiffres retiré, tiret posé après 4 caractères. */
export function formatCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export const isCompleteCode = (code: string): boolean => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);

/** `?code=` de l'adresse (lien affiché par Lokkal) ; chaîne vide si absent ou invalide. */
export function codeFromSearch(search: string): string {
  const c = formatCode(new URLSearchParams(search).get("code") ?? "");
  return isCompleteCode(c) ? c : "";
}

export type LinkIssue = "unauthorized" | "unknown" | "rate" | "network" | "other";

export function linkIssue(err: unknown): LinkIssue {
  if (err instanceof NokkerApiError) {
    if (err.status === 401) return "unauthorized";
    if (err.status === 404) return "unknown";
    if (err.status === 429) return "rate";
    return "other";
  }
  return err instanceof TypeError ? "network" : "other";
}

const ISSUE_KEYS: Record<LinkIssue, Key> = {
  unauthorized: "linkErrUnauthorized",
  unknown: "linkErrUnknown",
  rate: "linkErrRate",
  network: "linkErrNetwork",
  other: "linkErrOther",
};
export const keyForIssue = (i: LinkIssue): Key => ISSUE_KEYS[i];

/** Minutes à annoncer pour `seconds` restantes (au moins 1 tant que le code vit). */
export const minutesLeft = (seconds: number): number => Math.max(1, Math.ceil(seconds / 60));

const RETURN_KEY = "nokker.link.return";

/** Retour de connexion Google : l'URL de la page est perdue par la redirection, on la garde le temps du détour. */
export function rememberLinkReturn(code: string, store: Pick<Storage, "setItem"> = sessionStorage): void {
  try {
    store.setItem(RETURN_KEY, `/link?code=${encodeURIComponent(code)}`);
  } catch {
    /* stockage indisponible : le visiteur ressaisit le code */
  }
}

export function takeLinkReturn(store: Pick<Storage, "getItem" | "removeItem"> = sessionStorage): string | null {
  try {
    const v = store.getItem(RETURN_KEY);
    store.removeItem(RETURN_KEY);
    return v && /^\/link\?code=[A-Za-z0-9%-]+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
