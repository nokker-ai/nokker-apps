/**
 * SSO OIDC des équipes (LOKKAL §7.24) — mock, derrière le drapeau `sso` (option `sso` ou `MOCK_SSO=1` ; éteint : aucune
 * route, 404 comme le noyau). Le fournisseur d'identité est simulé : `authorize_url` mène à une page du mock
 * (`/v1/dev/sso/authorize`) qui propose des identités de recette et renvoie vers le chemin de `redirect_uri`
 * (même origine que le client web en dev, derrière le proxy de Vite).
 *
 * Simplifications : la preuve DNS est simulée par le nom du domaine (`absent.…` → 409 `not_verified`, `pris.…` →
 * 409 `domain_claimed`, `dns-hs.…` → 503 `dns_unavailable`, le reste est prouvé) ; le compte connecté reste
 * `alice` (mock mono-utilisateur) ; groupes et refus viennent de l'identité choisie sur la page du fournisseur.
 * Démo (drapeau allumé) : une connexion d'alice prouvée sur example.com liée à « Site vitrine », et « Recherche »
 * (projet de bob) en SSO obligatoire par une connexion de bob — alice le voit réduit tant qu'elle n'est pas passée
 * par le SSO.
 */
import { randomBytes, webcrypto } from "node:crypto";
import type { ProjectRole, SsoAuditEvent, SsoBinding, SsoConnection, SsoDomain, SsoMapping, SsoTokenAuth } from "@nokker-apps/sdk";
import { MOCK_USER, randomId, type MockState } from "./state.js";
import { teamMember, teamProjectOwner, teamReady, teamSetMember } from "./team.js";

type Send = (status: number, payload: unknown) => void;
/** Appareil de la session : `approved_via` (`sso:sc_…`) et heure de confirmation (epoch s). */
export interface SsoSession {
  via: string | null;
  at: number | null;
}

const RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
const MAX_CONNECTIONS = 5;
const MAX_DOMAINS = 20;
const MIN_AGE = 300;
const MAX_AGE = 7 * 86400;
const DEFAULT_AGE = 12 * 3600;
const FLOW_TTL_S = 600;
const iso = (s: number | null): string | null => (s === null ? null : new Date(s * 1000).toISOString());
const now = (): number => Math.floor(Date.now() / 1000);

interface Conn {
  id: string;
  owner: string;
  name: string;
  issuer: string;
  client_id: string;
  secret_name: string;
  secret_set: boolean;
  groups_claim: string;
  token_auth: SsoTokenAuth;
  domains: { domain: string; token: string; verified_at: number | null }[];
  created_at: number;
  updated_at: number;
}
interface Flow {
  cid: string;
  spki: string;
  name: string;
  expires: number;
}
/** Identités de recette proposées par la page du fournisseur simulé ; l'adresse prend le premier domaine prouvé de
 * la connexion (sauf `foreign`, hors de ses domaines). */
interface Persona {
  label: string;
  foreign?: boolean;
  verified: boolean;
  groups: string[];
  outcome?: "token_invalid" | "account_conflict" | "account_inactive";
}
const PERSONAS: Record<string, Persona> = {
  ok: { label: "groupes equipe-site, lecteurs", verified: true, groups: ["equipe-site", "lecteurs"] },
  sans_groupe: { label: "aucun groupe", verified: true, groups: [] },
  non_verifie: { label: "adresse non vérifiée par le fournisseur", verified: false, groups: [] },
  hors_domaine: { label: "adresse hors des domaines prouvés", foreign: true, verified: true, groups: [] },
  conflit: { label: "compte déjà lié à une autre identité", verified: true, groups: [], outcome: "account_conflict" },
  inactif: { label: "compte suspendu", verified: true, groups: [], outcome: "account_inactive" },
  jeton: { label: "jeton d'identité invalide", verified: true, groups: [], outcome: "token_invalid" },
};
const emailOf = (p: Persona, c: Conn | undefined): string =>
  p.foreign ? `${MOCK_USER}@autre.example` : `${MOCK_USER}@${c?.domains.find((d) => d.verified_at !== null)?.domain ?? "example.com"}`;

