import { afterEach, describe, expect, it } from "vitest";
import { HaRelay, haWsUrl, type HaRelayError, type WsLike } from "@nokker-apps/sdk";
// @ts-expect-error — script du CI en JavaScript, sans types
import { startFakeHa } from "../../../scripts/ios-ci/fake-ha.mjs";

const TOKEN = "fake-ha-test-token";
let ha: { url: string; calls: unknown[]; close: () => Promise<void> };
let relays: HaRelay[] = [];
afterEach(async () => {
  for (const r of relays) r.close();
  relays = [];
  await ha?.close();
});
const open = (u: string) => new WebSocket(u) as unknown as WsLike;
const relay = (o: { entities: string[]; token?: string; wifi?: () => boolean }) => {
  const r = new HaRelay({ wsUrl: haWsUrl(ha.url), token: o.token ?? TOKEN, entities: o.entities, homeWifi: o.wifi ?? (() => true), open, timeoutMs: 3000 });
  relays.push(r);
  return r;
};
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: HaRelayError) => e.code);

describe("relais HA de référence contre le faux HA (P10a)", () => {
  it("états filtrés par la liste, coordonnées retirées ; liste vide = rien", async () => {
    ha = await startFakeHa({ token: TOKEN });
    const r = relay({ entities: ["light.*", "person.*", "zone.*"] });
    const { states } = (await r.run("ha.states", {})) as { states: { entity_id: string; attributes: Record<string, unknown> }[] };
    expect(states.map((s) => s.entity_id).sort()).toEqual(["light.cuisine", "light.salon", "person.lea", "zone.home"]);
    const json = JSON.stringify(states);
    expect(json).not.toMatch(/latitude|longitude|gps_accuracy/);
    expect(states.find((s) => s.entity_id === "zone.home")?.attributes.radius).toBe(100);
    expect(((await relay({ entities: [] }).run("ha.states", {})) as { states: unknown[] }).states).toEqual([]);
    const hist = (await r.run("ha.history", { entity_ids: ["light.salon"], hours: 2 })) as { history: Record<string, { s: string }[]> };
    expect(hist.history["light.salon"]?.map((x) => x.s)).toEqual(["off", "off"]);
    const log = (await r.run("ha.logbook", { entity_ids: ["light.cuisine"] })) as { entries: Record<string, unknown>[] };
    expect(log.entries).toEqual([{ when: 1762419600, entity_id: "light.cuisine", state: "on", name: "Cuisine" }]); // context_id retiré
    expect(await codeOf(r.run("ha.history", { entity_ids: ["switch.four"] }))).toBe("entity_not_allowed");
    const reg = (await r.run("ha.registry", {})) as { areas: unknown[]; entities: { entity_id: string }[] };
    expect(reg.areas).toHaveLength(2);
    expect(reg.entities.every((e) => /^(light|person|zone)\./.test(e.entity_id))).toBe(true);
  });

  it("appel ciblé, événement state_changed par la file ; gardes de l'appareil", async () => {
    ha = await startFakeHa({ token: TOKEN });
    const r = relay({ entities: ["light.*", "weather.maison"] });
    expect(await r.run("ha.events", { after: -1 })).toEqual({ cursor: 0, events: [] });
    const waiting = r.run("ha.events", { after: 0, timeout: 5 });
    expect(await r.run("ha.call_service", { domain: "light", service: "turn_on", entity_ids: ["light.salon"], data: { brightness: 120 } })).toEqual({ ok: true });
    const ev = (await waiting) as { cursor: number; events: { seq: number; event: { data: { entity_id: string; new_state: { state: string } } } }[] };
    expect(ev.cursor).toBe(1);
    expect(ev.events[0]).toMatchObject({ seq: 1, event: { data: { entity_id: "light.salon", new_state: { state: "on" } } } });
    expect(ha.calls).toEqual([{ domain: "light", service: "turn_on", entity_ids: ["light.salon"], data: { brightness: 120 } }]);
    // Gardes : hors liste, cible dans data, service à réponse par call_service, et l'inverse.
    expect(await codeOf(r.run("ha.call_service", { domain: "switch", service: "turn_on", entity_ids: ["switch.four"] }))).toBe("entity_not_allowed");
    expect(await codeOf(r.run("ha.call_service", { domain: "light", service: "turn_on", entity_ids: ["light.salon"], data: { area_id: "salon" } }))).toBe("entity_not_allowed");
    expect(await codeOf(r.run("ha.call_service", { domain: "weather", service: "get_forecasts", entity_ids: ["weather.maison"] }))).toBe("service_not_allowed");
    expect(await codeOf(r.run("ha.query", { domain: "light", service: "turn_on", entity_ids: ["light.salon"] }))).toBe("service_not_allowed");
    expect(await r.run("ha.query", { domain: "weather", service: "get_forecasts", entity_ids: ["weather.maison"], data: { type: "daily" } })).toEqual({ response: { "weather.maison": { forecast: [{ condition: "sunny", temperature: 14 }] } } });
    expect(await codeOf(r.run("ha.tracker_see", { dev_id: "nokker_lea", location_name: "Maison", gps: [1, 2] }))).toBe("bad_args");
    expect(ha.calls).toHaveLength(2); // rien d'autre n'est parti vers HA
  });

  it("jeton refusé, HA injoignable, Wi-Fi qui n'est pas celui de la maison", async () => {
    ha = await startFakeHa({ token: TOKEN });
    expect(await codeOf(relay({ entities: ["light.*"], token: "faux" }).run("ha.states", {}))).toBe("ha_auth_failed");
    expect(await codeOf(relay({ entities: ["light.*"], wifi: () => false }).run("ha.states", {}))).toBe("not_home_wifi");
    const url = ha.url;
    await ha.close();
    ha = { url, calls: [], close: async () => undefined };
    expect(await codeOf(relay({ entities: ["light.*"] }).run("ha.states", {}))).toBe("ha_unreachable");
  });
});
