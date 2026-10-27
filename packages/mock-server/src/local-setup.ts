/**
 * Lokkal en démo : `/v1/local/*`, calqué sur le noyau réel (`nokker/local/{api,setup}.py` de `p2/lokkal`, docs/LOKKAL.md
 * §7.1 et §7.2) et le réglage de la démo `POST /v1/dev/local-mock` (mock seulement) :
 * `{ollama: bool, linked: bool, approve_after: nombre de sondages, link_outcome: "approved"|"denied"|"expired",
 * link_service: "up"|"down", vault: "ok"|"missing"}` (`down` : 502 « service de lien nokker.ai indisponible » sur
 * link/start et link/status, comme avant que nokker.ai serve /v1/link/* ; `missing` : 503 quand le coffre n'a pas sa clé).
 * Erreurs au format de la bêta, `{error:{message}}`, sans code.
 *
 * Les routes `/v1/local/*` exigent le jeton local en `Authorization: Bearer` (`LOCAL_TOKEN` ici) et un `Host`
 * 127.0.0.1:<port> ou localhost:<port>, même en loopback (§7.1 : CSRF, DNS rebinding) : 401 / 403 sinon. Le navigateur reçoit
 * le jeton dans le fragment de l'URL d'ouverture : `/setup#token=<jeton>`.
 *
 * Les clés « ma propre clé » vont dans `vault` (le coffre local) et n'en sortent jamais : ni réponse, ni journal.
 */
import { randomBytes } from "node:crypto";
import { pagesPublicAllowed } from "./pages.js";
import type { LocalLinkStart, LocalModelTestResult, LocalSetup } from "@nokker-apps/sdk";
import { cardOf, KINDS } from "./onboarding.js";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

/** Jeton local de démo : le mock le tient aussi pour une session (connecteurs, Telegram). */
export const LOCAL_TOKEN = "local-dev-token";
export const OLLAMA_URL = "http://host.docker.internal:11434";
export const LINK_URI = "https://app.nokker.ai/link";
const LINK_ACCOUNT = "camille@example.com";
const LINK_DOWN = "service de lien nokker.ai indisponible";

export interface LocalMock {
  /** Un Ollama répond sur host.docker.internal:11434. */
  ollama: boolean;
  /** Réglage de démo : le lien Router est déjà fait au départ. */
  linkedAtStart: boolean;
  /** Nombre de sondages de `link/status` avant que le flux passe à l'état final. */
  approveAfter: number;
  /** État final du flux d'appareil. */
  linkOutcome: "approved" | "denied" | "expired";
  /** `down` : nokker.ai ne sert pas encore /v1/link/* (502 sur link/start et link/status). */
  linkService: "up" | "down";
  /** `missing` : le coffre n'a pas NOKKER_LOCAL_SECRET_KEY (503 sur PUT models et à l'approbation du lien). */
  vaultKey: "ok" | "missing";
  // -- état du réglage --
  account: string | null;
  done: boolean;
  default: string | null;
  byok: Array<{ name: string; base_url: string; model: string | null; ok: boolean | null }>;
  /** Coffre local : `router` ou `byok:<nom>` → clé. Jamais sérialisé. */
  vault: Map<string, string>;
  link: { code: string; expiresAt: number; polls: number } | null;
  telegram: "absent" | "pending" | "linked";
}

const mocks = new WeakMap<MockState, LocalMock>();

type Knobs = Pick<LocalMock, "ollama" | "linkedAtStart" | "approveAfter" | "linkOutcome" | "linkService" | "vaultKey">;

function fresh(prev?: Knobs): LocalMock {
  const base: Knobs = prev ?? { ollama: true, linkedAtStart: false, approveAfter: 3, linkOutcome: "approved", linkService: "up", vaultKey: "ok" };
  return {
    ...base,
    account: base.linkedAtStart ? LINK_ACCOUNT : null,
    done: false,
    default: null,
    byok: [],
    vault: new Map(base.linkedAtStart ? [["router", "router-key"]] : []),
    link: null,
    telegram: "absent",
  };
}

export function localMock(state: MockState): LocalMock {
  let m = mocks.get(state);
  if (!m) {
    m = fresh();
    mocks.set(state, m);
  }
  return m;
}

