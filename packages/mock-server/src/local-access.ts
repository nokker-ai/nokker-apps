/**
 * Accès à la machine sans jeton dans l'URL (contrat dev du 18.11.2026, côté noyau) — mock.
 *
 *   POST   /v1/local/session-code                  jeton LOCAL seulement → {code, expires_in: 60} (au plus 5 vivants)
 *   POST   /v1/local/session-code/exchange {code}  SANS Authorization, loopback → {token, expires_in} ; 410 code_used|code_expired ;
 *                                                  10 échecs/min au plus (429)
 *   GET    /v1/local/access-sessions               jeton LOCAL seulement : les sessions d'accès (créée, dernière utilisation, agent)
 *   DELETE /v1/local/access-sessions/{id}          jeton LOCAL seulement : révocation
 *
 * Le jeton de SESSION est distinct du jeton local : mêmes droits propriétaire sur /v1/local/*, SAUF mint, liste et
 * révocation (réservés au jeton local). Le code est le secret de l'échange ; il ne sert qu'une fois, 60 s.
 */
import { randomBytes } from "node:crypto";
import type { MockState } from "./state.js";
import { LOCAL_OWNER } from "./state.js";

type Send = (status: number, payload: unknown) => void;

export const SESSION_CODE_TTL_S = 60;
export const SESSION_TOKEN_TTL_S = 30 * 24 * 3600;
export const SESSION_CODES_MAX = 5;
export const EXCHANGE_FAILS_PER_MIN = 10;

/** Portée d'un jeton de session (noyau p2/integ-kiosk-code) : `owner` (défaut), `kiosk` (liste blanche en lecture), `present` (propriétaire sans gestion, 12 h fixes). */
export type AccessScope = "owner" | "kiosk" | "present";
export const PRESENT_TTL_S = 12 * 3600;
export interface AccessSession {
  id: string;
  scope: AccessScope;
  /** Fixe pour `present` (pas glissant). */
  fixed_until?: number;
  token: string;
  created_at: number;
  last_used_at: number;
  /** Glissant : dernière utilisation + 30 jours. */
  expires_at: number;
  agent: string;
}
interface Code {
  at: number;
  used: boolean;
  scope: AccessScope;
}
interface Access {
  codes: Map<string, Code>;
  sessions: Map<string, AccessSession>; // par jeton
  fails: number[];
  ttlMs: number;
}
const all = new WeakMap<MockState, Access>();
const acc = (state: MockState): Access => {
  let a = all.get(state);
  if (!a) all.set(state, (a = { codes: new Map(), sessions: new Map(), fails: [], ttlMs: SESSION_CODE_TTL_S * 1000 }));
  return a;
};
const b64url = (n: number): string => randomBytes(n).toString("base64url");

/** Tests : durée de vie d'un code (ms). */
export function accessSetCodeTtl(state: MockState, ms: number): void {
  acc(state).ttlMs = ms;
}
export function accessReset(state: MockState): void {
  all.set(state, { codes: new Map(), sessions: new Map(), fails: [], ttlMs: SESSION_CODE_TTL_S * 1000 });
}
/** Session d'accès portée par ce jeton (et sa dernière utilisation mise à jour), ou undefined. */
export function accessSessionOf(state: MockState, token: string, agent = ""): AccessSession | undefined {
  const s = acc(state).sessions.get(token);
  if (s) {
    s.last_used_at = Date.now() / 1000;
    if (s.fixed_until !== undefined && s.last_used_at >= s.fixed_until) {
      acc(state).sessions.delete(token); // `present` : 12 h, fixes
      return undefined;
    }
    if (s.fixed_until === undefined) s.expires_at = s.last_used_at + SESSION_TOKEN_TTL_S;
    if (agent) s.agent = agent.slice(0, 60);
  }
  return s;
}

const err = (send: Send, status: number, code: string): boolean => (send(status, { error: { code, message: code } }), true);

/** Échange du code : AVANT l'authentification (le code est le secret). */
export async function handleExchange(state: MockState, method: string, path: string, loopback: boolean, agent: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (method !== "POST" || path !== "/v1/local/session-code/exchange") return false;
  if (!loopback) return err(send, 403, "forbidden");
  const a = acc(state);
  const now = Date.now();
  a.fails = a.fails.filter((t) => now - t < 60_000);
  const body = await readBody();
  const code = String(body.code ?? "");
  // Ordre du noyau (a30bd4f5) : forme du code (400 bad_code), `expect` connu (400 bad_scope), limite de débit (429), puis le code.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return err(send, 400, "bad_code"); // mal formé : ni échec compté, ni jeton
  const expectRaw = body.expect;
  if (expectRaw !== undefined && expectRaw !== null && expectRaw !== "owner" && expectRaw !== "kiosk" && expectRaw !== "present") return err(send, 400, "bad_scope");
  if (a.fails.length >= EXCHANGE_FAILS_PER_MIN) return err(send, 429, "rate_limited");
  const c = a.codes.get(code);
  if (!c) {
    a.fails.push(now);
    return err(send, 410, "code_expired"); // comme le noyau : un code inconnu répond code_expired
  }
  if (c.used) {
    a.fails.push(now);
    return err(send, 410, "code_used");
  }
  // `expect` (noyau p2/integ-exchange-expect) : facultatif ; la portée du code doit y correspondre, sinon 409 `wrong_scope` SANS
  // consommer le code, sans créer de session, sans compter d'échec ; `expect` inconnu : 400 `bad_scope`, code intact. Un code
  // inconnu, expiré ou déjà utilisé dit 410 AVANT toute comparaison de portée.
  const expired = now - c.at >= a.ttlMs;
  if (expectRaw !== undefined && expectRaw !== null && !expired && expectRaw !== c.scope) return err(send, 409, "wrong_scope");
  c.used = true; // une seule fois, périmé ou non
  if (expired) {
    a.fails.push(now);
    return err(send, 410, "code_expired");
  }
  const token = b64url(32);
  const scope = c.scope;
  const fixed = scope === "present" ? now / 1000 + PRESENT_TTL_S : undefined;
  a.sessions.set(token, { id: `as_${randomBytes(8).toString("hex")}`, scope, ...(fixed !== undefined ? { fixed_until: fixed } : {}), token, created_at: now / 1000, last_used_at: now / 1000, expires_at: fixed ?? now / 1000 + SESSION_TOKEN_TTL_S, agent: agent.slice(0, 60) });
  send(200, { token, expires_in: fixed !== undefined ? PRESENT_TTL_S : SESSION_TOKEN_TTL_S, scope });
  return true;
}

