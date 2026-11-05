/**
 * Plusieurs boîtes mail et agendas par profil, partage contrôlé (core docs/CONNECTORS-MULTI.md ee126e4 + décisions du
 * 05.11), mock : drapeau `MOCK_CONNECTORS_MULTI=1` (→ `features.connectors_multi`). Démo : un foyer à trois (moi,
 * Camille, Sam mineur) ; Camille partage sa boîte « famille » avec moi en lecture seule.
 *   GET    /v1/connectors                       → {connectors, members, presets}
 *   POST   /v1/connectors                       {kind, label?, settings, secret} → 201 carte
 *   PATCH  /v1/connectors/{id}                  {label?, default?: true}
 *   POST   /v1/connectors/{id}/test             → {ok, message, code}
 *   DELETE /v1/connectors/{id}                  → {revoked}
 *   POST   /v1/connectors/{id}/grants           {account_id, level} → 202 pending (carte forte) | 200 unchanged | 200 updated
 *   DELETE /v1/connectors/{id}/grants/{account_id|me}
 *   POST   /v1/dev/connectors-mock              {approve?: approval_id | "all", reset?: true} (mock seulement)
 * Les anciennes routes `/{mail|calendar}` restent celles de onboarding.ts (connecteur par défaut d'avant).
 */
import { argsSha256, type Approval } from "@nokker-apps/sdk";
import { approvalBubble } from "./demo.js";
import { MOCK_USER, randomId, type MockState } from "./state.js";

type Send = (status: number, obj: unknown) => void;
type Kind = "mail" | "calendar" | "contacts" | "files" | "tasks" | "pages";
type Level = "read" | "send" | "write";

interface Grant {
  account_id: string;
  level: Level;
  status: "active" | "pending";
  granted_at: string | null;
  approval_id: string | null;
  /** Monter de niveau : l'ancien reste actif jusqu'à l'approbation. */
  previous?: Level;
}

interface Conn {
  id: string;
  kind: Kind;
  label: string;
  default: boolean;
  settings: Record<string, string | number>;
  connected_at: string;
  last_ok_at: string | null;
  grants: Grant[];
  /** CONNECTORS-OAUTH : compte OAuth qui porte ce service. */
  oauth?: string;
}

/** Compte OAuth relié (oauth_accounts, 069) : un jeton, plusieurs connecteurs. */
interface OAuthAcct {
  id: string;
  provider: string;
  email: string;
  state: "ok" | "reconnect";
  /** Google Drive : grant séparé, avec le sélecteur. */
  picker: boolean;
  picked: Array<{ id: string; name: string; mime: string; picked_at: string }>;
}

/** Flux OAuth en cours (oauth_flows) : `state` → profil, fournisseur, services. */
interface Flow {
  provider: string;
  services: Kind[];
  label?: string;
  account?: string;
  picker: boolean;
  expires: number;
}

interface Shared {
  id: string;
  kind: Kind;
  label: string;
  address?: string;
  access: Level;
  owner: { account_id: string; name: string };
  state: "ok" | "unverified";
  last_ok_at: string | null;
  connected_at: string;
  granted_at: string;
}

interface MultiState {
  mine: Conn[];
  shared: Shared[];
  oauth: OAuthAcct[];
}

// `name` = partie locale de l'adresse, comme le noyau (les comptes n'ont pas de prénom).
export const MOCK_MEMBERS = [
  { account_id: "ac_camille", name: "camille", minor: false, email: "camille@example.org" },
  { account_id: "ac_sam", name: "sam", minor: true, email: "sam@example.org" },
];

export const MAIL_PRESETS_MULTI = ["aol", "bluewin", "fastmail", "gmail", "gmx", "hostpoint", "icloud", "infomaniak", "mailbox_org", "posteo", "sunrise", "web_de", "yahoo", "zoho"];