/** Hôte non vide d'une URL https:// (« https:///v1 » n'en a pas, alors que `new URL` y lirait l'hôte « v1 »), sinon null. */
export function httpsHost(baseUrl: string): string | null {
  const m = /^https:\/\/([^/?#\s]+)/.exec(baseUrl);
  if (!m) return null;
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
}

const CATALOG = ["large-model", "fast-model"];
const OLLAMA_MODELS = ["llama3.1:8b", "qwen2.5:7b"];

const HTTP_URL = /^https?:\/\/([^/?#\s]+)/;

/** Comme `test_endpoint` du noyau : texte d'erreur libre (nom d'exception httpx, `HTTP 401`, `base_url http(s) requise`), latence nulle sans réponse. */
function testModel(baseUrl: string, apiKey: string): LocalModelTestResult {
  const host = HTTP_URL.exec(baseUrl)?.[1];
  if (!host) return { ok: false, models: [], latency_ms: null, error: "base_url http(s) requise" };
  if (/\.invalid(:\d+)?$/.test(host)) return { ok: false, models: [], latency_ms: null, error: "ConnectError" };
  if (apiKey.startsWith("bad")) return { ok: false, models: [], latency_ms: 86, error: "HTTP 401" };
  return { ok: true, models: CATALOG, latency_ms: 112 };
}

const ROUTER_MODEL = "qwen/qwen3.5-397b-a17b";

function setupView(state: MockState, m: LocalMock): LocalSetup {
  return {
    done: m.done,
    models: {
      router: { linked: m.vault.has("router"), account: m.account, model: ROUTER_MODEL },
      byok: m.byok.map((b) => ({ name: b.name, base_url: b.base_url, model: b.model, ok: b.ok, has_key: m.vault.has(`byok:${b.name}`) })),
      local: m.ollama ? [{ runtime: "ollama", url: OLLAMA_URL, models: OLLAMA_MODELS }] : [],
    },
    default: m.default,
    // Le noyau rend toujours [] ici : les connecteurs passent par leurs propres routes.
    connectors: [],
    channels: [{ kind: "telegram", state: m.telegram }],
  };
}

function bad(send: Send, status: number, message: string): true {
  send(status, { error: { message } });
  return true;
}

const VAULT_MISSING = "NOKKER_LOCAL_SECRET_KEY absente : le coffre local ne range rien en clair";

/** Comme le noyau (`local.allowed_hosts`) : 127.0.0.1:<port> et localhost:<port>, port compris. */
function hostAllowed(host: string | undefined, port: number | undefined): boolean {
  const h = (host ?? "").toLowerCase();
  return port !== undefined && (h === `127.0.0.1:${port}` || h === `localhost:${port}`);
}

/** Routes `/v1/local/*` sous jeton local ; le réglage de démo n'en demande pas. Rend true si la route est à lui. */
export async function handleLocal(
  state: MockState,
  headers: { host?: string; authorization?: string; localPort?: number },
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  const m = localMock(state);

  if (method === "POST" && path === "/v1/dev/local-mock") {
    const b = await readBody();
    const prev: Knobs = { ollama: m.ollama, linkedAtStart: m.linkedAtStart, approveAfter: m.approveAfter, linkOutcome: m.linkOutcome, linkService: m.linkService, vaultKey: m.vaultKey };
    if (typeof b.ollama === "boolean") prev.ollama = b.ollama;
    if (typeof b.linked === "boolean") prev.linkedAtStart = b.linked;
    if (typeof b.approve_after === "number" && b.approve_after >= 0) prev.approveAfter = Math.floor(b.approve_after);
    if (b.link_outcome === "approved" || b.link_outcome === "denied" || b.link_outcome === "expired") prev.linkOutcome = b.link_outcome;
    if (b.link_service === "up" || b.link_service === "down") prev.linkService = b.link_service;
    if (b.vault === "ok" || b.vault === "missing") prev.vaultKey = b.vault;
    // `link_service` et `vault` se basculent en cours de route ; les autres réglages repartent d'un premier lancement
    // (réglage non fait, aucun flux en cours).
    const midRoute = Object.keys(b).every((k) => k === "link_service" || k === "vault");
    let next = m;
    if (midRoute) {
      m.linkService = prev.linkService;
      m.vaultKey = prev.vaultKey;
    } else {
      next = fresh(prev);
      mocks.set(state, next);
    }
    send(200, { ollama: next.ollama, linked: next.linkedAtStart, approve_after: next.approveAfter, link_outcome: next.linkOutcome, link_service: next.linkService, vault: next.vaultKey });
    return true;
  }

  // Seulement les routes de l'écran /setup (les autres `/v1/local/*` sont servies par local.ts).
  if (!path.startsWith("/v1/local/setup") && !path.startsWith("/v1/local/link")) return false;
  if (!hostAllowed(headers.host, headers.localPort)) return bad(send, 403, "hôte non autorisé");
  const ok = headers.authorization === `Bearer ${LOCAL_TOKEN}` || (!!state.localToken && headers.authorization === `Bearer ${state.localToken}`);
  if (!ok) return bad(send, 401, "jeton local requis");

  if (method === "GET" && path === "/v1/local/setup") {
    send(200, setupView(state, m));
    return true;
  }

  if (method === "POST" && path === "/v1/local/setup/models/test") {
    const b = await readBody();
    send(200, testModel(String(b.base_url ?? ""), String(b.api_key ?? "")));
    return true;
  }

  if (method === "PUT" && path === "/v1/local/setup/models") {
    const b = await readBody();
    if (m.vaultKey === "missing") return bad(send, 503, VAULT_MISSING);
    // `byok` REMPLACE la liste ; une clé omise reste au coffre sous `byok:<nom>`.
    if ("byok" in b) {
      const kept: LocalMock["byok"] = [];
      for (const e of Array.isArray(b.byok) ? (b.byok as Array<Record<string, unknown>>) : []) {
        const name = String(e.name ?? "").trim();
        const baseUrl = String(e.base_url ?? "").trim();
        if (!name || !HTTP_URL.test(baseUrl)) return bad(send, 400, "byok : name et base_url http(s) requis");
        if (typeof e.api_key === "string" && e.api_key) m.vault.set(`byok:${name}`, e.api_key);
        kept.push({ name, base_url: baseUrl, model: typeof e.model === "string" ? e.model : null, ok: typeof e.ok === "boolean" ? e.ok : null });
      }
      m.byok = kept;
    }
    if ("default" in b) {
      const def = String(b.default);
      if (!(def === "router" || def.startsWith("byok:") || def.startsWith("local:"))) return bad(send, 400, "default : router | byok:<nom> | local:<url>|<modèle>");
      m.default = def;
    }
    send(200, setupView(state, m));
    return true;
  }

  if (method === "POST" && path === "/v1/local/setup/done") {
    m.done = true;
    send(200, { done: true });
    return true;
  }

  if (method === "POST" && path === "/v1/local/link/start") {
    if (m.linkService === "down") return bad(send, 502, LINK_DOWN);
    const hex = randomBytes(4).toString("hex").toUpperCase().replace(/[01]/g, "7");
    const code = `${hex.slice(0, 4)}-${hex.slice(4)}`;
    const body: LocalLinkStart = { user_code: code, verification_uri: LINK_URI, expires_in: 600, interval: 2 };
    m.link = { code, expiresAt: Date.now() + body.expires_in * 1000, polls: 0 };
    send(200, body);
    return true;
  }

  if (method === "GET" && path === "/v1/local/link/status") {
    // Comme le noyau : clé du Router au coffre → approuvé ; rien en cours → non relié ; flux échu → expiré ; sinon on interroge nokker.ai.
    if (m.vault.has("router")) return send(200, { state: "approved", account: m.account, pages_public: pagesPublicAllowed(state) }), true;
    const l = m.link;
    if (!l) return send(200, { state: "unlinked" }), true;
    if (Date.now() > l.expiresAt) {
      m.link = null;
      return send(200, { state: "expired" }), true;
    }
    if (m.linkService === "down") return bad(send, 502, LINK_DOWN);
    l.polls += 1;
    if (l.polls <= m.approveAfter) return send(200, { state: "pending" }), true;
    if (m.linkOutcome !== "approved") {
      m.link = null;
      return send(200, { state: m.linkOutcome }), true;
    }
    if (m.vaultKey === "missing") return bad(send, 503, VAULT_MISSING);
    m.vault.set("router", "router-key");
    m.account = LINK_ACCOUNT;
    m.link = null;
    if (!m.default) m.default = "router";
    send(200, { state: "approved", account: LINK_ACCOUNT, pages_public: pagesPublicAllowed(state) });
    return true;
  }

  if (method === "DELETE" && path === "/v1/local/link") {
    m.account = null;
    m.link = null;
    m.vault.delete("router");
    if (m.default === "router") m.default = null;
    send(200, { state: "unlinked" });
    return true;
  }

  return false;
}