interface S {
  conns: Map<string, Conn>;
  bindings: Map<string, SsoBinding>;
  /** Projets dont l'adhésion d'un compte est tenue par le SSO : `pj|compte`. */
  managed: Set<string>;
  flows: Map<string, Flow>;
  codes: Map<string, { state: string; persona: string }>;
  audit: Map<string, SsoAuditEvent[]>;
}
const all = new WeakMap<MockState, S>();
function sso(state: MockState): S {
  let s = all.get(state);
  if (!s) all.set(state, (s = { conns: new Map(), bindings: new Map(), managed: new Set(), flows: new Map(), codes: new Map(), audit: new Map() }));
  return s;
}

export const redirectUri = (): string => process.env.MOCK_SSO_REDIRECT_URI ?? "https://app.example.com/sso/callback";

function log(s: S, cid: string, event: string, extra: Partial<SsoAuditEvent> = {}): void {
  const list = s.audit.get(cid) ?? [];
  list.unshift({ at: iso(now()), event, account: "", email: "", project_id: "", detail: {}, ...extra });
  s.audit.set(cid, list.slice(0, 500));
}

function connJson(s: S, c: Conn): SsoConnection {
  return {
    id: c.id,
    name: c.name,
    issuer: c.issuer,
    client_id: c.client_id,
    client_secret: { name: c.secret_name, set: c.secret_set },
    groups_claim: c.groups_claim,
    token_auth: c.token_auth,
    redirect_uri: redirectUri(),
    domains: c.domains.map(domainJson),
    projects: [...s.bindings.values()].filter((b) => b.connection === c.id).map((b) => b.project_id),
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  };
}
const domainJson = (d: Conn["domains"][number]): SsoDomain => ({
  domain: d.domain,
  verified: d.verified_at !== null,
  verified_at: iso(d.verified_at),
  txt: { name: `_nokker-sso.${d.domain}`, value: `nokker-sso=${d.token}` },
});

function newConn(owner: string, f: { name: string; issuer: string; client_id: string; secret_name: string; groups_claim?: string; token_auth?: SsoTokenAuth }): Conn {
  return {
    id: `sc_${randomBytes(8).toString("hex")}`,
    owner,
    name: f.name,
    issuer: f.issuer,
    client_id: f.client_id,
    secret_name: f.secret_name,
    secret_set: false,
    groups_claim: f.groups_claim ?? "groups",
    token_auth: f.token_auth ?? "client_secret_basic",
    domains: [],
    created_at: now(),
    updated_at: now(),
  };
}

/** Démo du drapeau allumé (appelé au premier accès aux projets). */
export function ssoSeed(state: MockState, projects: { id: string; name: string; owner: string }[]): void {
  const s = sso(state);
  const mine = newConn(MOCK_USER, { name: "Annuaire de l'équipe (démo)", issuer: "https://idp.example.com", client_id: "nokker-demo", secret_name: "SSO_DEMO_CLIENT" });
  mine.secret_set = true;
  mine.domains.push({ domain: "example.com", token: randomBytes(16).toString("hex"), verified_at: now() - 86400 });
  s.conns.set(mine.id, mine);
  log(s, mine.id, "connection_created", { account: MOCK_USER, detail: { issuer: mine.issuer, client_id: mine.client_id } });
  log(s, mine.id, "domain_verified", { account: MOCK_USER, detail: { domain: "example.com" } });
  const site = projects.find((p) => p.name === "Site vitrine" && p.owner === MOCK_USER);
  if (site) {
    s.bindings.set(site.id, { project_id: site.id, connection: mine.id, mappings: [{ group: "leads", role: "maintainer" }, { group: "equipe-site", role: "member" }], required: false, max_age_s: DEFAULT_AGE, updated_at: iso(now() - 3600) });
    log(s, mine.id, "binding_set", { account: MOCK_USER, project_id: site.id });
  }
  const other = projects.find((p) => p.name === "Recherche" && p.owner !== MOCK_USER);
  if (other) {
    const theirs = newConn(other.owner, { name: "Annuaire de bob (démo)", issuer: "https://idp.example.net", client_id: "nokker-demo-2", secret_name: "SSO_DEMO_CLIENT_2" });
    theirs.secret_set = true;
    theirs.domains.push({ domain: "example.net", token: randomBytes(16).toString("hex"), verified_at: now() - 86400 });
    s.conns.set(theirs.id, theirs);
    s.bindings.set(other.id, { project_id: other.id, connection: theirs.id, mappings: [{ group: "lecteurs", role: "viewer" }], required: true, max_age_s: DEFAULT_AGE, updated_at: iso(now() - 3600) });
  }
}