// Textes de nokker/connectors/mail.py (db6ad6f), abrégés aux préréglages les plus courants ; le reste sans aide.
const MAIL_HELP: Record<string, { fr: string; en: string }> = {
  gmail: { fr: "Mot de passe d'application : Compte Google → Sécurité → Validation en deux étapes → Mots de passe des applications.", en: "App password: Google Account → Security → 2-Step Verification → App passwords." },
  icloud: { fr: "Mot de passe pour app : account.apple.com → Connexion et sécurité → Mots de passe pour app.", en: "App-specific password: account.apple.com → Sign-In and Security → App-Specific Passwords." },
  bluewin: { fr: "Le mot de passe e-mail dédié à cette adresse, pas ton Swisscom Login ; identifiant = adresse complète.", en: "The dedicated email password for this address, not your Swisscom Login; username = full address." },
  zoho: { fr: "Mot de passe d'application Zoho (Mon compte → Sécurité → Mots de passe d'application) ; choisis ton centre de données.", en: "Zoho app password (My Account → Security → App passwords); choose your data center." },
};

const LEVELS: Record<Kind, Level[]> = { mail: ["read", "send"], calendar: ["read", "write"], contacts: ["read", "write"], files: ["read", "write"], tasks: ["read", "write"], pages: ["read", "write"] };
const ID_PREFIX: Record<Kind, string> = { mail: "mb", calendar: "ca", contacts: "ct", files: "fl", tasks: "tk", pages: "pg" };
const MAX = 10;
const states = new WeakMap<MockState, MultiState>();

/** CONNECTORS-OAUTH (acfd209), mock : `MOCK_CONNECTORS_OAUTH=1` (avec `MOCK_CONNECTORS_MULTI=1`). Fournisseurs simulés :
 * page de consentement `/v1/dev/oauth/authorize` (cases par service, Autoriser / Refuser), puis le 302 de retour. */
export function connectorsOAuthOn(): boolean {
  return connectorsMultiOn() && process.env.MOCK_CONNECTORS_OAUTH === "1";
}

const OAUTH_PRESETS = {
  kinds: ["mail", "calendar", "contacts", "files", "tasks"],
  oauth: [
    { provider: "microsoft", services: ["mail", "calendar", "contacts", "files", "tasks"], enabled: true },
    { provider: "google", services: ["calendar", "contacts", "tasks"], enabled: true },
    { provider: "google", services: ["files"], enabled: true, separate: true, picker: { developer_key: "mock-picker", app_id: "000000000000" } },
  ],
  contacts: ["carddav", "icloud"],
  tasks: ["icloud"],
  help: {
    contacts: {
      icloud: { fr: "Mot de passe pour app : account.apple.com → Connexion et sécurité → Mots de passe pour app.", en: "App-specific password: account.apple.com → Sign-In and Security → App-Specific Passwords." },
      carddav: { fr: "L'adresse CardDAV de ton carnet, ton identifiant et son mot de passe (ou un mot de passe d'application).", en: "Your address book's CardDAV URL, your username and its password (or an app password)." },
    },
    tasks: { icloud: { fr: "Mot de passe pour app : account.apple.com → Connexion et sécurité → Mots de passe pour app.", en: "App-specific password: account.apple.com → Sign-In and Security → App-Specific Passwords." } },
  },
};

