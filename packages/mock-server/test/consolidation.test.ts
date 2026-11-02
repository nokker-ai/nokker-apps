import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, opCount } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});
async function boot(consolidation: boolean): Promise<NokkerClient> {
  const m = await startMockServer({ speed: 0.01, consolidation, configDir: null });
  mock = m;
  const c = new NokkerClient({ baseUrl: m.url });
  await c.demoSessionMockExtension();
  return c;
}
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } }).error?.code };
  }
};

describe("memory consolidation (CONSOLIDATION §6)", () => {
  it("flag off: 404", async () => {
    const c = await boot(false);
    expect((await status(c.listConsolidationRuns())).status).toBe(404);
  });

  it("last night's report: counts, French summary, ops with before/after; never an author or tenant", async () => {
    const c = await boot(true);
    const { runs } = await c.listConsolidationRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "done", dry_run: false, summary: "1 fusion, 1 correction, 1 archivage, 1 leçon" });
    expect(opCount(runs[0]!)).toBe(4);
    const rep = await c.getConsolidationRun(runs[0]!.id);
    expect(rep.ops.map((o) => o.kind)).toEqual(["merge", "correct", "archive", "lesson"]);
    expect(JSON.stringify(rep)).not.toMatch(/tenant|embedding|author|@example\./);
  });

  it("undo one op; an op whose note changed since is a 409 conflict; undoing the night lists it and undoes the rest", async () => {
    const c = await boot(true);
    const id = (await c.listConsolidationRuns()).runs[0]!.id;
    expect(await c.undoConsolidationOp("co_archive")).toEqual({ op: "co_archive", undone: true, already: false });
    expect(await c.undoConsolidationOp("co_archive")).toEqual({ op: "co_archive", undone: true, already: true });
    expect(await status(c.undoConsolidationOp("co_correct"))).toEqual({ status: 409, code: "conflict" });
    const night = await c.undoConsolidationRun(id);
    expect(night).toMatchObject({ run: id, complete: false, already: ["co_archive"] });
    expect(night.undone.sort()).toEqual(["co_lesson", "co_merge"]);
    expect(night.conflicts.map((x) => x.op)).toEqual(["co_correct"]);
    expect((await c.getConsolidationRun(id)).run.undone_at).toBeNull(); // not complete: the night is not marked undone
  });

  it("settings, pins, run now (preview, then already done tonight)", async () => {
    const c = await boot(true);
    expect(await c.getConsolidationSettings()).toEqual({ enabled: true, tz: "Europe/Zurich", cron: "30 3 * * *", max_ops: 40 });
    expect(await c.putConsolidationSettings({ cron: "0 4 * * *" })).toMatchObject({ cron: "0 4 * * *" });
    expect(await status(c.putConsolidationSettings({ cron: "every night" }))).toEqual({ status: 400, code: "bad_schedule" });
    expect(await status(c.putConsolidationSettings({ tz: "Mars/Olympus" }))).toEqual({ status: 400, code: "bad_schedule" });
    expect((await c.pinConsolidationNote("rapports-lundi", true)).pins).toEqual(["rapports-lundi"]);
    expect(await status(c.pinConsolidationNote("no-such-note", true))).toEqual({ status: 404, code: "not_found" });
    const preview = await c.runConsolidation(true);
    expect("run" in preview && preview.run.dry_run).toBe(true);
    await c.runConsolidation();
    expect(await c.runConsolidation()).toMatchObject({ status: "already" });
  });
});
