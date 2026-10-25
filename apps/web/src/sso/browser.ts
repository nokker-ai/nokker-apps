/** Branchement navigateur du parcours SSO (`flow.ts` reste testable sans DOM). */
import type { NokkerClient } from "@nokker-apps/sdk";
import { buildStoredKey, deviceName, idbDelete, idbGet, idbPut, isSecure, readStoredDeviceKey, storeDeviceKey } from "../auth.js";
import { PENDING_KEY, mayAutoRedirect, startSso, type SsoDeps, type SsoPending } from "./flow.js";

export function browserSsoDeps(client: NokkerClient, lang: string): SsoDeps {
  return {
    client,
    session: sessionStorage,
    pending: { put: (p) => idbPut(PENDING_KEY, p), get: () => idbGet<SsoPending>(PENDING_KEY), drop: () => idbDelete(PENDING_KEY) },
    storeDevice: (id, pair) => storeDeviceKey(buildStoredKey(id, pair)),
    hadDevice: async () => !!(await readStoredDeviceKey()),
    secure: isSecure,
    deviceName,
    lang,
  };
}

/** Part vers le fournisseur de la connexion (`sc_…`), retour sur la page courante. */
export async function goSso(client: NokkerClient, lang: string, target: { connection?: string; email?: string }, back = location.pathname + location.search): Promise<void> {
  location.assign(await startSso(browserSsoDeps(client, lang), target, back));
}

/** Redirection d'un 403 `sso_required`, une fois par minute et par connexion ; `false` si l'écran doit l'afficher. */
export function autoSso(client: NokkerClient, lang: string, connection: string): boolean {
  if (!connection || !mayAutoRedirect(sessionStorage, connection)) return false;
  void goSso(client, lang, { connection }).catch(() => undefined);
  return true;
}