/** `Team.sso_gate` : la connexion exigée si l'accès est refusé, sinon null. Le propriétaire n'est jamais bloqué. */
export function ssoGate(state: MockState, pid: string, _user: string, isOwner: boolean, session: SsoSession): string | null {
  if (!state.sso || isOwner) return null;
  const b = sso(state).bindings.get(pid);
  if (!b?.required) return null;
  const fresh = session.via === `sso:${b.connection}` && session.at !== null && now() - session.at < b.max_age_s;
  return fresh ? null : b.connection;
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Domaine prouvé → connexion (une seule par domaine). */
function claimOf(s: S, domain: string): Conn | null {
  for (const c of s.conns.values()) if (c.domains.some((d) => d.domain === domain && d.verified_at !== null)) return c;
  return null;
}

async function verifyP1363(spki: string, payload: string, sigB64Url: string): Promise<boolean> {
  try {
    const key = await webcrypto.subtle.importKey("spki", Buffer.from(spki, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(sigB64Url, "base64url"), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

async function validSpki(spki: string): Promise<boolean> {
  try {
    await webcrypto.subtle.importKey("spki", Buffer.from(spki, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return spki.length > 0;
  } catch {
    return false;
  }
}

/** Publiques : `/v1/auth/oidc/start|callback` et la page du fournisseur simulé. */
export async function handleSsoPublic(state: MockState, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send, html: (status: number, body: string) => void): Promise<boolean> {
  if (!state.sso) return false;
  const s = sso(state);
  const path = url.pathname;
  if (path.startsWith("/v1/auth/oidc/") || path === "/v1/dev/sso/authorize") teamReady(state);
  if (method === "GET" && path === "/v1/dev/sso/authorize") return idpPage(s, url, html), true;
  if (method !== "POST" || (path !== "/v1/auth/oidc/start" && path !== "/v1/auth/oidc/callback")) return false;
  const b = await readBody();
  if (path === "/v1/auth/oidc/start") {
    const cidIn = str(b.connection);
    const email = str(b.email).toLowerCase();
    let c: Conn | null = null;
    if (/^sc_[0-9a-f]{16}$/.test(cidIn)) c = s.conns.get(cidIn) ?? null;
    else if (email && !cidIn) c = claimOf(s, email.split("@")[1] ?? "");
    if (!c) return err(send, 404, "unknown_connection", "connexion SSO inconnue");
    const spki = str(b.public_key_spki);
    if (!(await validSpki(spki))) return err(send, 400, "invalid_key", "public_key_spki : clé P-256 SPKI");
    if (!c.secret_set) return err(send, 503, "not_configured", "connexion SSO incomplète (secret du client absent)");
    if (c.issuer.includes("injoignable")) {
      log(s, c.id, "idp_unavailable", { detail: { step: "discovery" } });
      return err(send, 502, "idp_unavailable", "fournisseur d'identité injoignable");
    }
    const st = randomBytes(32).toString("base64url");
    s.flows.set(st, { cid: c.id, spki, name: str(b.name).slice(0, 80), expires: now() + FLOW_TTL_S });
    const q = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: redirectUri(), state: st, code_challenge_method: "S256", ...(email ? { login_hint: email } : {}) });
    return send(200, { authorize_url: `/v1/dev/sso/authorize?${q}`, state: st, connection: c.id, expires_at: iso(now() + FLOW_TTL_S) }), true;
  }
  // callback : `state` consommé d'abord, même en cas d'échec.
  const st = str(b.state);
  const flow = st ? s.flows.get(st) : undefined;
  if (st) s.flows.delete(st);
  if (!flow || flow.expires < now()) return err(send, 401, "invalid_state", "connexion SSO inconnue, expirée ou déjà utilisée");
  const cid = flow.cid;
  if (!(await verifyP1363(flow.spki, `${st}.oidc`, str(b.signature)))) {
    log(s, cid, "login_refused", { detail: { reason: "binding_invalid" } });
    return err(send, 401, "binding_invalid", "la connexion n'a pas été lancée par ce navigateur");
  }
  if (b.error) {
    log(s, cid, "login_refused", { detail: { reason: "idp_error", error: str(b.error).slice(0, 64) } });
    return err(send, 401, "idp_error", "le fournisseur d'identité a refusé la connexion");
  }
  const c = s.conns.get(cid);
  if (!c) return err(send, 401, "invalid_state", "connexion SSO inconnue, expirée ou déjà utilisée");
  const code = s.codes.get(str(b.code));
  if (code) s.codes.delete(str(b.code));
  if (!code || code.state !== st) {
    log(s, cid, "login_refused", { detail: { reason: "idp:exchange" } });
    return err(send, 401, "idp_error", "échange avec le fournisseur d'identité en échec");
  }
  const p = PERSONAS[code.persona]!;
  const email = emailOf(p, c);
  if (p.outcome === "token_invalid") {
    log(s, cid, "login_refused", { detail: { reason: "bad_signature" } });
    return err(send, 401, "token_invalid", "jeton d'identité refusé");
  }
  if (!p.verified) {
    log(s, cid, "login_refused", { email, detail: { reason: "email_unverified" } });
    return err(send, 403, "email_unverified", "le fournisseur ne garantit pas cette adresse e-mail");
  }
  if (claimOf(s, email.split("@")[1] ?? "")?.id !== cid) {
    log(s, cid, "login_refused", { email, detail: { reason: "domain_refused" } });
    return err(send, 403, "domain_refused", "adresse hors des domaines de cette connexion");
  }
  if (p.outcome === "account_inactive") {
    log(s, cid, "login_refused", { email, detail: { reason: "account_inactive" } });
    return err(send, 403, "account_inactive", "compte suspendu ou effacé");
  }
  if (p.outcome === "account_conflict") {
    log(s, cid, "login_refused", { email, detail: { reason: "account_conflict" } });
    return err(send, 409, "account_conflict", "ce compte est déjà lié à une autre identité de ce fournisseur");
  }
  const user = MOCK_USER;
  const id = randomId("dev");
  const at = new Date().toISOString();
  state.devices.set(id, { id, code: id.slice(4, 10), name: flow.name || "SSO", publicKeySpkiB64Url: flow.spki, status: "approved", created_at: at, approved_at: at, approved_via: `sso:${cid}`, user });
  const projects = syncRoles(state, s, c, user, p, email);
  log(s, cid, "login_ok", { account: user, email, detail: { projects } });
  return send(200, { device_id: id, user, projects }), true;
}

/** Groupes → rôles à chaque connexion : le plus haut ; aucun → retiré si l'adhésion est tenue par le SSO. */
function syncRoles(state: MockState, s: S, c: Conn, user: string, p: Persona, email: string): { id: string; role: ProjectRole | null }[] {
  const out: { id: string; role: ProjectRole | null }[] = [];
  for (const b of s.bindings.values()) {
    if (b.connection !== c.id) continue;
    const cur = teamMember(state, b.project_id, user);
    if (cur?.role === "owner") {
      out.push({ id: b.project_id, role: "owner" });
      continue;
    }
    const roles = b.mappings.filter((m) => p.groups.includes(m.group)).map((m) => m.role);
    const role = roles.length ? roles.reduce((a, r) => (RANK[r] > RANK[a] ? r : a)) : null;
    const key = `${b.project_id}|${user}`;
    if (role === null) {
      let kept: ProjectRole | null = cur?.role ?? null;
      if (cur && s.managed.has(key)) {
        teamSetMember(state, b.project_id, user, null);
        s.managed.delete(key);
        log(s, c.id, "role_removed", { account: user, email, project_id: b.project_id, detail: { from: cur.role } });
        kept = null;
      }
      out.push({ id: b.project_id, role: kept });
      continue;
    }
    if (!cur) log(s, c.id, "member_added", { account: user, email, project_id: b.project_id, detail: { role } });
    else if (cur.role !== role) log(s, c.id, "role_changed", { account: user, email, project_id: b.project_id, detail: { from: cur.role, to: role } });
    teamSetMember(state, b.project_id, user, role);
    s.managed.add(key);
    out.push({ id: b.project_id, role });
  }
  return out;
}

function idpPage(s: S, url: URL, html: (status: number, body: string) => void): void {
  const st = url.searchParams.get("state") ?? "";
  const conn = s.conns.get(s.flows.get(st)?.cid ?? "");
  const back = new URL(url.searchParams.get("redirect_uri") ?? redirectUri()).pathname; // même origine que le web en dev
  const link = (q: Record<string, string>): string => `${back}?${new URLSearchParams({ ...q, state: st })}`;
  const items = Object.entries(PERSONAS).map(([k, p]) => {
    const code = randomBytes(12).toString("base64url");
    s.codes.set(code, { state: st, persona: k });
    return `<li><a href="${link({ code })}">${emailOf(p, conn)} — ${p.label}</a></li>`;
  });
  items.push(`<li><a href="${link({ error: "access_denied" })}">Refuser la connexion</a></li>`);
  html(200, `<!doctype html><meta charset="utf-8"><title>Fournisseur d'identité (mock)</title><body style="font:16px system-ui;max-width:40rem;margin:3rem auto"><h1>Fournisseur d'identité simulé</h1><p>Choisis l'identité à renvoyer :</p><ul>${items.join("")}</ul></body>`);
}

/** Routes du propriétaire (session) : connexions, secret, domaines, journal, lien projet. */
export async function handleSso(state: MockState, user: string, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (!state.sso) return false;
  teamReady(state);
  const s = sso(state);
  const path = url.pathname.replace(/\/+$/, "");
  const pj = /^\/v1\/projects\/([^/]+)\/sso$/.exec(path);
  if (pj) return binding(state, s, user, decodeURIComponent(pj[1]!), method, readBody, send);
  if (path !== "/v1/sso/connections" && !path.startsWith("/v1/sso/connections/")) return false;
  const parts = path.slice("/v1/sso/connections".length).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) {
    if (method === "GET") return send(200, { connections: [...s.conns.values()].filter((c) => c.owner === user).map((c) => connJson(s, c)) }), true;
    if (method === "POST") {
      const b = await readBody();
      const f = fields(b, false, send);
      if (!f) return true;
      if ([...s.conns.values()].filter((c) => c.owner === user).length >= MAX_CONNECTIONS) return err(send, 409, "too_many", `${MAX_CONNECTIONS} connexions SSO au plus par compte`);
      const c = newConn(user, f as Parameters<typeof newConn>[1]);
      s.conns.set(c.id, c);
      log(s, c.id, "connection_created", { account: user, detail: { issuer: c.issuer, client_id: c.client_id } });
      return send(201, connJson(s, c)), true;
    }
    return err(send, 404, "not_found", "not found");
  }
  const c = s.conns.get(parts[0]!);
  if (!c || c.owner !== user) return err(send, 404, "not_found", "not found");
  if (parts.length === 1) {
    if (method === "GET") return send(200, connJson(s, c)), true;
    if (method === "PATCH") {
      const f = fields(await readBody(), true, send);
      if (!f) return true;
      Object.assign(c, f, { updated_at: now() });
      log(s, c.id, "connection_changed", { account: user, detail: { fields: Object.keys(f).sort() } });
      return send(200, connJson(s, c)), true;
    }
    if (method === "DELETE") {
      s.conns.delete(c.id);
      for (const [k, b] of s.bindings) if (b.connection === c.id) s.bindings.delete(k);
      log(s, c.id, "connection_deleted", { account: user });
      return send(200, { deleted: true }), true;
    }
  }
  if (parts[1] === "client-secret" && parts.length === 2 && method === "PUT") {
    const v = (await readBody()).value;
    if (typeof v !== "string" || !v || v.length > 4096 || v !== v.trim()) return err(send, 400, "bad_value", "value : le secret du client, 4096 caractères au plus, sans espace autour");
    c.secret_set = true;
    log(s, c.id, "client_secret_set", { account: user, detail: { name: c.secret_name } });
    return send(200, { client_secret: { name: c.secret_name, set: true } }), true;
  }
  if (parts[1] === "audit" && parts.length === 2 && method === "GET") {
    const n = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500));
    return send(200, { events: (s.audit.get(c.id) ?? []).slice(0, n) }), true;
  }
  if (parts[1] === "domains") {
    if (parts.length === 2 && method === "POST") {
      const domain = str((await readBody()).domain).toLowerCase();
      if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain)) return err(send, 400, "bad_domain", "domaine illisible (ex. example.com)");
      const hit = c.domains.find((d) => d.domain === domain);
      if (hit) return send(201, domainJson(hit)), true;
      if (c.domains.length >= MAX_DOMAINS) return err(send, 409, "too_many", `${MAX_DOMAINS} domaines au plus`);
      const d = { domain, token: randomBytes(16).toString("hex"), verified_at: null };
      c.domains.push(d);
      log(s, c.id, "domain_added", { account: user, detail: { domain } });
      return send(201, domainJson(d)), true;
    }
    const d = c.domains.find((x) => x.domain === (parts[2] ?? "").toLowerCase());
    if (parts.length === 4 && parts[3] === "verify" && method === "POST") {
      if (!d) return err(send, 404, "not_found", "domaine inconnu");
      if (d.verified_at !== null) return send(200, domainJson(d)), true;
      if (d.domain.startsWith("dns-hs.")) return err(send, 503, "dns_unavailable", "résolution DNS impossible pour le moment");
      if (d.domain.startsWith("absent.")) return err(send, 409, "not_verified", `enregistrement TXT _nokker-sso.${d.domain} absent ou différent`);
      const other = claimOf(s, d.domain);
      if (d.domain.startsWith("pris.") || (other && other.id !== c.id)) return err(send, 409, "domain_claimed", "ce domaine est déjà prouvé par une autre connexion SSO");
      d.verified_at = now();
      log(s, c.id, "domain_verified", { account: user, detail: { domain: d.domain } });
      return send(200, domainJson(d)), true;
    }
    if (parts.length === 3 && method === "DELETE") {
      if (!d) return err(send, 404, "not_found", "domaine inconnu");
      c.domains = c.domains.filter((x) => x !== d);
      log(s, c.id, "domain_removed", { account: user, detail: { domain: d.domain } });
      return send(200, { removed: true }), true;
    }
  }
  return err(send, 404, "not_found", "not found");
}