const OAUTH_EMAIL: Record<string, string> = { microsoft: "alex@outlook.example", google: "alex@gmail.example" };
const PICKER_CATALOG = [
  { id: "drv_facture", name: "Facture-2026-10.pdf", mime: "application/pdf" },
  { id: "drv_budget", name: "Budget famille.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { id: "drv_notes", name: "Notes réunion.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
];
const flows = new WeakMap<MockState, Map<string, Flow>>();
const flowsOf = (state: MockState): Map<string, Flow> => {
  let f = flows.get(state);
  if (!f) flows.set(state, (f = new Map()));
  return f;
};

function startFlow(state: MockState, f: Omit<Flow, "expires">): { url: string; expires_at: string } {
  const st = randomId("st");
  const expires = Date.now() + 10 * 60_000;
  flowsOf(state).set(st, { ...f, expires });
  return { url: `/v1/dev/oauth/authorize?state=${encodeURIComponent(st)}`, expires_at: new Date(expires).toISOString() };
}

const SERVICE_FR: Record<string, string> = { mail: "Mail", calendar: "Agenda", contacts: "Contacts", files: "Fichiers", tasks: "Tâches", pages: "Pages" };
const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Routes publiques du faux fournisseur et du callback (sans session : le `state` lie au profil). */
export function handleConnectorsOAuthPublic(state: MockState, method: string, path: string, query: URLSearchParams, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }): boolean {
  if (!connectorsOAuthOn() || method !== "GET") return false;
  const back = (q: Record<string, string>): true => {
    res.writeHead(302, { Location: `/account/connectors?${new URLSearchParams(q).toString()}` });
    res.end();
    return true;
  };
  if (path === "/v1/dev/oauth/authorize") {
    const st = query.get("state") ?? "";
    const f = flowsOf(state).get(st);
    if (!f) return back({ oauth: "error", code: "expired" });
    const boxes = f.services.map((k) => `<label><input type="checkbox" name="granted" value="${k}" checked> ${esc(SERVICE_FR[k] ?? k)}</label><br>`).join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Fournisseur simulé</title><body style="font-family:sans-serif;max-width:28em;margin:3em auto">
<h1 data-fake-provider="${esc(f.provider)}">${esc(f.provider)} (simulé)</h1><p>Nokker demande l'accès à :</p>
<form method="get" action="/v1/connectors/oauth/callback"><input type="hidden" name="state" value="${esc(st)}">${boxes}
<button name="decision" value="allow">Autoriser</button> <button name="decision" value="deny">Refuser</button></form></body>`);
    return true;
  }
  if (path === "/v1/connectors/oauth/callback") {
    const st = query.get("state") ?? "";
    const f = flowsOf(state).get(st);
    flowsOf(state).delete(st);
    if (!f || f.expires < Date.now()) return back({ oauth: "error", code: "expired" });
    if (query.get("decision") !== "allow") return back({ oauth: "error", code: "denied", provider: f.provider });
    const granted = new Set(query.getAll("granted"));
    const ok = f.services.filter((k) => granted.has(k));
    const missing = f.services.filter((k) => !granted.has(k));
    if (!ok.length) return back({ oauth: "error", code: "scope_missing", provider: f.provider });
    const s = multi(state);
    let acct = f.account ? s.oauth.find((a) => a.id === f.account) : undefined;
    if (!acct) {
      acct = { id: newOAuthId(), provider: f.provider, email: f.picker ? OAUTH_EMAIL.google! : OAUTH_EMAIL[f.provider] ?? "alex@example.org", state: "ok", picker: f.picker, picked: [] };
      s.oauth.push(acct);
    }
    acct.state = "ok";
    const now = new Date().toISOString();
    for (const kind of ok) {
      if (s.mine.some((c) => c.oauth === acct!.id && c.kind === kind)) continue;
      const base = kind === "mail" ? acct.email : f.picker ? "Google Drive" : `${f.provider === "google" ? "Google" : "Microsoft"} ${SERVICE_FR[kind]!.toLowerCase()}`;
      let label = (f.label && ok.length === 1 ? f.label : base).slice(0, 40);
      for (let n = 2; s.mine.some((c) => c.kind === kind && c.label.toLowerCase() === label.toLowerCase()); n++) label = `${base} ${n}`.slice(0, 40);
      const settings: Record<string, string> = kind === "mail" ? { auth: "oauth", provider: f.provider, address: acct.email } : { auth: "oauth", provider: f.provider, email: acct.email };
      s.mine.push({ id: newId(kind), kind, label, default: !s.mine.some((c) => c.kind === kind), settings, connected_at: now, last_ok_at: now, grants: [], oauth: acct.id });
    }
    return back({ oauth: "done", provider: f.provider, account: acct.id, ...(missing.length ? { missing: missing.join(",") } : {}) });
  }
  return false;
}

/** Routes d'un compte authentifié : `/v1/connectors/oauth/*` et le sélecteur. */
async function handleOAuthAuthed(state: MockState, method: string, parts: string[], readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const s = multi(state);
  const fail = (status: number, error: string, message = error): true => (send(status, { error, message }), true);
  if (parts[0] === "oauth") {
    if (parts[2] === "start" && method === "POST" && parts.length === 3) {
      const provider = parts[1]!;
      const b = await readBody();
      const services = (Array.isArray(b.services) ? b.services : []).map(String) as Kind[];
      const entries = OAUTH_PRESETS.oauth.filter((o) => o.provider === provider && o.enabled);
      if (!entries.length) return fail(404, "provider_off");
      if (!services.length) return fail(400, "bad_service");
      const entry = entries.find((e) => services.every((k) => e.services.includes(k)));
      if (!entry) return fail(400, "bad_service", provider === "google" && services.includes("files") ? "Google Drive se relie à part" : "service inconnu");
      if (services.some((k) => s.mine.filter((c) => c.kind === k).length >= MAX)) return fail(409, "too_many");
      const account = typeof b.oauth_account === "string" ? b.oauth_account : undefined;
      if (account && !s.oauth.some((a) => a.id === account)) return fail(404, "not_found");
      return send(200, startFlow(state, { provider, services, label: typeof b.label === "string" && b.label.trim() ? b.label.trim() : undefined, account, picker: !!entry.picker })), true;
    }
    if (parts[1] === "accounts" && parts[2]) {
      const acct = s.oauth.find((a) => a.id === parts[2]);
      if (!acct) return fail(404, "not_found");
      if (parts[3] === "reconnect" && method === "POST") {
        const services = [...new Set(s.mine.filter((c) => c.oauth === acct.id).map((c) => c.kind))];
        return send(200, startFlow(state, { provider: acct.provider, services, account: acct.id, picker: acct.picker })), true;
      }
      if (parts.length === 3 && method === "DELETE") {
        s.mine = s.mine.filter((c) => c.oauth !== acct.id);
        for (const kind of Object.keys(LEVELS) as Kind[]) if (!s.mine.some((c) => c.kind === kind && c.default)) { const next = s.mine.find((c) => c.kind === kind); if (next) next.default = true; }
        s.oauth = s.oauth.filter((a) => a.id !== acct.id);
        return send(200, { revoked: true }), true;
      }
    }
    return fail(404, "not_found");
  }
  // Sélecteur Google (Drive) : jeton du grant séparé, fichiers choisis.
  const c = s.mine.find((x) => x.id === parts[0]);
  const acct = c?.oauth ? s.oauth.find((a) => a.id === c.oauth) : undefined;
  if (parts[1] === "picker" || parts[1] === "files") {
    if (!c) return fail(404, "not_found");
    if (!acct?.picker) return fail(400, "unsupported");
    if (parts[1] === "picker" && parts.length === 2 && method === "POST")
      return send(200, { access_token: `mock-drive-file-${randomId("tk")}`, expires_in: 600, developer_key: "mock-picker", app_id: "000000000000", mock_files: PICKER_CATALOG.map(({ id, name }) => ({ id, name })) }), true;
    if (parts[1] === "picker" && parts[2] === "files" && method === "POST") {
      const b = await readBody();
      const now = new Date().toISOString();
      for (const fid of (Array.isArray(b.ids) ? b.ids : []).map(String)) {
        const f = PICKER_CATALOG.find((x) => x.id === fid);
        if (f && !acct.picked.some((x) => x.id === fid)) acct.picked.push({ ...f, picked_at: now });
      }
      return send(200, { files: acct.picked }), true;
    }
    if (parts[1] === "files" && parts.length === 2 && method === "GET") return send(200, { files: acct.picked }), true;
    if (parts[1] === "files" && parts.length === 3 && method === "DELETE") {
      const before = acct.picked.length;
      acct.picked = acct.picked.filter((x) => x.id !== parts[2]);
      return send(200, { removed: acct.picked.length < before }), true;
    }
    return fail(405, "method_not_allowed");
  }
  return false;
}

export function connectorsMultiOn(): boolean {
  return process.env.MOCK_CONNECTORS_MULTI === "1";
}

function ago(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function fresh(): MultiState {
  return {
    mine: [],
    oauth: [],
    shared: [{ id: "mb_c8w2m4p6zt", kind: "mail", label: "famille", address: "camille@example.org", access: "read", owner: { account_id: "ac_camille", name: "camille" }, state: "ok", last_ok_at: ago(30), connected_at: ago(3 * 24 * 60), granted_at: ago(2 * 24 * 60) }],
  };
}

function multi(state: MockState): MultiState {
  let s = states.get(state);
  if (!s) states.set(state, (s = fresh()));
  return s;
}

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // comme store.py _ID_ALPHABET
function newId(kind: Kind): string {
  let r = "";
  for (let i = 0; i < 10; i++) r += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return `${ID_PREFIX[kind]}_${r}`;
}

function newOAuthId(): string {
  let r = "";
  for (let i = 0; i < 10; i++) r += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return `oa_${r}`;
}

// Forme d'un id (nokker/connectors/store.py ID_RE, sur le libellé en minuscules).
const looksLikeId = (l: string): boolean => /^(mb|ca|ct|fl|tk|pg)_[a-z0-9]{10}$/.test(l.toLowerCase());
// Séparateurs des ids qualifiés et des textes du modèle : refusés dans un libellé.
const SEPARATORS = /[/|·]/;
const member = (id: string) => MOCK_MEMBERS.find((m) => m.account_id === id);
const memberName = (id: string): string => member(id)?.name ?? "?";
const memberMinor = (id: string): boolean => member(id)?.minor ?? false;

function card(c: Conn, s?: MultiState): Record<string, unknown> {
  const oa = c.oauth ? s?.oauth.find((a) => a.id === c.oauth) : undefined;
  const auth = connectorsOAuthOn() ? { auth: oa ? "oauth" : "password", ...(oa ? { provider: oa.provider, oauth_account: { id: oa.id, email: oa.email, state: oa.state, connectors: s!.mine.filter((x) => x.oauth === oa.id).length } } : {}) } : {};
  return {
    ...auth,
    id: c.id, kind: c.kind, label: c.label, default: c.default, state: oa?.state === "reconnect" ? "reconnect" : c.last_ok_at ? "ok" : "unverified", settings: c.settings,
    connected_at: c.connected_at, last_ok_at: c.last_ok_at, locality: "cloud", access: "owner",
    // Montée de niveau en attente : l'ancien niveau reste actif (`status: active`), le nouveau attend (`pending_level`).
    grants: c.grants.map((g) =>
      g.status === "pending" && g.previous
        ? { account_id: g.account_id, name: memberName(g.account_id), minor: memberMinor(g.account_id), level: g.previous, status: "active", granted_at: g.granted_at, pending_level: g.level, approval_id: g.approval_id }
        : { account_id: g.account_id, name: memberName(g.account_id), minor: memberMinor(g.account_id), level: g.level, status: g.status, granted_at: g.granted_at, ...(g.status === "pending" ? { approval_id: g.approval_id } : {}) },
    ),
  };
}

function sharedCard(s: Shared): Record<string, unknown> {
  return { id: s.id, kind: s.kind, label: s.label, default: false, state: s.state, ...(s.address ? { settings: { address: s.address } } : {}), last_ok_at: s.last_ok_at, connected_at: s.connected_at, granted_at: s.granted_at, locality: "cloud", access: s.access, owner: s.owner };
}

function listing(state: MockState): Record<string, unknown> {
  const s = multi(state);
  return {
    connectors: [...s.mine.map((c) => card(c, s)), ...s.shared.map(sharedCard)],
    members: MOCK_MEMBERS.map(({ account_id, name, minor }) => ({ account_id, name, minor })),
    presets: {
      mail: MAIL_PRESETS_MULTI, calendar: ["ical", "caldav"], mail_help: MAIL_HELP, mail_regions: { zoho: ["eu", "com"] },
      // Avec OAuth, Outlook n'est plus « bientôt » : il se relie par « Connecter un compte Microsoft ».
      mail_soon: connectorsOAuthOn() ? [] : ["outlook"],
      ...(connectorsOAuthOn() ? OAUTH_PRESETS : {}),
      // `MOCK_CONNECTORS_OAUTH=presets` : couche OAuth montée sans application (prod tant qu'Entra et Google n'existent
      // pas) — fournisseurs listés éteints, features.connectors_oauth faux.
      ...(connectorsMultiOn() && process.env.MOCK_CONNECTORS_OAUTH === "presets" ? { oauth: OAUTH_PRESETS.oauth.filter((o) => !o.picker).map((o) => ({ ...o, enabled: false })), kinds: ["mail", "calendar"] } : {}),
    },
  };
}

function publicSettings(kind: Kind, s: Record<string, unknown>): Record<string, string | number> {
  const keys = kind === "mail" ? ["preset", "address", "region", "imap_host", "smtp_host"] : kind === "calendar" ? ["mode", "label", "url", "username"] : ["mode", "username", "email", "url", "provider"];
  const out: Record<string, string | number> = {};
  for (const k of keys) if (typeof s[k] === "string" || typeof s[k] === "number") out[k] = s[k] as string | number;
  return out;
}

function refuse(kind: Kind, s: Record<string, unknown>, secret: string): [number, string] | null {
  if (!secret) return [400, "bad_settings"];
  if (kind === "mail") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s.address ?? ""))) return [400, "bad_settings"];
    if (s.preset === "outlook") return [400, "unsupported"];
    if (s.preset !== "custom" && !MAIL_PRESETS_MULTI.includes(String(s.preset))) return [400, "bad_settings"];
    if (s.preset === "zoho" && s.region !== undefined && !["eu", "com"].includes(String(s.region))) return [400, "bad_settings"];
  }
  const host = String(s.imap_host ?? (typeof s.url === "string" ? s.url.replace(/^https?:\/\//, "").split("/")[0] : ""));
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(host)) return [400, "host_blocked"];
  if (host.includes("down.example")) return [502, "unreachable"];
  if (secret === "bad" || secret === "mauvais") return [422, "auth_failed"];
  return null;
}

function labelRefusal(s: MultiState, kind: Kind, label: string, self?: string): [number, string] | null {
  if (label.length < 1 || label.length > 40 || looksLikeId(label) || SEPARATORS.test(label)) return [400, "bad_label"];
  if (s.mine.some((c) => c.kind === kind && c.id !== self && c.label.toLowerCase() === label.toLowerCase())) return [409, "label_taken"];
  return null;
}

function defaultLabel(s: MultiState, kind: Kind, settings: Record<string, unknown>): string {
  if (kind === "mail" && typeof settings.address === "string") {
    const a = settings.address.slice(0, 40);
    if (!s.mine.some((c) => c.kind === "mail" && c.label.toLowerCase() === a.toLowerCase())) return a;
  }
  const base = kind === "mail" ? "Mail" : "Agenda";
  for (let n = 1; ; n++) {
    const l = n === 1 ? base : `${base} ${n}`;
    if (!s.mine.some((c) => c.kind === kind && c.label.toLowerCase() === l.toLowerCase())) return l;
  }
}

function grantApproval(state: MockState, c: Conn, g: Grant): Approval {
  const who = memberName(g.account_id);
  const what = g.level === "read" ? "lecture" : g.level === "send" ? "lecture et envoi" : "lecture et écriture";
  const m = member(g.account_id);
  const address = String(c.settings.address ?? "");
  const args = { owner: MOCK_USER, connector_id: c.id, grantee: g.account_id, grantee_email: m?.email ?? "", level: g.level, fingerprint: argsSha256({ connector_id: c.id, address }).slice(0, 16) };
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: [...state.threads.keys()][0] ?? "th_demo",
    turn_index: 0,
    channel: "web",
    tool_name: "connector_grant",
    arguments: args,
    args_sha256: argsSha256(args),
    effect: null,
    rule: "connector:grant",
    // Motif calculé par le noyau (forme de p2/connectors-multi) ; le web l'affiche tel quel sur la carte générique.
    reason: `donner à ${who} (${m?.email ?? ""}${m?.minor ? ", profil mineur" : ""}) l'accès en ${what} à ${c.kind === "mail" ? "ta boîte" : "ton agenda"} « ${c.label} »${address ? ` — ${address}` : ""} ; tu peux le retirer à tout moment`,
    advice: null,
    strength: "strong",
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
  };
  state.approvals.set(approval.id, approval);
  state.approvalEffects.set(approval.id, () => {
    g.status = "active";
    g.granted_at = new Date().toISOString();
    delete g.previous;
    return `Accès ${what} donné à ${who}.`;
  });
  state.publish({ type: "approval.requested", approval });
  approvalBubble(state, approval);
  return approval;
}

