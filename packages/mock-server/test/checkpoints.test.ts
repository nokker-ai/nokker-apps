/**
 * Points de retour du mock, alignés sur le noyau (docs/en/checkpoints.md, `nokker/tools/checkpoints.py`) : un point
 * automatique avant le premier appel non-READ de chaque tour (raison « avant <outil> », à la seconde) ; avec
 * `localWrites`, le scénario écrit vraiment et un retour PAR FICHIER restaure le contenu photographié ; un fichier absent
 * du point (créé depuis) est supprimé après un point « avant retour » qui le contient (§7.4.7, noyau du 25.10). Chaque
 * point est relié à son tour (`thread_id`, `turn_index`, `tool`) et publie `checkpoint.created`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient, type Approval, type CheckpointInfo, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let dir: string;
let proj: string;
let client: NokkerClient;
let events: NokkerEvent[];
let sub: { close(): void };

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: délai dépassé");
    await wait(10);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-cp-"));
  proj = join(dir, "projets", "calc");
  await mkdir(join(proj, "src"), { recursive: true });
  await writeFile(join(proj, "src", "app.py"), "def add(a, b):\n    return a - b\n");
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [join(dir, "projets")], localWrites: true });
  client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
  events = [];
  sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
  await wait(100);
});
afterAll(async () => {
  sub.close();
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

async function list(th: string): Promise<CheckpointInfo[]> {
  const r = await client.callLocalTool(th, "checkpoint_list");
  return JSON.parse((r as { content: string }).content) as CheckpointInfo[];
}

/** Un tour « corrige le test add » ; les cartes du tour sont décidées comme au terminal (pytest oui, rm non). */
async function fixTurn(th: string): Promise<void> {
  const decided = new Set<string>();
  let stop = false;
  const pump = (async () => {
    while (!stop) {
      for (const a of (await client.listLocalApprovals()).filter((x: Approval) => x.thread_id === th && !decided.has(x.id))) {
        decided.add(a.id);
        await client.decideLocalApproval(a.id, { decision: a.strength === "strong" ? "reject" : "approve", scope: "once" });
      }
      await wait(10);
    }
  })();
  await client.streamChatCompletion(th, [{ role: "user", content: "corrige le test add" }], () => {});
  stop = true;
  await pump;
}

