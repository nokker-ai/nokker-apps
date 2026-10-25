import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, type Bubble } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock?.close();
});
async function boot(packsWeb: boolean): Promise<NokkerClient> {
  mock = await startMockServer({ speed: 0.01, packsWeb });
  const c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
  return c;
}
const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body?: Record<string, unknown> }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    const err = (e.body as { error?: Record<string, unknown> }).error;
    return { status: e.status, code: err?.code as string | undefined, body: err };
  }
};

describe("packs d'agents (§7.30)", () => {
  it("drapeau packs_web éteint : 404", async () => {
    const c = await boot(false);
    expect((await fail(c.listPacks())).status).toBe(404);
  });

  it("catalogue : ce qui va au web et ce qui reste à la machine", async () => {
    const c = await boot(true);
    const { packs } = await c.listPacks();
    const ops = packs.find((p) => p.name === "ops")!;
    expect(ops.web).toEqual({ skills: ["incident-notes"], agents: ["incident-scribe"] });
    expect(ops.machine).toEqual({ skills: ["runbook-ssh"], agents: [{ template: "ops-watch", needs: [{ kind: "mcp", name: "monitoring" }] }] });
    const d = await c.getPack("ops");
    expect(d.skills.find((s) => s.name === "runbook-ssh")?.locality).toBe("local");
    expect(d.installed).toBe(false);
  });

  it("installer avec un fil : cartes agent_draft, rien d'armé ; partiel avec relais vers la machine", async () => {
    const c = await boot(true);
    const th = (await c.createThread("Packs")).id;
    const r = await c.installPack("ops", { thread_id: th, handoff: true });
    expect(r).toMatchObject({ installed: "ops", skills: ["incident-notes"], armed: [], partial: true });
    expect(r.proposed.map((p) => p.template)).toEqual(["incident-scribe"]);
    expect(r.machine).toMatchObject({ skills: ["runbook-ssh"], linked: [{ name: "host-1", online: true }], handoff: { machine_name: "host-1" } });
    const draft = await c.getBubble(r.proposed[0]!.bubble_id);
    expect(draft.state).toMatchObject({ pack: "ops", template: "incident-scribe" });
    expect((await c.getPack("ops")).install?.templates).toEqual(["incident-scribe"]);
  });

  it("sans fil : à proposer ensuite ; machine_only, scan_refused, fil inconnu", async () => {
    const c = await boot(true);
    const r = await c.installPack("mail");
    expect(r.proposed).toEqual([]);
    expect(r.to_propose?.map((t) => t.template)).toEqual(["mail-digest"]);
    expect(r.setup?.[0]).toMatch(/mail, calendar/);
    const th = (await c.createThread("Packs")).id;
    expect((await c.proposePack("mail", { thread_id: th })).proposed.map((p) => p.template)).toEqual(["mail-digest"]);
    const mo = await fail(c.installPack("mcp-builder"));
    expect(mo).toMatchObject({ status: 409, code: "machine_only" });
    expect((mo.body?.machine as { next: string }).next).toMatch(/Lokkal/);
    expect(await fail(c.installPack("video"))).toMatchObject({ status: 422, code: "scan_refused" });
    expect(await fail(c.installPack("mail", { thread_id: "th_inconnu" }))).toMatchObject({ status: 404, code: "unknown_thread" });
  });

  it("retirer : cartes ouvertes fermées, agents créés gardés, carte pack_agents décidée en direct", async () => {
    const c = await boot(true);
    const th = (await c.createThread("Packs")).id;
    const r = await c.installPack("mail", { thread_id: th });
    const act = (await c.bubbleAction(r.proposed[0]!.bubble_id, "activate")) as unknown as { agent: { id: string; origin: unknown } };
    expect(act.agent.origin).toEqual({ pack: "mail", template: "mail-digest" });
    const again = await c.proposePack("mail", { thread_id: th }); // modèle déjà créé : rien à reproposer
    expect(again.proposed).toEqual([]);
    const rm = await c.removePack("mail", th);
    expect(rm).toMatchObject({ removed: "mail", already_removed: false, agents: [{ id: act.agent.id, armed: true }] });
    const card = (await c.getBubble(rm.card!)) as Bubble;
    expect(card.kind).toBe("pack_agents");
    expect(card.actions.map((a) => a.id)).toEqual(["disarm", "delete", "keep"]);
    const d = (await c.bubbleAction(card.id, "disarm")) as unknown as Record<string, unknown>;
    expect(d).toEqual({ closed: true, disarmed: [act.agent.id] });
    expect((await c.getAgent(act.agent.id)).status).toBe("paused");
    expect((await c.removePack("mail", th)).already_removed).toBe(true); // idempotent
  });

  it("Lokkal : liste et retrait au jeton local", async () => {
    await boot(false);
    const l = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
    expect((await l.listLocalPacks()).packs.find((p) => p.name === "mail")?.installed).toBe(true);
    const r = await l.removeLocalPack("mail");
    expect(r).toMatchObject({ removed: "mail", already_removed: false, card: null });
    expect((await l.removeLocalPack("mail")).already_removed).toBe(true);
    expect((await fail(l.removeLocalPack("inconnu"))).status).toBe(404);
  });
});
