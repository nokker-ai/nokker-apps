/**
 * Connexion par la passerelle `<nom>.nokker.app` (docs/LOKKAL.md §7.3, GATEWAY.md) : code d'autorisation + PKCE.
 *
 *   1. sans jeton : `state` et `code_verifier` en sessionStorage, redirection vers
 *      `https://app.nokker.ai/gateway/authorize?host=…&state=…&code_challenge=…&code_challenge_method=S256` ;
 *   2. nokker.ai renvoie sur `/auth/callback?code=…&state=…` ;
 *   3. `POST /_gw/token {code, code_verifier}` (relais, même origine) → `{access_token, expires_in}` ; le relais garde
 *      le refresh dans un cookie `__Host-nk_rt` HttpOnly que ce code ne voit jamais ;
 *   4. le jeton d'accès reste EN MÉMOIRE (jamais en stockage) ; `POST /_gw/refresh` avant l'expiration et au
 *      rechargement. 400/401 = déconnecté (`invalid_grant`) ; 502 = nokker.ai en panne, le cookie reste : on
 *      réessaie ; 429 : après `Retry-After` ; 403 = Origin ou type faux, une erreur de code : on n'insiste pas.
 *
 * `/_gw/*` exige `Content-Type: application/json` et l'`Origin` exact de la passerelle (CSRF) : un `fetch` même
 * origine avec ce type le pose de lui-même.
 */

/** Nom de passerelle valide (GATEWAY.md §4) : 3 à 30 de `[a-z0-9-]`, pas de tiret aux bords ni de `--` (pages). */
export function gatewayHost(hostname: string): string | null {
  const m = /^([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\.nokker\.app$/.exec(hostname.toLowerCase());
  return m && !m[1]!.includes("--") ? hostname.toLowerCase() : null;
}

export const AUTHORIZE_BASE = "https://app.nokker.ai/gateway/authorize";
const PENDING_KEY = "nokker.gw.pending";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256 : `BASE64URL(SHA256(verifier))`. */
export async function codeChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function authorizeUrl(base: string, host: string, state: string, challenge: string): string {
  const u = new URL(base);
  u.search = new URLSearchParams({ host, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return u.href;
}

interface Pending {
  state: string;
  verifier: string;
  /** Chemin où revenir après connexion (même origine seulement). */
  back: string;
}

/** Chemin de retour sûr : relatif à l'origine, jamais `//hôte` ni le callback lui-même. */
export function safeBack(path: string): string {
  return /^\/(?!\/)/.test(path) && !path.startsWith("/auth/callback") ? path : "/";
}

/** Prépare la connexion et rend l'URL d'autorisation (l'appelant redirige). */
export async function beginLogin(host: string, back: string, store: Pick<Storage, "setItem"> = sessionStorage, base = AUTHORIZE_BASE): Promise<string> {
  const state = randomToken(16);
  const verifier = randomToken(32);
  store.setItem(PENDING_KEY, JSON.stringify({ state, verifier, back: safeBack(back) } satisfies Pending));
  return authorizeUrl(base, host, state, await codeChallenge(verifier));
}

export interface GatewayToken {
  access_token: string;
  expires_in: number;
}

export type CallbackError = "state" | "denied" | "exchange";

export class GatewayAuthError extends Error {
  constructor(
    readonly kind: CallbackError | "expired" | "unavailable" | "forbidden",
    /** Délai demandé par le relais avant un nouvel essai (429 `Retry-After`), en ms. */
    readonly retryAfterMs?: number,
  ) {
    super(kind);
  }
}

async function postGw(fetchImpl: typeof fetch, path: string, body?: unknown): Promise<Response> {
  return fetchImpl(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Retour de nokker.ai : vérifie `state`, échange le code. L'entrée en attente est consommée quoi qu'il arrive. */
export async function completeCallback(
  search: string,
  store: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayToken & { back: string }> {
  const q = new URLSearchParams(search);
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(store.getItem(PENDING_KEY) ?? "null") as Pending | null;
  } catch {
    pending = null;
  }
  store.removeItem(PENDING_KEY);
  if (q.get("error")) throw new GatewayAuthError("denied");
  const code = q.get("code");
  if (!pending || !code || q.get("state") !== pending.state) throw new GatewayAuthError("state");
  const res = await postGw(fetchImpl, "/_gw/token", { code, code_verifier: pending.verifier });
  if (!res.ok) throw new GatewayAuthError("exchange");
  const tok = (await res.json()) as GatewayToken;
  return { ...tok, back: safeBack(pending.back) };
}

/** Renouvelle par le cookie du relais. `null` : pas (ou plus) de connexion ; `unavailable` (502…) : réessayer. */
export async function refreshToken(fetchImpl: typeof fetch = fetch): Promise<GatewayToken | null> {
  const res = await postGw(fetchImpl, "/_gw/refresh");
  if (res.status === 401 || res.status === 400) return null;
  if (res.status === 403) throw new GatewayAuthError("forbidden");
  if (res.status === 429) {
    const s = Number(res.headers.get("Retry-After"));
    throw new GatewayAuthError("unavailable", (Number.isFinite(s) && s > 0 ? s : 60) * 1000);
  }
  if (!res.ok) throw new GatewayAuthError("unavailable");
  return (await res.json()) as GatewayToken;
}

export async function logout(fetchImpl: typeof fetch = fetch): Promise<void> {
  await postGw(fetchImpl, "/_gw/logout").catch(() => undefined);
}

/** Délai avant le prochain renouvellement : 80 % de la durée, au moins 10 s ; échec 502 : 15 s. */
export const refreshDelayMs = (expiresIn: number): number => Math.max(10, expiresIn * 0.8) * 1000;
export const RETRY_MS = 15_000;