describe("points de retour automatiques et retour par fichier", () => {
  it("un point « avant patch » par tour, à la seconde ; le patch écrit vraiment", async () => {
    const th = (await client.createLocalSession({ cwd: proj })).thread_id;
    const before = await list(th);
    await fixTurn(th);
    const after = await list(th);
    const added = after.filter((c) => !before.some((b) => b.hash === c.hash));
    expect(added).toHaveLength(1); // un seul par tour, même avec pytest après le patch
    expect(added[0]!.reason).toBe("avant patch");
    // Lié au tour qui l'a pris, annoncé par checkpoint.created ; les points de démo d'avant n'ont pas de lien.
    expect(added[0]).toMatchObject({ thread_id: th, turn_index: 0, tool: "patch" });
    expect(events.find((e) => e.type === "checkpoint.created" && e.hash === added[0]!.hash)).toEqual({ type: "checkpoint.created", thread_id: th, turn_index: 0, hash: added[0]!.hash, tool: "patch" });
    expect(before.every((c) => c.turn_index === undefined)).toBe(true);
    expect(added[0]!.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    expect(await readFile(join(proj, "src", "app.py"), "utf-8")).toBe("def add(a, b):\n    return a + b\n");

    // Retour du fichier au point du tour : carte forte (destructif), décidée au terminal, puis le contenu revient.
    const r = await client.callLocalTool(th, "checkpoint_restore", { hash: added[0]!.hash, file: "src/app.py" });
    const id = (r as { approval_id: string }).approval_id;
    expect(id).toBeTruthy();
    const card = (await client.listLocalApprovals()).find((a) => a.id === id)!;
    expect(card).toMatchObject({ tool_name: "checkpoint_restore", strength: "strong" });
    await client.decideLocalApproval(id, { decision: "approve", scope: "once" });
    const ev = (await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === id))) as { is_error: boolean; content: string };
    expect(ev.is_error).toBe(false);
    expect(JSON.parse(ev.content)).toMatchObject({ success: true, restored_to: added[0]!.hash.slice(0, 8), reason: "avant patch", directory: proj, file: "src/app.py" });
    expect(await readFile(join(proj, "src", "app.py"), "utf-8")).toBe("def add(a, b):\n    return a - b\n");
    // Le retour a pris son propre point (« annuler l'annulation »).
    expect((await list(th))[0]!.reason).toBe(`avant retour à ${added[0]!.short_hash}`);
  }, 20_000);

  it("rien de neuf depuis le dernier point : pas de nouveau point ; fichier créé depuis le point : supprimé, copie dans snapshot", async () => {
    const th = (await client.createLocalSession({ cwd: proj })).thread_id;
    await fixTurn(th); // point « avant patch », le fichier passe à a + b
    await fixTurn(th); // nouveau point (a + b) ; le patch échoue (passage introuvable) : rien ne change
    const n = (await list(th)).length;
    await fixTurn(th); // son point serait identique au précédent : aucun
    expect((await list(th)).length).toBe(n);
    const cp = (await list(th))[0]!;
    await writeFile(join(proj, "src", "neuf.py"), "x = 1\n");
    const r = await client.callLocalTool(th, "checkpoint_restore", { hash: cp.hash, file: "src/neuf.py" });
    const id = (r as { approval_id: string }).approval_id;
    await client.decideLocalApproval(id, { decision: "approve", scope: "once" });
    const ev = (await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === id))) as { is_error: boolean; content: string };
    expect(ev.is_error).toBe(false);
    const res = JSON.parse(ev.content) as { snapshot: string };
    expect(res).toMatchObject({ success: true, restored_to: cp.hash.slice(0, 8), file: "src/neuf.py", deleted: true });
    await expect(readFile(join(proj, "src", "neuf.py"), "utf-8")).rejects.toThrow();
    // Le point « avant retour » garde la seule copie, lié au retour.
    const snap = (await list(th)).find((c) => c.hash === res.snapshot)!;
    expect(snap).toMatchObject({ reason: `avant retour à ${cp.short_hash}`, tool: "checkpoint_restore", thread_id: th });
    // Rétablir depuis le snapshot : le fichier revient.
    const back = await client.callLocalTool(th, "checkpoint_restore", { hash: res.snapshot, file: "src/neuf.py" });
    const id2 = (back as { approval_id: string }).approval_id;
    await client.decideLocalApproval(id2, { decision: "approve", scope: "once" });
    await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === id2));
    expect(await readFile(join(proj, "src", "neuf.py"), "utf-8")).toBe("x = 1\n");
    // Déjà absent : succès, deleted false.
    const gone = await client.callLocalTool(th, "checkpoint_restore", { hash: cp.hash, file: "src/jamais.py" });
    const id3 = (gone as { approval_id: string }).approval_id;
    await client.decideLocalApproval(id3, { decision: "approve", scope: "once" });
    const ev3 = (await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === id3))) as { content: string };
    expect(JSON.parse(ev3.content)).toMatchObject({ success: true, deleted: false });
  }, 20_000);

  it("checkpoint_create : {created, …point, thread_id, turn_index, tool} et checkpoint.created", async () => {
    const th = (await client.createLocalSession({ cwd: proj })).thread_id;
    const r = await client.callLocalTool(th, "checkpoint_create", { reason: "manuel" });
    const id = (r as { approval_id: string }).approval_id;
    await client.decideLocalApproval(id, { decision: "approve", scope: "once" });
    const ev = (await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === id))) as { content: string };
    const out = JSON.parse(ev.content) as { created: boolean; hash: string };
    expect(out).toMatchObject({ created: true, reason: "manuel", thread_id: th, turn_index: 0, tool: "checkpoint_create" });
    expect(events.some((e) => e.type === "checkpoint.created" && e.hash === out.hash)).toBe(true);
  });
});
