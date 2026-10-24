/**
 * Connexion par la passerelle (LOKKAL.md §7.3, contrat onboarding/dev/brosim du 24.10) — mock.
 *
 *   POST /v1/gateway/authorize {host, code_challenge, code_challenge_method} (session) → {code, redirect, expires_in}
 *   POST /_gw/token {code, code_verifier} → {access_token, expires_in} + cookie de renouvellement (relais)
 *   POST /_gw/refresh (cookie) → {access_token, expires_in}, rotation ; 401 si refusé (cookie effacé)
 *   POST /_gw/logout → 204, cookie effacé
 *
 * Simplifications : le relais et nokker.ai sont le même serveur ; le cookie s'appelle `nk_rt` (le préfixe `__Host-`
 * exige https, la recette du mock est en http) ; `POST /v1/dev/gateway-mock {refresh: "fail"|"down"}` règle la
 * prochaine réponse de `/_gw/refresh` (401 ou 502). Le jeton d'accès est une session du mock en forme de JWT
 * (`sub` lisible), sans signature réelle.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MOCK_USER, type MockState } from "./state.js";

const COOKIE = "nk_rt";
const ACCESS_TTL_S = 900;

interface GwMock {
  codes: Map<string, { host: string; challenge: string; expiresAt: number }>;
  refresh: Map<string, string>; // refresh → host
  next: "fail" | "down" | null;
}
const mocks = new WeakMap<MockState, GwMock>();
function gw(state: MockState): GwMock {
  let m = mocks.get(state);
  if (!m) mocks.set(state, (m = { codes: new Map(), refresh: new Map(), next: null }));
  return m;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const s256 = (v: string): string => createHash("sha256").update(v).digest("base64url");

function accessToken(state: MockState): string {
  const token = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: MOCK_USER, scope: "gateway" }))}.${randomBytes(12).toString("base64url")}`;
  state.sessions.set(token, { token, deviceId: "passerelle", expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString() });
  return token;
}

function cookieOf(req: IncomingMessage): string | null {
  const raw = req.headers.cookie ?? "";
  const hit = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return hit ? hit.slice(COOKIE.length + 1) : null;
}

function reply(res: ServerResponse, status: number, body: unknown, cookie?: string | null): void {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (cookie !== undefined) {
    headers["Set-Cookie"] = cookie === null ? `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` : `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
  }
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": buf.length });
  res.end(buf);
}

function newRefresh(m: GwMock, host: string): string {
  const r = randomBytes(24).toString("base64url");
  m.refresh.set(r, host);
  return r;
}

/** Routes du relais (`/_gw/*`) et réglage de démo : AVANT l'authentification (le cookie fait foi). */
export async function handleGatewayRelay(
  state: MockState,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
): Promise<boolean> {
  const m = gw(state);
  if (method === "POST" && path === "/v1/dev/gateway-mock") {
    const b = await readBody();
    m.next = b.refresh === "fail" || b.refresh === "down" ? b.refresh : null;
    reply(res, 200, { ok: true });
    return true;
  }
  if (!path.startsWith("/_gw/")) return false;
  if (method !== "POST") return reply(res, 404, { error: { message: "inconnu" } }), true;
  // CSRF (relais) : JSON obligatoire, ce qui impose une requête préalable CORS à toute autre origine.
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(res, 403, { error: { message: "json requis" } }), true;
  if (path === "/_gw/token") {
    const b = await readBody();
    // Code consommé même en cas d'échec (un verifier faux le grille : il faut refaire authorize).
    const c = m.codes.get(String(b.code ?? ""));
    m.codes.delete(String(b.code ?? ""));
    if (!c || c.expiresAt < Date.now() || s256(String(b.code_verifier ?? "")) !== c.challenge) return reply(res, 400, { error: { message: "code invalide" } }), true;
    return reply(res, 200, { access_token: accessToken(state), expires_in: ACCESS_TTL_S }, newRefresh(m, c.host)), true;
  }
  if (path === "/_gw/refresh") {
    const next = m.next;
    m.next = null;
    if (next === "down") return reply(res, 502, { error: { message: "nokker.ai injoignable" } }), true;
    const old = cookieOf(req);
    const host = old ? m.refresh.get(old) : undefined;
    if (old) m.refresh.delete(old);
    if (!host || next === "fail") return reply(res, 401, { error: { message: "reconnexion requise" } }, null), true;
    return reply(res, 200, { access_token: accessToken(state), expires_in: ACCESS_TTL_S }, newRefresh(m, host)), true;
  }
  if (path === "/_gw/logout") {
    const old = cookieOf(req);
    if (old) m.refresh.delete(old);
    return reply(res, 204, null, null), true;
  }
  return reply(res, 404, { error: { message: "inconnu" } }), true;
}

/** `POST /v1/gateway/authorize` (nokker.ai, session du compte). En mock, tout hôte est « une machine du compte » sauf
 * ceux qui commencent par `autre-` (403, pour la recette). */
export async function handleGatewayAuthorize(
  state: MockState,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: (status: number, payload: unknown) => void,
): Promise<boolean> {
  if (method !== "POST" || path !== "/v1/gateway/authorize") return false;
  const b = await readBody();
  const host = String(b.host ?? "").toLowerCase();
  const challenge = String(b.code_challenge ?? "");
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || b.code_challenge_method !== "S256") return send(400, { error: { message: "requête invalide" } }), true;
  if (host.startsWith("autre-")) return send(403, { error: { message: "machine inconnue de ce compte" } }), true;
  const code = randomBytes(16).toString("base64url");
  gw(state).codes.set(code, { host, challenge, expiresAt: Date.now() + 60_000 });
  const scheme = /\.nokker\.app$/.test(host) ? "https" : "http";
  return send(200, { code, redirect: `${scheme}://${host}/auth/callback`, expires_in: 60 }), true;
}
