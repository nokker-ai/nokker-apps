import { describe, expect, it } from "vitest";
import type { DeckMachine } from "@nokker-apps/sdk";
import { byNewest, timeKey, unifiedRows } from "../src/sessions/origins.js";

describe("linked machines never bring the list down (prod 47.1)", () => {
  it("timeKey reads strings, epoch seconds and milliseconds, and nothing else", () => {
    expect(timeKey("2026-11-07T10:00:00Z")).toBe("2026-11-07T10:00:00Z");
    expect(timeKey(1_762_509_600)).toBe(new Date(1_762_509_600_000).toISOString());
    expect(timeKey(1_762_509_600_000)).toBe(new Date(1_762_509_600_000).toISOString());
    for (const v of [null, undefined, {}, [], NaN, true]) expect(timeKey(v)).toBe("");
  });
  it("odd deck values (number, null, object, missing threads) are sorted or ignored, never thrown", () => {
    const m = (id: string, threads: unknown): DeckMachine => ({ machine_id: id, name: id, host: `${id}.nokker.app`, online: false, threads } as unknown as DeckMachine);
    const rows = unifiedRows(
      [{ id: "th_cloud", title: "Cloud", updated_at: "2026-11-07T09:00:00Z" } as never],
      [m("mc_a", [{ thread_id: "t1", updated_at: Date.parse("2026-11-07T10:00:00Z") / 1000, state: "idle", channel: "api", title: "A" }, { thread_id: "t2", updated_at: null }]), m("mc_b", { error: "boom" }), m("mc_c", [null, { updated_at: {} }])],
      { mc_a: undefined },
    );
    expect(rows.map((r) => r.id)).toEqual(["t1", "th_cloud", "t2"]);
    expect(() => [{ x: 1 }, { x: "a" }, { x: null }].sort(byNewest((r) => r.x))).not.toThrow();
  });
});

describe("« Dernière lecture » des Lunettes (secondes lues comme des millisecondes → 1970)", () => {
  it("timeKey d'un horodatage en secondes donne la bonne année, pas 1970", () => {
    const secs = Date.parse("2026-11-10T08:00:00Z") / 1000;
    expect(new Date(timeKey(secs)).getUTCFullYear()).toBe(2026);
    expect(new Date(timeKey("2026-11-10T08:00:00Z")).getUTCFullYear()).toBe(2026);
  });
});
