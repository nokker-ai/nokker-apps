/**
 * Zones du membre (LOKKAL-PHONE §4.2, lot P6) — faux noyau du contrat de la phase S (packages/sdk/src/zones.ts) :
 * noms et id seulement (jamais de coordonnées), transitions idempotentes par `event_id`, ordre par zone (409), fraîcheur
 * 30 min (`stale`), serrure ou alarme → `card`, ACL du foyer (un mineur ne lance pas un scénario fort).
 * Mock seulement : POST /v1/dev/zones-mock {bridge?: "home-bridge" | "home-node" | null, reset?: true}.
 */
import type { HomeScenarios, Zone, ZoneScenarioOutcome } from "@nokker-apps/sdk";
import { householdMinor } from "./household.js";
import type { MockState } from "./state.js";

type Send = (status: number, obj: unknown) => void;
const MAX = 18;
const STALE_MS = 30 * 60_000;
const SCENARIOS: HomeScenarios["scenarios"] = [
  { id: "sc_entree", name: "Allumer l'entrée", strong: false },
  { id: "sc_chauffage", name: "Chauffage en mode confort", strong: false },
  { id: "sc_alarme", name: "Couper l'alarme", strong: true },
  { id: "sc_eteindre", name: "Tout éteindre", strong: false },
];

interface ZonesState {
  zones: Map<string, Zone[]>;
  seen: Map<string, Set<string>>;
  last: Map<string, string>;
  bridge: HomeScenarios["bridge"];
  log: Array<{ user: string; zone_id: string; event: string; at: string; scenarios: ZoneScenarioOutcome[] }>;
}
const all = new WeakMap<MockState, ZonesState>();
const fresh = (): ZonesState => ({ zones: new Map(), seen: new Map(), last: new Map(), bridge: "home-bridge", log: [] });
function st(state: MockState): ZonesState {
  let s = all.get(state);
  if (!s) all.set(state, (s = fresh()));
  return s;
}

export async function handleZones(state: MockState, user: string, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const s = st(state);
  const err = (status: number, code: string, message = code): true => (send(status, { error: { code, message } }), true);
  if (path === "/v1/dev/zones-mock" && method === "POST") {
    const b = await readBody();
    if (b.reset) all.set(state, fresh());
    const t = st(state);
    if ("bridge" in b) t.bridge = (b.bridge as HomeScenarios["bridge"]) ?? null;
    return send(200, { bridge: t.bridge, log: t.log }), true;
  }
  if (path === "/v1/home/scenarios" && method === "GET") return send(200, { scenarios: s.bridge ? SCENARIOS : [], bridge: s.bridge }), true;
  if (path === "/v1/me/zones" && method === "GET") return send(200, { zones: s.zones.get(user) ?? [] }), true;
  if (path === "/v1/me/zones" && method === "PUT") {
    const b = await readBody();
    const raw = Array.isArray(b.zones) ? (b.zones as Record<string, unknown>[]) : null;
    if (!raw) return err(400, "invalid", "corps attendu : {zones: [...]}");
    if (raw.length > MAX) return err(400, "too_many_zones", `${MAX} zones au plus`);
    const known = new Set(SCENARIOS.map((x) => x.id));
    const zones: Zone[] = [];
    const ALLOWED = new Set(["id", "name", "on_enter", "on_exit", "home"]);
    for (const z of raw) {
      if ("lat" in z || "lon" in z || "radius" in z) return err(400, "no_coordinates", "les coordonnées restent sur l'appareil");
      if (Object.keys(z).some((k) => !ALLOWED.has(k))) return err(400, "bad_zone", "clé inconnue");
      const name = typeof z.name === "string" ? z.name.trim() : "";
      if (typeof z.id !== "string" || !/^zn_[a-z0-9]{6,24}$/.test(z.id) || !name || name.length > 40) return err(400, "bad_zone");
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && known.has(x)) : []);
      zones.push({ id: z.id, name, on_enter: list(z.on_enter), on_exit: list(z.on_exit), home: z.home === true });
    }
    if (zones.filter((z) => z.home).length > 1) return err(400, "two_homes", "une seule zone maison par membre");
    s.zones.set(user, zones);
    return send(200, { zones }), true;
  }
  const m = /^\/v1\/me\/zones\/([^/]+)\/event$/.exec(path);
  if (m && method === "POST") {
    const zone = (s.zones.get(user) ?? []).find((z) => z.id === decodeURIComponent(m[1]!));
    if (!zone) return err(404, "unknown_zone");
    const b = await readBody();
    const event = b.event === "enter" || b.event === "exit" ? b.event : null;
    const at = typeof b.at === "string" && !Number.isNaN(Date.parse(b.at)) ? b.at : null;
    if (!event || !at || typeof b.event_id !== "string" || !b.event_id) return err(400, "bad_event");
    const seen = s.seen.get(user) ?? new Set<string>();
    s.seen.set(user, seen);
    if (seen.has(b.event_id)) return send(200, { duplicate: true }), true;
    const key = `${user}/${zone.id}`;
    if (s.last.has(key) && Date.parse(at) < Date.parse(s.last.get(key)!)) return err(409, "out_of_order", "plus vieille que la dernière transition");
    seen.add(b.event_id);
    s.last.set(key, at);
    const stale = Date.now() - Date.parse(at) > STALE_MS;
    const minor = householdMinor(state, user);
    const scenarios: ZoneScenarioOutcome[] = (event === "enter" ? zone.on_enter : zone.on_exit).map((id) => {
      const sc = SCENARIOS.find((x) => x.id === id)!;
      if (stale) return { id, status: "skipped", reason: "stale" };
      if (!s.bridge) return { id, status: "skipped", reason: "no_bridge" };
      if (sc.strong && minor) return { id, status: "skipped", reason: "not_allowed" };
      return { id, status: sc.strong ? "card" : "started" };
    });
    s.log.push({ user, zone_id: zone.id, event, at, scenarios });
    return send(202, { queued: true, scenarios }), true;
  }
  return false;
}
