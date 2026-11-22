/**
 * Sites connectés — faux noyau Lokkal des routes `/v1/local/sites*` (nokker docs/CONNECTED-SITES.md §15, branche
 * p2/connected-sites bb936b3 + df8d8bc, `nokker/sites/http.py`) : mêmes routes, mêmes formes, mêmes codes d'erreur, même
 * saisie scellée (clé de machine éphémère P-256 par demande, HKDF « nokker-sites-v1|<rid> », AES-GCM, AAD = rid).
 * Drapeau `MOCK_SITES=1` (sinon 404, comme un noyau sans ces routes) ; `MOCK_SITES=all` ajoute au catalogue trois sites
 * à venir (aperçu de la grille seulement : le noyau n'en a pas encore la recette).
 *
 * Le site simulé réagit selon l'identifiant saisi (après le mot de passe) :
 *   …code…  → code demandé (123456 = bon code ; un faux : nouvelle demande `wrong_code`, deux faux : `code_rejected`) ;
 *   …phone… → validation dans l'appli ;
 *   …mail…  → lien reçu par e-mail, récupéré tout seul ; …paste… → lien à coller ; …robot… → vérification (CAPTCHA) ;
 *   …wrong… ou mot de passe « wrong » → identifiant refusé (`suspended`) ; sinon → connecté.
 * Mock seulement : POST /v1/dev/sites-mock {chat?: {site, username}, expire?: id, pause?: id, release?: id,
 * timeout?: id, off?: bool, minor?: bool, no_machine?: bool, reset?: true} ; GET /v1/dev/sites-screen/{id} (écran
 * simulé du navigateur du site, ouvert par la passerelle : « J'ai fini » libère la page).
 */
import { randomBytes, webcrypto } from "node:crypto";
import type { SiteCard, SiteRequestKind, SiteState } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

type Send = (status: number, obj: unknown) => void;
type Jwk = { kty: string; crv: string; x: string; y: string };
const subtle = webcrypto.subtle;
const stepMs = (): number => Number(process.env.MOCK_SITES_STEP_MS ?? 700);
export const CONSENT_VERSION = "2026-11-05";
const TTL_S: Record<SiteRequestKind, number> = { password: 600, link: 600, code: 180, app_approval: 180 };

const READ = { list: ["notifications", "messages"], search: ["people", "posts"] };
const CATALOG = [{ site: "linkedin", name: "LinkedIn", recipe: true, gestures: READ }];
const LATER = [
  { site: "instagram", name: "Instagram", recipe: true, gestures: READ },
  { site: "facebook", name: "Facebook", recipe: true, gestures: READ },
  { site: "x", name: "X", recipe: true, gestures: READ },
];
const catalog = () => (process.env.MOCK_SITES === "all" ? [...CATALOG, ...LATER] : CATALOG);
export const sitesOn = (): boolean => process.env.MOCK_SITES === "1" || process.env.MOCK_SITES === "all";

const STATE_TEXT: Record<SiteState, string> = {
  absent: "Pas encore connecté",
  connecting: "Connexion…",
  needs_password: "Mot de passe demandé sur Telegram",
  needs_link: "Lien de connexion envoyé par e-mail : récupération dans la boîte reliée…",
  needs_code: "Code de vérification demandé sur Telegram",
  needs_app_approval: "Valide sur ton téléphone, puis Fait",
  needs_you: "Vérification à faire sur l'écran du navigateur",
  needs_consent: "Conditions d'utilisation du site à accepter",
  connected: "Connecté ✓",
  expired: "Connexion expirée : reconnexion…",
  paused: "En pause jusqu'au {until} ({signal})",
  suspended: "Identifiant refusé : à remplacer",
  disconnected: "Déconnecté",
  failed: "Connexion abandonnée : {signal}",
};

const SIGNAL_TEXT: Record<string, string> = {
  "": "raison non précisée", password_timeout: "mot de passe non donné à temps", code_timeout: "code non donné à temps",
  code_rejected: "code refusé deux fois par le site", wrong_code: "code refusé par le site, nouvelle demande",
  approval_timeout: "validation non faite à temps", link_timeout: "lien non donné à temps", link_other_site: "lien reçu pour un autre site",
  handoff_timeout: "vérification non faite à temps", captcha: "vérification de sécurité du site", unknown_screen: "écran du site non reconnu",
  unusual_activity: "activité inhabituelle signalée par le site", bad_credentials: "identifiant refusé par le site",
  too_many_logins: "trop de reconnexions", too_many_steps: "trop d'étapes", login_page_changed: "page de connexion non reconnue",
  cancelled: "annulée à la demande", browser_missing: "navigateur des sites absent", busy: "déjà en cours d'utilisation", internal: "erreur interne",
};
const LIVE: ReadonlySet<SiteState> = new Set(["connecting", "needs_password", "needs_link", "needs_code", "needs_app_approval", "needs_you"]);
const OFF_MESSAGE = "Les sites connectés ne sont pas activés sur cette machine (réglage local.sites).";

