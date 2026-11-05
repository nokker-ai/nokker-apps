import { NokkerClient, type FetchLike } from "@nokker-apps/sdk";
import { watchingFetch } from "./lokkal/keyWatch.js";
import { BRAND } from "@nokker-apps/brand";

/** URL du serveur — `VITE_NOKKER_SERVER_URL` à la build ; sinon même origine (proxy Vite vers le mock en dev). */
export const SERVER_URL = (import.meta.env?.VITE_NOKKER_SERVER_URL as string | undefined) ?? window.location.origin;

// Each 401 is reported with its bearer (a Lokkal's local key refused during a session: lokkal/keyWatch.ts).
const appFetch = watchingFetch((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);

export function createClient(): NokkerClient {
  return new NokkerClient({ baseUrl: SERVER_URL, userAgent: BRAND.userAgent, fetchImpl: appFetch });
}
