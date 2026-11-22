import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock.close();
});
const code = (e: unknown): unknown => ((e as NokkerApiError).body as { error?: { code?: string } })?.error?.code;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe("zones du membre (P6, contrat de la phase S)", () => {
  it("noms seulement ; doublon idempotent ; ordre ; fraîcheur ; carte pour l'alarme ; sans pont", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const sc = await c.getHomeScenarios();
    expect(sc.bridge).toBe("home-bridge");
    expect(sc.scenarios.find((x) => x.id === "sc_alarme")?.strong).toBe(true);
    expect(code(await c.putZones([{ id: "zn_maison01", name: "Maison", on_enter: [], on_exit: [], lat: 1 } as never]).catch((e) => e))).toBe("no_coordinates");
    expect(code(await c.putZones(Array.from({ length: 19 }, (_, i) => ({ id: `zn_z${String(i).padStart(6, "0")}`, name: `Z${i}`, on_enter: [], on_exit: [] }))).catch((e) => e))).toBe("too_many_zones");
    await c.putZones([{ id: "zn_maison01", name: "Maison", on_enter: ["sc_entree", "sc_alarme", "sc_inconnu"], on_exit: ["sc_eteindre"] }]);
    expect((await c.getZones()).zones[0]!.on_enter).toEqual(["sc_entree", "sc_alarme"]);
    expect(code(await c.putZones([{ id: "zn_maison01", name: "Maison", on_enter: [], on_exit: [], home: true }, { id: "zn_maison02", name: "Chalet", on_enter: [], on_exit: [], home: true }]).catch((e) => e))).toBe("two_homes");
    expect(code(await c.putZones([{ id: "zn_maison01", name: "Maison", on_enter: [], on_exit: [], color: "red" } as never]).catch((e) => e))).toBe("bad_zone");
    await c.putZones([{ id: "zn_maison01", name: "Maison", on_enter: ["sc_entree", "sc_alarme"], on_exit: ["sc_eteindre"], home: true }]);
    expect((await c.getZones()).zones[0]!.home).toBe(true);
    const r = await c.postZoneEvent("zn_maison01", { event_id: "e1", event: "enter", at: ago(1) });
    expect(r).toEqual({ queued: true, scenarios: [{ id: "sc_entree", status: "started" }, { id: "sc_alarme", status: "card" }] });
    expect(await c.postZoneEvent("zn_maison01", { event_id: "e1", event: "enter", at: ago(1) })).toEqual({ duplicate: true });
    expect(code(await c.postZoneEvent("zn_maison01", { event_id: "e0", event: "exit", at: ago(5) }).catch((e) => e))).toBe("out_of_order");
    const old = await c.postZoneEvent("zn_maison01", { event_id: "e2", event: "exit", at: ago(0) });
    expect(old.scenarios).toEqual([{ id: "sc_eteindre", status: "started" }]);
    expect(code(await c.postZoneEvent("zn_ailleurs", { event_id: "e3", event: "enter", at: ago(0) }).catch((e) => e))).toBe("unknown_zone");
    await fetch(`${mock.url}/v1/dev/zones-mock`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ bridge: null }) });
    expect((await c.postZoneEvent("zn_maison01", { event_id: "e4", event: "enter", at: ago(0) })).scenarios?.[0]).toEqual({ id: "sc_entree", status: "skipped", reason: "no_bridge" });
  });
  it("plus de 30 min : présence seulement, scénarios « stale »", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    await c.putZones([{ id: "zn_travail1", name: "Travail", on_enter: ["sc_entree"], on_exit: [] }]);
    expect((await c.postZoneEvent("zn_travail1", { event_id: "x1", event: "enter", at: ago(45) })).scenarios).toEqual([{ id: "sc_entree", status: "skipped", reason: "stale" }]);
  });
});