/** Mint, liste, révocation : jeton LOCAL seulement (`viaSession` : refusé). */
export async function handleAccess(state: MockState, user: string | null, viaSession: boolean, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const mint = method === "POST" && path === "/v1/local/session-code";
  const list = method === "GET" && path === "/v1/local/access-sessions";
  const del = method === "DELETE" ? /^\/v1\/local\/access-sessions\/(as_[0-9a-f]{16})$/.exec(path) : null;
  // Arrêt de l'unité du kiosque : `DELETE /v1/local/access-sessions/scope/{portée}` (noyau p2/integ-kiosk-code), pas une requête `?scope=`.
  const delScope = method === "DELETE" ? (/^\/v1\/local\/access-sessions\/scope\/([a-z]+)$/.exec(path)?.[1] ?? null) : null;
  if (!mint && !list && !del && delScope === null) return false;
  if (user !== LOCAL_OWNER || viaSession) return err(send, 401, "local_token_required"); // jeton de session : 401, comme le noyau
  const a = acc(state);
  if (mint) {
    const now = Date.now();
    const live = [...a.codes.values()].filter((c) => !c.used && now - c.at < a.ttlMs).length;
    if (live >= SESSION_CODES_MAX) return err(send, 429, "too_many_codes");
    const body = await readBody().catch(() => ({}) as Record<string, unknown>);
    const want = body.scope === undefined ? "owner" : String(body.scope);
    if (want !== "owner" && want !== "kiosk" && want !== "present") return err(send, 400, "bad_scope");
    const code = b64url(16);
    a.codes.set(code, { at: now, used: false, scope: want });
    send(200, { code, expires_in: SESSION_CODE_TTL_S });
    return true;
  }
  if (list) {
    send(200, { sessions: [...a.sessions.values()].map(({ token: _t, fixed_until: _f, ...s }) => (void _t, void _f, s)) });
    return true;
  }
  if (delScope !== null) {
    if (delScope !== "owner" && delScope !== "kiosk" && delScope !== "present") return err(send, 400, "bad_scope");
    let n = 0;
    for (const [t, s] of [...a.sessions.entries()]) if (s.scope === delScope) (a.sessions.delete(t), n++);
    send(200, { revoked: n, scope: delScope });
    return true;
  }
  const hit = [...a.sessions.entries()].find(([, s]) => s.id === del![1]);
  if (!hit) return err(send, 404, "not_found");
  a.sessions.delete(hit[0]);
  send(200, { id: del![1], revoked: true });
  return true;
}

/** Portée du jeton de session du porteur (`owner` pour le jeton local ou une session d'accès ordinaire). */
export function scopeOf(state: MockState, bearer: string): AccessScope {
  return acc(state).sessions.get(bearer)?.scope ?? "owner";
}

const PRESENT_DENY_READ_OR_WRITE = [/^\/v1\/local\/session-code/, /^\/v1\/local\/access-sessions/, /^\/v1\/local\/setup/, /^\/v1\/local\/accord/, /^\/v1\/local\/tools\/call$/, /^\/v1\/connectors/, /^\/v1\/account\/(export|delete)/];
const PRESENT_DENY_WRITE = [/^\/v1\/approvals/, /^\/v1\/local\/approvals/, /^\/v1\/devices/];

/** Refus de portée (403 `scope_kiosk` | `scope_present`) ou `false` : la requête passe. */
export function scopeRefusal(scope: AccessScope, method: string, path: string): "scope_kiosk" | "scope_present" | false {
  if (scope === "kiosk") {
    const ok = method === "GET" && (path === "/v1/local/kiosk" || path === "/v1/capabilities" || path === "/healthz");
    return ok ? false : "scope_kiosk";
  }
  if (scope === "present") {
    if (PRESENT_DENY_READ_OR_WRITE.some((r) => r.test(path))) return "scope_present";
    if (method !== "GET" && method !== "HEAD" && PRESENT_DENY_WRITE.some((r) => r.test(path))) return "scope_present";
  }
  return false;
}