function fields(b: Record<string, unknown>, partial: boolean, send: Send): Partial<Conn> | null {
  if (["client_secret", "secret", "value", "token", "password"].some((k) => k in b)) {
    err(send, 400, "secret_value_refused", "le secret du client se pose par PUT …/client-secret ; ici, seulement son nom");
    return null;
  }
  const allowed = ["name", "issuer", "client_id", "client_secret_name", "groups_claim", "token_auth"];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) return err(send, 400, "bad_request", `champ inconnu : ${unknown.sort()[0]}`), null;
  const out: Partial<Conn> = {};
  for (const k of ["name", "issuer", "client_id", "client_secret_name"]) if (!partial && !str(b[k])) return err(send, 400, "bad_request", `${k} requis`), null;
  if ("name" in b) out.name = str(b.name).slice(0, 80);
  if ("issuer" in b) {
    const v = str(b.issuer).replace(/\/+$/, "");
    if (!/^https:\/\/[^\s@?#]+$/.test(v)) return err(send, 400, "bad_issuer", "issuer : une URL https, sans requête ni identifiants"), null;
    out.issuer = v;
  }
  if ("client_id" in b) {
    if (!/^[\x21-\x7e]{1,255}$/.test(str(b.client_id))) return err(send, 400, "bad_request", "client_id : caractères visibles, sans espace"), null;
    out.client_id = str(b.client_id);
  }
  if ("client_secret_name" in b) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(str(b.client_secret_name))) return err(send, 400, "bad_name", "client_secret_name : lettres, chiffres, « _ », « . », « - » (64 au plus)"), null;
    out.secret_name = str(b.client_secret_name);
  }
  if ("groups_claim" in b) {
    if (!/^[A-Za-z0-9_:./-]{1,100}$/.test(str(b.groups_claim))) return err(send, 400, "bad_request", "groups_claim : nom de claim illisible"), null;
    out.groups_claim = str(b.groups_claim);
  }
  if ("token_auth" in b) {
    if (b.token_auth !== "client_secret_basic" && b.token_auth !== "client_secret_post") return err(send, 400, "bad_request", "token_auth : client_secret_basic | client_secret_post"), null;
    out.token_auth = b.token_auth;
  }
  return out;
}

