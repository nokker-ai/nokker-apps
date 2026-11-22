/**
 * Portée du jeton de cette page (noyau p2/integ-kiosk-code) : l'échange d'un `#code=` rend `scope` = owner | kiosk | present.
 *
 * - `kiosk` : jamais la clé de l'app (clé à part, `nokker.kiosk-token`, voir mode.ts) ;
 * - `present` : la clé de l'app, mais seulement le temps de l'onglet (sessionStorage), 12 h fixes côté machine ;
 * - l'écran `/present` ne tranche JAMAIS une carte : il dit seulement qu'une carte attend (aucun appel approve/reject).
 */
import { scopeOfExchange, type AccessScope } from "@nokker-apps/sdk";

const SCOPE_KEY = "nokker.token-scope";

export { scopeOfExchange };
export type { AccessScope };

export function keepScope(scope: AccessScope): void {
  try {
    window.sessionStorage.setItem(SCOPE_KEY, scope);
  } catch {
    /* stockage indisponible : la portée se lit alors au chemin seulement */
  }
}

export function tokenScope(): AccessScope | null {
  try {
    const v = window.sessionStorage.getItem(SCOPE_KEY);
    return v === "owner" || v === "kiosk" || v === "present" ? v : null;
  } catch {
    return null;
  }
}

/** L'écran de présentation (`/present`, `/present/<session>`) : le chemin suffit, et la portée `present` du jeton aussi. */
export function onPresentScreen(): boolean {
  return (typeof location !== "undefined" && (location.pathname === "/present" || location.pathname.startsWith("/present/"))) || tokenScope() === "present";
}

/** Routes de décision que l'écran de présentation n'écrit jamais (approbations, appareils) : refusées avant le réseau
 * (api.ts), comme le noyau les refuse (403 `scope_present`). La lecture passe. */
export const PRESENT_WRITE_BLOCKED = /\/v1\/(?:local\/)?(?:approvals|devices)(?:[/?]|$)/;