export async function handleConnectorsMulti(state: MockState, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (path === "/v1/dev/connectors-mock" && method === "POST") {
    const b = await readBody();
    if (b.reset) states.set(state, fresh());
    const s = multi(state);
    // Jeton révoqué chez le fournisseur : le compte et ses connecteurs passent en « reconnect ».
    if (typeof b.oauth_reconnect === "string") for (const a of s.oauth) if (b.oauth_reconnect === "all" || a.id === b.oauth_reconnect) a.state = "reconnect";
    if (b.approve) {
      for (const c of s.mine) for (const g of c.grants) {
        if (g.status !== "pending" || !g.approval_id || (b.approve !== "all" && b.approve !== g.approval_id)) continue;
        const a = state.approvals.get(g.approval_id);
        const effect = state.approvalEffects.get(g.approval_id);
        if (a && effect) {
          state.approvalEffects.delete(g.approval_id);
          a.status = "executed";
          a.decided_by = MOCK_USER;
          a.decided_via = "webauthn";
          a.decided_at = new Date().toISOString();
          a.result_summary = String(effect());
          state.publish({ type: "approval.decided", approval_id: a.id, decision: "approved", by: MOCK_USER, via: "webauthn" });
        }
      }
    }
    return send(200, listing(state)), true;
  }
  if (!connectorsMultiOn() || (path !== "/v1/connectors" && !path.startsWith("/v1/connectors/"))) return false;
  const parts = path.slice("/v1/connectors".length).split("/").filter(Boolean);
  // Anciennes routes par nature : onboarding.ts.
  if (parts[0] === "mail" || parts[0] === "calendar") return false;
  if (connectorsOAuthOn() && (await handleOAuthAuthed(state, method, parts, readBody, send))) return true;
  const s = multi(state);
  const fail = (status: number, error: string): true => (send(status, { error, message: error }), true);

  if (parts.length === 0 && method === "GET") return send(200, listing(state)), true;

  if (parts.length === 0 && method === "POST") {
    const b = await readBody();
    const kind = b.kind === "mail" || b.kind === "calendar" || (connectorsOAuthOn() && (b.kind === "contacts" || b.kind === "tasks")) ? (b.kind as Kind) : null;
    if (!kind) return fail(400, "bad_settings");
    // Contacts (CardDAV, iCloud) et tâches (iCloud Rappels) sans OAuth : mode connu, identifiant, URL pour CardDAV.
    if (kind === "contacts" || kind === "tasks") {
      const st = (b.settings ?? {}) as Record<string, unknown>;
      const modes = kind === "contacts" ? ["carddav", "icloud"] : ["icloud"];
      if (!modes.includes(String(st.mode)) || !String(st.username ?? "").trim() || (st.mode === "carddav" && !/^https:\/\//.test(String(st.url ?? "")))) return fail(400, "bad_settings");
    }
    const settings = (b.settings && typeof b.settings === "object" ? b.settings : null) as Record<string, unknown> | null;
    if (!settings) return fail(400, "bad_settings");
    if (s.mine.filter((c) => c.kind === kind).length >= MAX) return fail(409, "too_many");
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : defaultLabel(s, kind, settings);
    const bad = labelRefusal(s, kind, label);
    if (bad) return fail(bad[0], bad[1]);
    const no = refuse(kind, settings, String(b.secret ?? "").trim());
    if (no) return fail(no[0], no[1]);
    const now = new Date().toISOString();
    const c: Conn = { id: newId(kind), kind, label, default: !s.mine.some((x) => x.kind === kind), settings: publicSettings(kind, settings), connected_at: now, last_ok_at: now, grants: [] };
    s.mine.push(c);
    return send(201, card(c, s)), true;
  }

  const id = parts[0]!;
  const mine = s.mine.find((c) => c.id === id);
  const shared = s.shared.find((c) => c.id === id);
  if (!mine && !shared) return fail(404, "not_found");

  if (parts.length === 3 && parts[1] === "grants" && method === "DELETE") {
    const who = parts[2]!;
    if (shared) {
      if (who !== "me") return fail(403, "not_owner");
      s.shared = s.shared.filter((x) => x.id !== id);
      return send(200, { revoked: true }), true;
    }
    const before = mine!.grants.length;
    mine!.grants = mine!.grants.filter((g) => g.account_id !== who);
    return send(200, { revoked: mine!.grants.length < before }), true;
  }
  if (shared && !(parts.length === 2 && parts[1] === "test")) return fail(403, "not_owner");

  if (parts.length === 1 && method === "PATCH") {
    const b = await readBody();
    if (typeof b.label === "string") {
      const l = b.label.trim();
      const bad = labelRefusal(s, mine!.kind, l, mine!.id);
      if (bad) return fail(bad[0], bad[1]);
      mine!.label = l;
    }
    if (b.default === true) for (const c of s.mine) if (c.kind === mine!.kind) c.default = c.id === mine!.id;
    return send(200, card(mine!, s)), true;
  }
  if (parts.length === 2 && parts[1] === "test" && method === "POST") {
    if (shared) return fail(403, "not_owner");
    mine!.last_ok_at = new Date().toISOString();
    return send(200, { ok: true, message: "ok", code: null }), true;
  }
  if (parts.length === 1 && method === "DELETE") {
    s.mine = s.mine.filter((c) => c.id !== id);
    // Dernier service d'un compte OAuth : le compte et son jeton tombent avec lui.
    if (mine!.oauth && !s.mine.some((c) => c.oauth === mine!.oauth)) s.oauth = s.oauth.filter((a) => a.id !== mine!.oauth);
    if (mine!.default) {
      const next = s.mine.find((c) => c.kind === mine!.kind);
      if (next) next.default = true;
    }
    return send(200, { revoked: true }), true;
  }
  if (parts.length === 2 && parts[1] === "grants" && method === "POST") {
    const b = await readBody();
    const accountId = String(b.account_id ?? "");
    const level = String(b.level ?? "") as Level;
    if (!LEVELS[mine!.kind].includes(level)) return fail(400, "bad_level");
    if (!MOCK_MEMBERS.some((m) => m.account_id === accountId)) return fail(403, "not_household_member");
    const g = mine!.grants.find((x) => x.account_id === accountId);
    const rank = (l: Level): number => LEVELS[mine!.kind].indexOf(l);
    // Même logique que Connectors.grant (67cd2a6) : `level` de la ligne = accès actif (absent tant que rien n'est
    // accordé), la demande en attente à part ; une demande remplacée retire sa carte.
    const active = g ? (g.status === "active" ? g.level : g.previous) : undefined;
    const pendingLevel = g && g.status === "pending" ? g.level : undefined;
    const cancel = (): void => {
      if (g?.approval_id) {
        state.approvalEffects.delete(g.approval_id);
        const a = state.approvals.get(g.approval_id);
        if (a && a.status === "pending") a.status = "expired";
      }
    };
    if (g && pendingLevel === level && g.approval_id && state.approvals.get(g.approval_id)?.status === "pending")
      return send(200, { status: "pending", approval_id: g.approval_id }), true;
    if (g && active === level) {
      if (pendingLevel) {
        cancel();
        Object.assign(g, { level, status: "active", approval_id: null });
        delete g.previous;
      }
      return send(200, { status: "unchanged" }), true;
    }
    if (g && active && rank(level) < rank(active)) {
      cancel();
      Object.assign(g, { level, status: "active", approval_id: null });
      delete g.previous;
      return send(200, { status: "updated" }), true;
    }
    if (g) cancel();
    const grant: Grant = g ?? { account_id: accountId, level, status: "pending", granted_at: null, approval_id: null };
    if (g) {
      if (active) g.previous = active;
      else delete g.previous;
      g.level = level;
      g.status = "pending";
    } else mine!.grants.push(grant);
    grant.approval_id = grantApproval(state, mine!, grant).id;
    return send(202, { status: "pending", approval_id: grant.approval_id }), true;
  }
  return fail(405, "method_not_allowed");
}
