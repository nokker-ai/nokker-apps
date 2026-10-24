/** Page `/gateway/authorize` de nokker.ai : lecture des paramètres et URL de retour (fonctions pures, testées). */
import { gatewayHost } from "./auth.js";

export interface AuthorizeRequest {
  host: string;
  state: string;
  challenge: string;
}

/** Paramètres valides ou `null` : passerelle `<nom>.nokker.app` (ou, en dev, l'hôte courant), défi S256 de 43 car. */
export function parseAuthorize(search: string, devHost: string | null = null): AuthorizeRequest | null {
  const q = new URLSearchParams(search);
  const raw = (q.get("host") ?? "").toLowerCase();
  const host = gatewayHost(raw) ?? (devHost !== null && raw === devHost ? raw : null);
  const state = q.get("state") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  if (!host || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{8,128}$/.test(state)) return null;
  return { host, state, challenge };
}

/** URL de retour : le noyau donne la base (`https://<hôte>/auth/callback`), on n'accepte que l'hôte demandé. */
export function callbackUrl(redirect: string, req: AuthorizeRequest, params: Record<string, string>): string | null {
  let u: URL;
  try {
    u = new URL(redirect);
  } catch {
    return null;
  }
  if (u.host !== req.host || u.pathname !== "/auth/callback") return null;
  u.search = new URLSearchParams({ ...params, state: req.state }).toString();
  return u.href;
}
