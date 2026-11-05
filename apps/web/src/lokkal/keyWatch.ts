/**
 * Local key refused DURING a session (LOKKAL §7.1): the installation was reset or the key revoked while a tab stayed
 * open. The app's client reports every 401 with the bearer that caused it (`watchingFetch`); in local mode the store
 * reacts only to a 401 carrying ITS key, and only once the core confirms the key itself is refused
 * (`GET /v1/local/setup` with that key → 401). A 401 that is about something else (wrong TOTP code, expired image
 * signature) keeps the session. Then the key is forgotten (`forgetLocalToken(key)`, never a newer one) and the key
 * page comes back.
 */
import type { FetchLike, RequestInitLike } from "@nokker-apps/sdk";

type Listener = (bearer: string) => void;
const listeners = new Set<Listener>();

/** Called with the bearer of each request answered 401. */
export function onUnauthorized(f: Listener): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

export function bearerOf(init: RequestInitLike | undefined): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return null;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "authorization" && typeof v === "string" && v.startsWith("Bearer ")) return v.slice(7).trim();
  }
  return null;
}

/** `fetch` for the app's client: same answers, plus a report of each 401 and its bearer. */
export function watchingFetch(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const res = await inner(url, init);
    if (res.status === 401) {
      const bearer = bearerOf(init);
      if (bearer) listeners.forEach((f) => f(bearer));
    }
    return res;
  };
}

/** The core refuses this local key itself (not just one route): `GET /v1/local/setup` with it answers 401. */
export async function localKeyRefused(baseUrl: string, key: string, f: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await f(`${baseUrl}/v1/local/setup`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } })).status === 401;
  } catch {
    return false; // unreachable: not a refusal, the session stays
  }
}