async function binding(state: MockState, s: S, user: string, pid: string, method: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<true> {
  const me = teamMember(state, pid, user);
  if (!me) return err(send, 404, "not_found", "projet inconnu");
  if (me.role !== "owner") return err(send, 403, "forbidden", `rôle ${me.role} : owner au moins`);
  const cur = s.bindings.get(pid);
  if (method === "GET") return cur ? (send(200, cur), true) : err(send, 404, "not_found", "pas de SSO sur ce projet");
  if (method === "DELETE") {
    if (!cur) return err(send, 404, "not_found", "pas de SSO sur ce projet");
    s.bindings.delete(pid);
    log(s, cur.connection, "binding_removed", { account: user, project_id: pid });
    return send(200, { removed: true }), true;
  }
  if (method !== "PUT") return err(send, 404, "not_found", "not found");
  const b = await readBody();
  const unknown = Object.keys(b).filter((k) => !["connection", "mappings", "required", "max_age_s"].includes(k));
  if (unknown.length) return err(send, 400, "bad_request", `champ inconnu : ${unknown.sort()[0]}`);
  const c = s.conns.get(str(b.connection));
  if (!c || c.owner !== user || teamProjectOwner(state, pid) !== user) return err(send, 404, "not_found", "not found");
  if ("required" in b && typeof b.required !== "boolean") return err(send, 400, "bad_request", "required : true | false");
  const raw = b.mappings ?? [];
  if (!Array.isArray(raw)) return err(send, 400, "bad_request", "mappings : une liste de {group, role}");
  if (raw.length > 100) return err(send, 400, "too_many", "100 correspondances au plus");
  const mappings: SsoMapping[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    const group = str(m?.group);
    if (!group || group.length > 256) return err(send, 400, "bad_request", "mappings : une liste de {group, role}");
    if (m.role === "owner") return err(send, 400, "owner_not_mappable", "le rôle owner ne s'obtient pas par SSO");
    if (m.role !== "maintainer" && m.role !== "member" && m.role !== "viewer") return err(send, 400, "bad_role", "role : maintainer | member | viewer");
    if (!mappings.some((x) => x.group === group && x.role === m.role)) mappings.push({ group, role: m.role });
  }
  const age = b.max_age_s === undefined || b.max_age_s === null ? DEFAULT_AGE : b.max_age_s;
  if (typeof age !== "number" || !Number.isInteger(age) || age < MIN_AGE || age > MAX_AGE) return err(send, 400, "bad_request", `max_age_s : entier entre ${MIN_AGE} et ${MAX_AGE}`);
  const out: SsoBinding = { project_id: pid, connection: c.id, mappings, required: b.required === true, max_age_s: age, updated_at: iso(now()) };
  s.bindings.set(pid, out);
  log(s, c.id, "binding_set", { account: user, project_id: pid, detail: { mappings, required: out.required, max_age_s: age } });
  return send(200, out), true;
}
