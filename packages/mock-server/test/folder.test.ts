import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerApiError, NokkerClient, folderProgress, type FolderRun } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot(folder: boolean) {
  const cfg = await mkdtemp(join(tmpdir(), "nokker-folder-cfg-"));
  const root = await mkdtemp(join(tmpdir(), "nokker-folder-root-"));
  const proj = join(root, "photos");
  await mkdir(proj);
  for (const f of ["a.jpg", "b.jpg", "notes.txt"]) await writeFile(join(proj, f), "x");
  mock = await startMockServer({ speed: 0.01, seed: false, folder, configDir: cfg, localRoots: [root] });
  return { local: new NokkerClient({ baseUrl: mock.url, token: mock.localToken! }), proj, root };
}
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) throw e;
    const code = (e.body as { error?: { code?: string } }).error?.code;
    return { status: e.status, ...(code ? { code } : {}) };
  }
};
async function until(c: NokkerClient, id: string, pred: (r: FolderRun) => boolean): Promise<FolderRun> {
  const t0 = Date.now();
  for (;;) {
    const r = await c.getFolderRun(id);
    if (pred(r)) return r;
    if (Date.now() - t0 > 4000) throw new Error(`until: timeout (${r.status})`);
    await new Promise((x) => setTimeout(x, 10));
  }
}

describe("folder mode (FOLDER-MODE §6)", () => {
  it("flag off: 404; outside the declared roots: 403 outside_roots; empty task: 400", async () => {
    const off = await boot(false);
    expect((await status(off.local.listFolderRuns())).status).toBe(404);
    await mock!.close();
    const { local, proj } = await boot(true);
    expect(await status(local.createFolderRun({ path: "/etc", task: "x" }))).toEqual({ status: 403, code: "outside_roots" });
    expect(await status(local.createFolderRun({ path: proj, task: " " }))).toEqual({ status: 400, code: "bad_body" });
  });

  it("plan → approve → steps done → report → undo; the mock writes nothing", async () => {
    const { local, proj } = await boot(true);
    const r0 = await local.createFolderRun({ path: proj, task: "range par type" });
    expect(r0).toMatchObject({ status: "planning", in_place: false, card: null });
    const r1 = await until(local, r0.run_id, (r) => r.status === "awaiting_approval");
    expect(r1.card).toMatchObject({ kind: "folder_run", strength: "standard", in_place: false });
    expect(r1.plan!.etapes.map((s) => s.action)).toEqual(["copier", "copier", "copier", "ecrire"]);
    expect(r1.plan!.etapes[0]).toMatchObject({ chemin: "dossier/a.jpg", vers: "sortie/jpg/a.jpg" });
    expect(folderProgress(r1)).toEqual({ done: 0, total: 4 });
    expect((await local.decideFolderRun(r0.run_id, "approve")).status).toBe("running");
    const done = await until(local, r0.run_id, (r) => r.status === "done");
    expect(done.report).toMatchObject({ point_de_retour: true, corbeille: null, etapes_non_faites: [] });
    expect(done.report!.fichiers_touches).toHaveLength(4);
    expect(await status(local.decideFolderRun(r0.run_id, "approve"))).toEqual({ status: 409, code: "not_pending" });
    expect((await local.undoFolderRun(r0.run_id)).status).toBe("undone");
    expect((await readdir(proj)).sort()).toEqual(["a.jpg", "b.jpg", "notes.txt"]);
    expect((await local.listFolderRuns()).runs[0]).toMatchObject({ run_id: r0.run_id, status: "undone" });
  });

  it("in place: strong card, approve needs confirm_in_place; undo reports a conflict unless forced", async () => {
    const { local, proj } = await boot(true);
    const r0 = await local.createFolderRun({ path: proj, task: "range", in_place: true });
    const r1 = await until(local, r0.run_id, (r) => r.status === "awaiting_approval");
    expect(r1.card).toMatchObject({ strength: "strong", in_place: true });
    expect(await status(local.decideFolderRun(r0.run_id, "approve"))).toEqual({ status: 400, code: "confirm_in_place" });
    await local.decideFolderRun(r0.run_id, "approve", true);
    await until(local, r0.run_id, (r) => r.status === "done");
    const u = await local.undoFolderRun(r0.run_id);
    expect(u).toMatchObject({ status: "done", undo: { exact: false } });
    expect(u.undo!.conflicts).toHaveLength(1);
    expect((await local.undoFolderRun(r0.run_id, true)).status).toBe("undone");
  });

  it("reject closes the run; a failed plan says it; an account session cannot reach it", async () => {
    const { local, proj } = await boot(true);
    const r0 = await local.createFolderRun({ path: proj, task: "range" });
    await until(local, r0.run_id, (r) => r.status === "awaiting_approval");
    expect((await local.decideFolderRun(r0.run_id, "reject")).status).toBe("refused");
    const f = await local.createFolderRun({ path: proj, task: "fail please" });
    expect(await until(local, f.run_id, (r) => r.status === "failed")).toMatchObject({ error: expect.any(String) });
    const account = new NokkerClient({ baseUrl: mock!.url });
    expect((await status(account.listFolderRuns())).status).toBe(401);
  });
});
