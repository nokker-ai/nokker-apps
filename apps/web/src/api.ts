import { NokkerClient } from "@nokker-apps/sdk";
import { BRAND } from "@nokker-apps/brand";

/** URL du serveur — `VITE_NOKKER_SERVER_URL` à la build ; sinon même origine (proxy Vite vers le mock en dev). */
export const SERVER_URL = (import.meta.env?.VITE_NOKKER_SERVER_URL as string | undefined) ?? window.location.origin;

export function createClient(): NokkerClient {
  return new NokkerClient({ baseUrl: SERVER_URL, userAgent: BRAND.userAgent });
}
