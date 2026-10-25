import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
});
afterEach(async () => {
  await mock.close();
});
const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof NokkerApiError ? e.status : -1;
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Crew avec moteur (§9.5, X14)", () => {
  it("création : manual → armed, planifié → paused ; trigger invalide → 400", async () => {
    const a = await c.createAgent({ name: "A", role: "r" });
    expect(a).toMatchObject({ status: "armed", trigger: { kind: "manual" } });
    const b = await c.createAgent({ name: "B", role: "r", trigger: { kind: "schedule", cron: "0 7 * * 1-5", tz: "Europe/Zurich" } });
    expect(b.status).toBe("paused");
    expect(await status(c.createAgent({ name: "C", role: "r", trigger: { kind: "event", event: "nimporte" } }))).toBe(400);
  });

  it("armer, désarmer ; écriture levée → 202 approval_id ; PATCH d'un agent armé le remet au repos", async () => {
    const b = await c.createAgent({ name: "B", role: "r", trigger: { kind: "schedule", cron: "0 7 * * *", tz: "UTC" } });
    const armed = (await c.armAgent(b.id)) as { status: string; next_run_at: string | null };
    expect(armed.status).toBe("armed");
    expect(armed.next_run_at).toEqual(expect.any(String));
    expect((await c.patchAgent(b.id, { tools: ["x"] })).status).toBe("paused");
    expect((await c.disarmAgent(b.id)).status).toBe("paused");
    // Manuel AVEC une règle d'écriture : naît au repos ; armer rend la carte forte (la même au second appel).
    const w = await c.createAgent({ name: "W", role: "r", auto_approve: ["write_file(*)"] });
    expect(w.status).toBe("paused");
    const first = (await c.armAgent(w.id)) as { approval_id: string; agent: { arm_approval_id: string } };
    expect(first).toMatchObject({ approval_id: expect.stringMatching(/^appr_/), agent: { arm_approval_id: first.approval_id } });
    expect(((await c.armAgent(w.id)) as { approval_id: string }).approval_id).toBe(first.approval_id);
  });

  it("lancer : running puis succeeded dans son fil, pas deux à la fois", async () => {
    // Vitesse réelle : le passage simulé dure ~3 s, assez pour voir le 409 du second lancement.
    await mock.close();
    mock = await startMockServer({ speed: 0.5 }); // passage de ~1,5 s : assez de marge sous charge
    c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const a = await c.createAgent({ name: "A", role: "r" });
    const { run_id } = await c.runAgent(a.id);
    expect((await c.listAgents()).find((x) => x.id === a.id)!.status).toBe("running");
    expect(await status(c.runAgent(a.id))).toBe(409);
    await wait(1800);
    const page = await c.listAgentRuns(a.id);
    expect(page.runs[0]).toMatchObject({ run_id, status: "succeeded", thread_id: expect.any(String), cost: expect.any(Object) });
    const after = (await c.listAgents()).find((x) => x.id === a.id)!;
    expect(after).toMatchObject({ status: "armed", last_run: { run_id, status: "succeeded" } });
    // §9.5 : le fil du passage porte son origine (le web le range sous l'agent).
    const runThread = (await c.listThreads()).find((t) => t.id === page.runs[0]!.thread_id)!;
    expect(runThread.origin).toEqual({ kind: "agent", agent_id: a.id, run_id });
  });

  it("annuler un passage, supprimer un agent (204), agent inconnu 404", async () => {
    const a = await c.createAgent({ name: "A", role: "r" });
    const { run_id } = await c.runAgent(a.id);
    expect((await c.cancelAgentRun(a.id, run_id)).status).toBe("cancelled");
    await c.deleteAgent(a.id);
    expect((await c.listAgents()).some((x) => x.id === a.id)).toBe(false);
    expect(await status(c.runAgent(a.id))).toBe(404);
  });

  it("démo : un agent par état, avec passages", async () => {
    const m2 = await startMockServer({ speed: 0.01, seed: true });
    try {
      const c2 = new NokkerClient({ baseUrl: m2.url });
      await c2.demoSessionMockExtension();
      const list = await c2.listAgents();
      expect(new Set(list.map((a) => a.status))).toEqual(new Set(["paused", "armed", "failed"]));
      const failed = list.find((a) => a.status === "failed")!;
      expect((await c2.listAgentRuns(failed.id, { limit: 2 })).next_before).toEqual(expect.any(String));
    } finally {
      await m2.close();
    }
  });
});

describe("deck multi-machines (§7.19, X15)", () => {
  const seedMachine = async (machine: string, last_seen_s?: number) => {
    const r = await fetch(`${mock.url}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linked: true, machine, ...(last_seen_s !== undefined ? { last_seen_s } : {}) }) });
    return ((await r.json()) as { machine_id: string }).machine_id;
  };

  it("machines triées par nom, charge et sessions en ligne seulement, agents placés sous leur machine", async () => {
    const atelier = await seedMachine("Atelier", 5);
    const portable = await seedMachine("Portable"); // jamais vue : hors ligne
    const a = await c.createAgent({ name: "A", role: "r" });
    await c.moveAgent(a.id, atelier);
    const deck = await c.getDeck();
    expect(deck.machines.map((m) => m.name)).toEqual(["Atelier", "Portable"]);
    const [at, po] = deck.machines;
    expect(at).toMatchObject({ machine_id: atelier, online: true, load: { ram: expect.any(Object) } });
    expect(at!.agents.map((x) => x.id)).toContain(a.id);
    expect(po).toMatchObject({ machine_id: portable, online: false, load: null, sessions: [] });
    expect(deck.web.agents.some((x) => x.id === a.id)).toBe(false);
  });

  it("déménagement : 409 avec ce qui manque (machine hors ligne, secret vers web)", async () => {
    const portable = await seedMachine("Portable");
    const a = await c.createAgent({ name: "A", role: "r", secrets: ["CLE_API"] });
    const e1 = await c.moveAgent(a.id, portable).catch((x: unknown) => x as NokkerApiError);
    expect((e1 as NokkerApiError).status).toBe(409);
    expect(((e1 as NokkerApiError).body as { error: { missing: { kind: string }[] } }).error.missing[0]!.kind).toBe("machine");
    const e2 = await c.moveAgent(a.id, "web").catch((x: unknown) => x as NokkerApiError);
    expect(((e2 as NokkerApiError).body as { error: { missing: { kind: string; name: string }[] } }).error.missing[0]).toMatchObject({ kind: "secret", name: "CLE_API" });
    expect(await status(c.moveAgent(a.id, "nulle-part"))).toBe(400);
  });
});