interface Conn {
  id: string;
  site: string;
  site_name: string;
  label: string;
  username: string;
  default: boolean;
  state: SiteState;
  signal: string;
  paused_until: number | null;
  account_name: string;
  last_ok_at: number | null;
  last_auto_login_at: number | null;
  password: boolean;
  used: boolean;
  wrongCodes: number;
  handoff: string | null;
}
interface Req {
  id: string;
  connector: string;
  kind: SiteRequestKind;
  label: string;
  expires_at: number;
  machine_key: Jwk | null;
  priv: webcrypto.CryptoKey | null;
  answered: boolean;
}
interface SitesState {
  conns: Conn[];
  consents: Set<string>;
  reqs: Map<string, Req>;
  off: boolean;
  minor: boolean;
  noMachine: boolean;
  handoffs: Map<string, { conn: string; until: number; used: boolean }>;
  timers: NodeJS.Timeout[];
}
const states = new WeakMap<MockState, SitesState>();
const fresh = (): SitesState => ({ conns: [], consents: new Set(), reqs: new Map(), off: false, minor: false, noMachine: false, handoffs: new Map(), timers: [] });
function st(state: MockState): SitesState {
  let s = states.get(state);
  if (!s) states.set(state, (s = fresh()));
  return s;
}

const ALPHA = "abcdefghijkmnpqrstuvwxyz23456789";
const rnd = (n: number): string => Array.from(randomBytes(n), (x) => ALPHA[x % ALPHA.length]).join("");
const now = (): number => Date.now() / 1000;
const QUOTAS: Record<string, [number, number]> = {
  pages: [12, 150], searches: [1, 25], profiles: [3, 40], messages: [0, 20], comments: [0, 12], invitations: [0, 10],
  reactions: [0, 40], follows: [0, 10], posts: [0, 2], logins: [0, 2],
};

function openReq(s: SitesState, c: Conn): Req | undefined {
  return [...s.reqs.values()].find((r) => r.connector === c.id && !r.answered && now() <= r.expires_at);
}

function card(s: SitesState, c: Conn): SiteCard {
  const until = c.paused_until ? new Date(c.paused_until * 1000) : null;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const untilText = until ? `${p2(until.getDate())}.${p2(until.getMonth() + 1)} ${p2(until.getHours())}:${p2(until.getMinutes())}` : "";
  const r = openReq(s, c);
  return {
    id: c.id, site: c.site, site_name: c.site_name, label: c.label, default: c.default, username: c.username,
    account_name: c.account_name, state: c.state, signal: c.signal as SiteCard["signal"],
    state_text: STATE_TEXT[c.state].replace("{until}", untilText).replace("{signal}", SIGNAL_TEXT[c.signal] ?? "raison non précisée"),
    paused_until: c.paused_until, last_ok_at: c.last_ok_at, last_auto_login_at: c.last_auto_login_at, access: "owner",
    quotas: Object.fromEntries(Object.entries(QUOTAS).map(([k, [u, m]]) => [k, { used: c.used ? u : 0, max: m }])),
    credentials: { stored: c.password, updated_at: c.password ? c.last_ok_at : null },
    grants: [],
    ...(r ? { request: { id: r.id, kind: r.kind, expires_at: r.expires_at } } : {}),
    ...(c.state === "needs_you" && c.handoff && !s.handoffs.get(c.handoff)?.used ? { handoff_url: `/sites/h/${c.handoff}` } : {}),
  };
}

/** Vérification humaine : un lien de passation à usage unique (15 min) vers l'écran du navigateur du site. */
function needsYou(s: SitesState, c: Conn, signal = "captcha"): void {
  c.state = "needs_you";
  c.signal = signal;
  c.handoff = rnd(24);
  s.handoffs.set(c.handoff, { conn: c.id, until: now() + 900, used: false });
}

async function ask(s: SitesState, c: Conn, kind: SiteRequestKind, state: SiteState): Promise<Req> {
  for (const r of s.reqs.values()) if (r.connector === c.id && !r.answered) r.answered = true; // une seule ouverte
  let machine_key: Jwk | null = null;
  let priv: webcrypto.CryptoKey | null = null;
  if (kind !== "app_approval") {
    const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
    const j = (await subtle.exportKey("jwk", pair.publicKey)) as Jwk;
    machine_key = { kty: "EC", crv: "P-256", x: j.x, y: j.y };
    priv = pair.privateKey;
  }
  const r: Req = { id: "rq_" + rnd(12), connector: c.id, kind, label: c.label, expires_at: now() + TTL_S[kind], machine_key, priv, answered: false };
  s.reqs.set(r.id, r);
  c.state = state;
  return r;
}

