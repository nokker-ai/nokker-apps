import { describe, expect, it } from "vitest";
import type { DeckMachine, Thread } from "@nokker-apps/sdk";
import { CLOUD, filterRows, machineBase, mergeSearch, mirrorOf, offlineMinutes, parseThreadRoute, searchOfflineTitles, threadRoute, unifiedRows, withTimeout } from "../src/sessions/origins.js";

const th = (id: string, at: string, title = id): Thread => ({ id, title, updated_at: at, created_at: at, bubble_count: 0 }) as unknown as Thread;
const mc = (id: string, name: string, online: boolean, threads: DeckMachine["threads"] = [], mirror = false): DeckMachine =>
  ({ machine_id: id, name, host: `${name}.nokker.app`, online, load_age_s: 0, load: null, deck_at: 0, deck_age_s: online ? 5 : 720, sessions: [], agents: [], pending_approvals: 0, strong_approvals: [], threads, mirror }) as DeckMachine;

describe("liste unique cloud + machines (LOKKAL-PHONE §1.2)", () => {
  it("fusionne par date ; machine en ligne lue = ses fils ; éteinte = son deck, grisée ; la copie miroir n'est pas en double", () => {
    const cloud = [th("t1", "2026-11-06T08:00:00Z", "Général"), th("lokkal-mc_a-x9", "2026-11-06T09:30:00Z", "site (copie)")];
    const machines = [
      mc("mc_a", "atelier", false, [{ thread_id: "x9", state: "idle", updated_at: "2026-11-06T09:00:00Z", channel: "code", title: "site" }], true),
      mc("mc_b", "gmk", true, [{ thread_id: "deckonly", state: "idle", updated_at: "2026-11-06T07:00:00Z", channel: "api", title: null }]),
    ];
    const rows = unifiedRows(cloud, machines, { mc_b: [th("b1", "2026-11-06T10:00:00Z", "Courses")] });
    expect(rows.map((r) => [r.origin, r.id, r.offline])).toEqual([
      ["mc_b", "b1", false],
      ["mc_a", "x9", true],
      [CLOUD, "t1", false],
    ]);
    expect(rows[1]).toMatchObject({ originName: "atelier", title: "site", channel: "code", thread: null });
    // Machine en ligne pas encore lue : les fils de son deck, non grisés.
    expect(unifiedRows([], machines, {}).find((r) => r.id === "deckonly")).toMatchObject({ offline: false, title: null });
    expect(filterRows(rows, "mc_a").map((r) => r.id)).toEqual(["x9"]);
    expect(filterRows(rows, "all")).toHaveLength(3);
    expect(mirrorOf("lokkal-mc_a-x9")).toEqual({ machine: "mc_a", thread: "x9" });
    expect(mirrorOf("t1")).toBeNull();
    expect(offlineMinutes({ ageS: 720 })).toBe(12);
  });
  it("routes : ancien lien cloud, lien d'une machine, bulle conservée ; base de la passerelle", () => {
    expect(parseThreadRoute("#/t/th_1")).toEqual({ origin: CLOUD, id: "th_1" });
    expect(parseThreadRoute("#/t/th_1/b/bb_2")).toEqual({ origin: CLOUD, id: "th_1", bubble: "bb_2" });
    expect(parseThreadRoute("#/t/mc_a/th_9")).toEqual({ origin: "mc_a", id: "th_9" });
    expect(parseThreadRoute("#/t/mc_a/th_9/b/bb_1")).toEqual({ origin: "mc_a", id: "th_9", bubble: "bb_1" });
    expect(parseThreadRoute("#/account")).toBeNull();
    expect(threadRoute(CLOUD, "th_1")).toBe("#/t/th_1");
    expect(threadRoute("mc_a", "th 9")).toBe("#/t/mc_a/th%209");
    expect(machineBase("atelier.nokker.app")).toBe("https://atelier.nokker.app");
    expect(machineBase("127.0.0.1:7420")).toBe("http://127.0.0.1:7420");
  });
  it("recherche fusionnée par date ; origines muettes nommées ; machines éteintes cherchées par titres du deck", async () => {
    const { rows, silent } = mergeSearch([
      { origin: CLOUD, name: "cloud", results: [{ thread_id: "t1", title: "Général", snippet: "…facture…", turn_index: 3, at: "2026-11-06T08:00:00Z", channel: "api" }] },
      { origin: "mc_b", name: "gmk", results: [{ thread_id: "b1", title: "Courses", snippet: "…facture…", turn_index: 1, at: "2026-11-06T10:00:00Z", channel: "api" }] },
      { origin: "mc_c", name: "bureau", failed: true },
    ]);
    expect(rows.map((r) => [r.origin, r.thread_id])).toEqual([["mc_b", "b1"], [CLOUD, "t1"]]);
    expect(silent).toEqual(["bureau"]);
    const off = searchOfflineTitles("factures", [mc("mc_a", "atelier", false, [{ thread_id: "x", state: "idle", updated_at: "2026-11-01T00:00:00Z", channel: "api", title: "Factures été" }, { thread_id: "y", state: "idle", updated_at: "2026-11-01T00:00:00Z", channel: "api", title: null }])]);
    expect(off[0]!.results!.map((r) => r.thread_id)).toEqual(["x"]);
    // Copie en miroir trouvée par le cloud : rendue à sa machine, une seule fois.
    const dup = mergeSearch(
      [
        { origin: CLOUD, name: "cloud", results: [{ thread_id: "lokkal-mc_a-x9", title: null, snippet: "…", turn_index: 2, at: "2026-11-06T09:00:00Z", channel: "code", copy_of: { machine_id: "mc_a", thread_id: "x9" } }] },
        { origin: "mc_a", name: "atelier", results: [{ thread_id: "x9", title: "site", snippet: "…", turn_index: 2, at: "2026-11-06T09:00:00Z", channel: "code" }] },
      ],
      { mc_a: "atelier" },
    );
    expect(dup.rows.map((r) => [r.origin, r.thread_id, r.originName])).toEqual([["mc_a", "x9", "atelier"]]);
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toThrow("timeout");
    await expect(withTimeout(Promise.resolve(1), 10)).resolves.toBe(1);
  });
});
