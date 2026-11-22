import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { flushZoneEvents, newZoneId, zonesPlugin, type QueuedZoneEvent } from "../src/platform/zones.js";
import { NATIVE_PLUGINS } from "../src/platform/plugins.js";

const ev = (id: string, at: string): QueuedZoneEvent => ({ event_id: id, zone_id: "zn_maison01", event: "enter", at });

describe("zones dans l'app (P6)", () => {
  it("id de zone au format du noyau ; plugin seulement dans la coque, enregistré avec les autres", () => {
    expect(newZoneId()).toMatch(/^zn_[a-z0-9]{10}$/);
    expect(zonesPlugin({})).toBeUndefined();
    expect(NATIVE_PLUGINS).toContain("NokkerZones");
  });
  it("file : dans l'ordre ; pris et refus définitifs sortent ; coupure ou 5xx gardent le reste", async () => {
    const queue = [ev("c", "2026-11-06T10:02:00Z"), ev("a", "2026-11-06T10:00:00Z"), ev("b", "2026-11-06T10:01:00Z"), ev("d", "2026-11-06T10:03:00Z")];
    const seen: string[] = [];
    let cleared: string[] = [];
    const client = {
      postZoneEvent: async (_z: string, e: { event_id: string }) => {
        seen.push(e.event_id);
        if (e.event_id === "b") throw new NokkerApiError("409", 409, { error: { code: "out_of_order" } });
        if (e.event_id === "d") throw new TypeError("Failed to fetch");
        return { queued: true };
      },
    };
    const plugin = { events: async () => ({ events: queue }), clearEvents: async ({ ids }: { ids: string[] }) => ((cleared = ids), { left: queue.length - ids.length }) };
    expect(await flushZoneEvents(client, plugin)).toEqual({ sent: 2, dropped: 1, kept: 1 });
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(cleared).toEqual(["a", "b", "c"]);
    // 401 (session) et 5xx : on garde, on réessaiera.
    const c2 = { postZoneEvent: async () => Promise.reject(new NokkerApiError("401", 401, {})) };
    cleared = [];
    expect(await flushZoneEvents(c2, plugin)).toEqual({ sent: 0, dropped: 0, kept: 4 });
    expect(cleared).toEqual([]);
  });
});
