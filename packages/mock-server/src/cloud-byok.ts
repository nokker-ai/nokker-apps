/**
 * BYOK sur nokker.ai (core docs/CLOUD-BYOK.md, p2/cloud-byok e799f72), mock : drapeau `MOCK_CLOUD_BYOK=1`
 * (`MOCK_CLOUD_BYOK=open` : tout compte y a droit, comme `cloud_byok.open_to_all` du noyau — e2e).
 *   GET  /v1/account/models       → {default, effective, entitled, byok:[{name, base_url, model, has_key, ok, models?}]}
 *   PUT  /v1/account/models       {default?, byok?} liste complète (8 au plus) ; clé gardée sauf si l'hôte change
 *   POST /v1/account/models/test  {base_url, api_key?, model?} → {ok, models, latency_ms, error?, model_listed?}
 * Droit : palier byok, solo, famille ou large (cloud_byok.plans du noyau, décision du 05.11) du mock de Mon compte
 * (`POST /v1/dev/account-mock {plan}`). Les points d'accès sont simulés d'après l'hôte : « bad-key » → HTTP 401, « down » → ConnectError, privé/local → 400 blocked_address,
 * sinon deux modèles. Aucune clé n'est jamais renvoyée ; le mock ne garde qu'un booléen.
 */
import { accountMock } from "./account.js";
import type { MockState } from "./state.js";

type Send = (status: number, obj: unknown) => void;

interface Entry {
  name: string;
  base_url: string;
  model: string | null;
  has_key: boolean;
  ok: boolean;
  models: string[];
}

interface ByokState {
  default: string;
  entries: Entry[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const MAX = 8;
const states = new WeakMap<MockState, ByokState>();

function byokState(state: MockState): ByokState {
  let s = states.get(state);
  if (!s) states.set(state, (s = { default: "router", entries: [] }));
  return s;
}

const entitled = (state: MockState): boolean => process.env.MOCK_CLOUD_BYOK === "open" || ["byok", "solo", "famille", "large"].includes(accountMock(state).plan ?? "");

function hostPort(u: URL): string {
  return `${u.hostname.toLowerCase()}:${u.port || "443"}`;
}

/** Adresse https valide, sans identifiants ni requête ; null sinon. Le `/` final est retiré. */
function cleanUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u;
  } catch {
    return null;
  }
}

const blocked = (u: URL): boolean => /^(localhost|127\.|10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(u.hostname) || u.hostname.endsWith(".internal");

function probe(u: URL, hasKey: boolean): { ok: boolean; models: string[]; latency_ms: number | null; error?: string } {
  if (u.hostname.includes("down")) return { ok: false, models: [], latency_ms: null, error: "ConnectError" };
  if (u.hostname.includes("bad-key") || (u.hostname.includes("needs-key") && !hasKey)) return { ok: false, models: [], latency_ms: 38, error: "HTTP 401" };
  return { ok: true, models: ["demo-small", "demo-large"], latency_ms: 42 };
}

/** Formule `byok` : pas de Router (docs/CLOUD-BYOK.md §2-3, 43fb3b4). */
const routerIncluded = (state: MockState): boolean => accountMock(state).plan !== "byok";

function view(state: MockState): Record<string, unknown> {
  const s = byokState(state);
  const ent = entitled(state);
  const withRouter = routerIncluded(state);
  const usable = s.default !== "router" && s.entries.some((e) => `byok:${e.name}` === s.default && e.model);
  return {
    default: s.default,
    effective: !ent ? "router" : !withRouter && !usable ? "none" : s.default,
    entitled: ent,
    router_included: withRouter,
    byok: s.entries.map((e) => ({ name: e.name, base_url: e.base_url, model: e.model, has_key: e.has_key, ok: e.ok, ...(e.models.length ? { models: e.models } : {}) })),
  };
}

export function cloudByokOn(): boolean {
  return process.env.MOCK_CLOUD_BYOK === "1" || process.env.MOCK_CLOUD_BYOK === "open";
}

export async function handleCloudByok(state: MockState, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  if (path !== "/v1/account/models" && path !== "/v1/account/models/test") return false;
  const fail = (status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);
  if (!cloudByokOn()) return fail(404, "not_found", "cloud_byok éteint");

  if (path === "/v1/account/models" && method === "GET") return send(200, view(state)), true;

  if (path === "/v1/account/models/test" && method === "POST") {
    if (!entitled(state)) return fail(403, "plan_required", "formule sans BYOK");
    const b = await readBody();
    const u = cleanUrl(b.base_url);
    if (!u) return fail(400, "bad_base_url", "https requis");
    if (blocked(u)) return fail(400, "blocked_address", "adresse refusée");
    const stored = byokState(state).entries.find((e) => e.base_url === u.toString().replace(/\/$/, ""));
    const r = probe(u, typeof b.api_key === "string" ? b.api_key.length > 0 : !!stored?.has_key);
    const model = typeof b.model === "string" ? b.model : null;
    return send(200, { ...r, ...(model ? { model_listed: r.models.includes(model) } : {}) }), true;
  }

  if (path === "/v1/account/models" && method === "PUT") {
    if (!entitled(state)) return fail(403, "plan_required", "formule sans BYOK");
    const b = await readBody();
    const s = byokState(state);
    let entries = s.entries;
    if (b.byok !== undefined) {
      if (!Array.isArray(b.byok)) return fail(400, "bad_byok", "byok doit être une liste");
      if (b.byok.length > MAX) return fail(400, "bad_byok", "8 entrées au plus");
      const seen = new Set<string>();
      const next: Entry[] = [];
      for (const raw of b.byok as Array<Record<string, unknown>>) {
        const name = String(raw.name ?? "");
        if (!NAME.test(name) || seen.has(name)) return fail(400, "bad_name", "nom refusé");
        seen.add(name);
        const u = cleanUrl(raw.base_url);
        if (!u) return fail(400, "bad_base_url", "https requis");
        if (blocked(u)) return fail(400, "blocked_address", "adresse refusée");
        const key = raw.api_key;
        if (key !== undefined && (typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key))) return fail(400, "bad_api_key", "clé refusée");
        const model = raw.model === undefined || raw.model === null ? null : String(raw.model);
        if (model !== null && (model.length === 0 || model.length > 200)) return fail(400, "bad_model", "modèle refusé");
        const prev = s.entries.find((e) => e.name === name);
        // Une clé ne suit jamais vers un autre hôte (nom + port) que celui où elle a été donnée.
        const samehost = !!prev && hostPort(new URL(prev.base_url)) === hostPort(u);
        const has_key = typeof key === "string" ? true : samehost ? prev!.has_key : false;
        const base_url = u.toString().replace(/\/$/, "");
        const changed = !prev || prev.base_url !== base_url || typeof key === "string";
        const r = changed ? probe(u, has_key) : { ok: prev!.ok, models: prev!.models };
        next.push({ name, base_url, model, has_key, ok: r.ok, models: r.models });
      }
      entries = next;
    }
    let def = s.default;
    if (b.default !== undefined) {
      const d = String(b.default);
      const target = d.startsWith("byok:") ? entries.find((e) => `byok:${e.name}` === d) : null;
      if (d !== "router" && (!target || !target.model)) return fail(400, "bad_default", "défaut inconnu ou sans modèle");
      if (d === "router" && !routerIncluded(state)) return fail(400, "bad_default", "formule sans Router");
      def = d;
    } else if (def !== "router" && !entries.some((e) => `byok:${e.name}` === def)) def = "router";
    s.entries = entries;
    s.default = def;
    return send(200, view(state)), true;
  }
  return fail(405, "method_not_allowed", "méthode refusée");
}
