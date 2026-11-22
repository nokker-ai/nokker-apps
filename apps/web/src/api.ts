import { NokkerClient, type FetchLike } from "@nokker-apps/sdk";
import { watchingFetch } from "./lokkal/keyWatch.js";
import { webSurface } from "./surface.js";
import { onPresentScreen, PRESENT_WRITE_BLOCKED } from "./kiosk/scope.js";
import { BRAND } from "@nokker-apps/brand";
import { fakeShellAllowed, isNativeShell, resolveServerUrl } from "./platform/native.js";

/** URL du serveur — `VITE_NOKKER_SERVER_URL` à la build ; sinon même origine (proxy Vite vers le mock en dev) ; dans la
 * coque native (origine `capacitor://localhost`), app.nokker.ai (LOKKAL-PHONE §1.1 W1). */
export const SERVER_URL = resolveServerUrl(import.meta.env?.VITE_NOKKER_SERVER_URL as string | undefined, window.location.origin, isNativeShell(), fakeShellAllowed());

// Each 401 is reported with its bearer (a Lokkal's local key refused during a session: lokkal/keyWatch.ts).
const rawFetch = watchingFetch((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);

/** Écran de présentation (`/present`, portée `present`) : il ne tranche JAMAIS une carte. Toute écriture vers les routes de
 * décision (approbations, appareils) est refusée ICI, avant le réseau, quel que soit le composant qui l'appelle ; la lecture
 * passe (une carte qui attend s'affiche). Le noyau refuse la même chose (403 `scope_present`) : double garde. */
const appFetch: typeof rawFetch = (url, init) => {
  const method = String((init as { method?: string } | undefined)?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && onPresentScreen() && PRESENT_WRITE_BLOCKED.test(String(url))) {
    return Promise.reject(new Error("present-screen: decisions are made on the phone or on the machine"));
  }
  return rawFetch(url, init);
};

export function createClient(): NokkerClient {
  return new NokkerClient({ baseUrl: SERVER_URL, userAgent: BRAND.userAgent, fetchImpl: appFetch, surface: webSurface() });
}