/** Ouvre une saisie scellée pour la demande `r` ; null si le scellé est faux. */
async function unseal(r: Req, sealed: unknown): Promise<string | null> {
  const x = sealed as { v?: number; epk?: Jwk; iv?: string; ct?: string } | undefined;
  if (!r.priv || !x || x.v !== 1 || !x.epk || !x.iv || !x.ct) return null;
  try {
    const enc = new TextEncoder();
    const epk = await subtle.importKey("jwk", { ...x.epk, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await subtle.deriveBits({ name: "ECDH", public: epk }, r.priv, 256);
    const hk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("nokker-sites-v1|" + r.id) }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(x.iv, "base64url"), additionalData: enc.encode(r.id) }, key, Buffer.from(x.ct, "base64url"));
    const v = (JSON.parse(new TextDecoder().decode(pt)) as { value?: unknown }).value;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const later = (s: SitesState, fn: () => void | Promise<void>): void => void s.timers.push(setTimeout(() => void fn(), stepMs()));

function connected(c: Conn): void {
  c.state = "connected";
  c.signal = "";
  c.wrongCodes = 0;
  c.handoff = null;
  c.account_name = "Alex Martin";
  c.last_ok_at = now();
  c.used = true;
}

/** La suite après le mot de passe, selon l'identifiant (voir l'en-tête). */
function afterPassword(s: SitesState, c: Conn, password: string): void {
  c.state = "connecting";
  later(s, async () => {
    const u = c.username;
    if (/wrong/i.test(u) || password === "wrong") {
      c.state = "suspended";
      c.signal = "bad_credentials";
      c.password = false;
    } else if (/code/i.test(u)) await ask(s, c, "code", "needs_code");
    else if (/phone/i.test(u)) await ask(s, c, "app_approval", "needs_app_approval");
    else if (/paste/i.test(u)) await ask(s, c, "link", "needs_link");
    else if (/mail/i.test(u)) {
      c.state = "needs_link";
      later(s, () => connected(c));
    } else if (/robot/i.test(u)) needsYou(s, c);
    else connected(c);
  });
}

function startFlow(s: SitesState, c: Conn): string {
  if (!s.consents.has(c.site)) {
    c.state = "needs_consent";
    return c.state;
  }
  c.state = "connecting";
  c.signal = "";
  later(s, async () => {
    if (c.state !== "connecting") return; // annulée entre-temps
    if (c.password) afterPassword(s, c, "stored");
    else await ask(s, c, "password", "needs_password");
  });
  return c.state;
}

function labelFor(s: SitesState, name: string, wanted: unknown): string | null {
  if (typeof wanted === "string" && wanted.trim()) {
    const l = wanted.split(/\s+/).filter(Boolean).join(" ");
    return l.length > 40 || /[/|·]/.test(l) || /^st_[a-z0-9]{10}$/.test(l) ? null : l;
  }
  if (!s.conns.some((x) => x.label.toLowerCase() === name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!s.conns.some((x) => x.label.toLowerCase() === `${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

function newConn(s: SitesState, site: { site: string; name: string }, username: string, label: string): Conn {
  const c: Conn = {
    id: "st_" + rnd(10), site: site.site, site_name: site.name, label, username, default: !s.conns.some((x) => x.site === site.site),
    state: "absent", signal: "", paused_until: null, account_name: "", last_ok_at: null, last_auto_login_at: null, password: false, used: false,
    wrongCodes: 0, handoff: null,
  };
  s.conns.push(c);
  return c;
}

const findSite = (t: unknown) => {
  const x = String(t ?? "").trim().toLowerCase();
  return catalog().find((c) => c.site === x || c.name.toLowerCase() === x || (x.startsWith("https://") && new URL(x).hostname.replace(/^www\./, "") === `${c.site}.com`));
};

export async function handleSites(state: MockState, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const s = st(state);
  const err = (status: number, code: string, message = code): true => (send(status, { error: { code, message } }), true);
  if (path === "/v1/dev/sites-mock" && method === "POST") {
    const b = await readBody();
    if (b.reset) {
      for (const t of s.timers) clearTimeout(t);
      states.set(state, fresh());
    }
    const t = st(state);
    if (typeof b.off === "boolean") t.off = b.off;
    if (typeof b.minor === "boolean") t.minor = b.minor;
    if (typeof b.no_machine === "boolean") t.noMachine = b.no_machine;
    const chat = b.chat as { site?: string; username?: string } | undefined;
    const site = chat ? findSite(chat.site) : undefined;
    if (site) startFlow(t, newConn(t, site, chat?.username ?? "alex@example.org", labelFor(t, site.name, undefined)!));
    const byId = (id: unknown) => t.conns.find((x) => x.id === id);
    const ex = byId(b.expire);
    if (ex) {
      ex.state = "expired";
      later(t, () => {
        ex.last_auto_login_at = now();
        connected(ex);
      });
    }
    const pa = byId(b.pause);
    if (pa) {
      pa.state = "paused";
      pa.signal = "unusual_activity";
      pa.paused_until = Math.round(now() + 24 * 3600);
    }
    const re = byId(b.release);
    if (re?.state === "needs_you") later(t, () => connected(re));
    const to = byId(b.timeout);
    if (to) {
      const open = openReq(t, to);
      for (const r of t.reqs.values()) if (r.connector === to.id) r.answered = true;
      to.state = "failed";
      to.signal = open ? `${open.kind === "app_approval" ? "approval" : open.kind}_timeout` : "handoff_timeout";
    }
    return send(200, { sites: t.conns.map((c) => card(t, c)) }), true;
  }
  const p = path.split("?")[0]!.replace(/\/+$/, "");
  if (p !== "/v1/local/sites" && !p.startsWith("/v1/local/sites/")) return false;
  if (!sitesOn()) return err(404, "not_found");
  if (s.minor) return err(403, "minor", "les sites connectés ne sont pas proposés à un profil mineur");
  const isList = p === "/v1/local/sites" && method === "GET";
  if (s.off || s.noMachine) {
    const off = s.noMachine ? { enabled: false, reason: "no_machine", message: "Aucune machine liée à ce compte." } : { enabled: false, reason: "disabled", message: OFF_MESSAGE };
    return send(isList ? 200 : 409, isList ? off : { ...off, error: { code: off.reason, message: off.message } }), true;
  }
  const rest = p.slice("/v1/local/sites".length).split("/").filter(Boolean);

  if (isList) return send(200, { enabled: true, sites: s.conns.map((c) => card(s, c)), catalog: catalog(), consent_version: CONSENT_VERSION, consents: [...s.consents] }), true;
  if (rest.length === 0 && method === "POST") {
    const b = await readBody();
    if ("password" in b || "code" in b) return err(400, "no_plain_secret", "un mot de passe ne s'envoie jamais en clair : saisie scellée seulement");
    const site = findSite(b.site ?? b.url);
    if (!site) return err(400, "unsupported", "site sans recette (« Autre site » : lot suivant)");
    if (!s.consents.has(site.site)) return err(409, "consent_required", "avertissement sur les conditions du site à accepter d'abord");
    const username = String(b.username ?? "").trim();
    if (!username) return err(400, "username_required");
    if (s.conns.length >= 10) return err(409, "too_many");
    const label = labelFor(s, site.name, b.label);
    if (label === null) return err(400, "bad_label");
    if (s.conns.some((x) => x.label.toLowerCase() === label.toLowerCase())) return err(409, "label_taken");
    const c = newConn(s, site, username, label);
    const flow = startFlow(s, c);
    return send(201, { ...card(s, c), flow }), true;
  }
  if (rest[0] === "consent" && method === "POST") {
    const b = await readBody();
    const site = findSite(b.site);
    if (!site || b.version !== CONSENT_VERSION) return err(400, "bad_consent", "site ou version de l'avertissement inconnus");
    s.consents.add(site.site);
    return send(204, null), true;
  }
  if (rest[0] === "handoff" && rest[1] && rest.length === 2 && method === "POST") {
    const h = s.handoffs.get(rest[1]);
    const c = h && s.conns.find((x) => x.id === h.conn);
    if (!h || !c || h.used || now() > h.until || c.state !== "needs_you") return err(410, "handoff_gone", "lien de passation déjà utilisé, expiré ou pas à toi");
    h.used = true;
    return send(200, { screen_url: `/v1/dev/sites-screen/${c.id}` }), true;
  }
  if (rest[0] === "requests" && rest[1]) {
    const r = s.reqs.get(rest[1]);
    if (!r) return err(404, "not_found", "demande inconnue");
    if (method === "GET" && rest.length === 2) return send(200, { id: r.id, kind: r.kind, label: r.label, expires_at: r.expires_at, machine_key: r.machine_key }), true;
    if (method === "POST" && rest[2] === "answer") {
      const b = await readBody();
      if ("value" in b) return err(400, "no_plain_secret", "saisie scellée seulement");
      if (r.answered) return err(409, "answered");
      if (now() > r.expires_at) return err(410, "expired");
      const c = s.conns.find((x) => x.id === r.connector)!;
      if (r.kind === "app_approval") {
        if (b.done !== true) return err(400, "bad_answer", "cette demande attend « Fait »");
        r.answered = true;
        c.state = "connecting";
        later(s, () => connected(c));
        return send(204, null), true;
      }
      const v = await unseal(r, b.sealed);
      if (v === null) return err(400, "bad_sealed");
      r.answered = true;
      if (r.kind === "password") {
        c.password = true;
        afterPassword(s, c, v);
      } else if (r.kind === "code") {
        c.state = "connecting";
        later(s, async () => {
          if (v === "123456") return connected(c);
          c.wrongCodes++;
          if (c.wrongCodes >= 2) {
            c.state = "failed";
            c.signal = "code_rejected";
            return;
          }
          await ask(s, c, "code", "needs_code");
          c.signal = "wrong_code";
        });
      } else {
        c.state = "connecting";
        later(s, () => connected(c));
      }
      return send(204, null), true;
    }
    return false;
  }
  const c = s.conns.find((x) => x.id === rest[0]);
  if (!c) return err(404, "not_found", "site inconnu");
  const sub = rest[1] ?? "";
  if (!sub && method === "GET") return send(200, card(s, c)), true;
  if (!sub && method === "PATCH") {
    const b = await readBody();
    if ("label" in b) {
      const l = labelFor(s, c.site_name, b.label);
      if (l === null || !String(b.label ?? "").trim()) return err(400, "bad_label");
      if (s.conns.some((x) => x.id !== c.id && x.label.toLowerCase() === l.toLowerCase())) return err(409, "label_taken");
      c.label = l;
    }
    if (b.default === true) for (const x of s.conns) if (x.site === c.site) x.default = x.id === c.id;
    return send(200, card(s, c)), true;
  }
  if (!sub && method === "DELETE") {
    s.conns = s.conns.filter((x) => x.id !== c.id);
    if (c.default) {
      const next = s.conns.find((x) => x.site === c.site);
      if (next) next.default = true;
    }
    return send(200, { deleted: true }), true;
  }
  if (sub === "connect" && method === "POST") return send(202, { status: startFlow(s, c) }), true;
  if (sub === "cancel" && method === "POST") {
    if (!LIVE.has(c.state)) return err(409, "not_connecting", "aucune connexion en cours");
    for (const r of s.reqs.values()) if (r.connector === c.id) r.answered = true;
    c.state = "failed";
    c.signal = "cancelled";
    c.handoff = null;
    return send(202, { status: "cancelling" }), true;
  }
  if (sub === "pause" && method === "DELETE") {
    c.paused_until = null;
    connected(c);
    return send(200, card(s, c)), true;
  }
  if (sub === "credentials" && method === "POST") {
    c.password = false;
    const r = await ask(s, c, "password", "needs_password");
    return send(201, { request: { id: r.id, kind: r.kind, label: r.label, expires_at: r.expires_at, machine_key: r.machine_key } }), true;
  }
  if (sub === "credentials" && method === "DELETE") {
    c.password = false;
    return send(204, null), true;
  }
  return false;
}

/** Écran simulé du navigateur du site (ce que la passerelle ouvrirait) : « J'ai fini » libère la page. */
export function handleSitesScreen(state: MockState, method: string, path: string, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }): boolean {
  const m = /^\/v1\/dev\/sites-screen\/(st_[a-z2-9]{10})(\/done)?$/.exec(path);
  if (!m || !sitesOn()) return false;
  const s = st(state);
  const c = s.conns.find((x) => x.id === m[1]);
  const html = (body: string) => (res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }), res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;max-width:26em;margin:2em auto;padding:0 16px">${body}</body>`), true);
  if (!c || c.state !== "needs_you") return html(`<p data-screen-gone>Rien à faire ici.</p>`);
  if (m[2] && method === "POST") {
    c.state = "connecting";
    later(s, () => connected(c));
    return html(`<p data-screen-done>Merci : Nokker reprend la connexion. Tu peux revenir à l'app.</p>`);
  }
  return html(`<h1 data-screen="${c.id}">${c.site_name} — vérification (simulée)</h1><p>Coche « Je ne suis pas un robot », puis :</p><form method="post" action="/v1/dev/sites-screen/${c.id}/done"><button>J'ai fini</button></form>`);
}
