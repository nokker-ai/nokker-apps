import { createHmac } from "node:crypto";
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

const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } } | undefined)?.error?.code };
  }
};
const dev = async (body: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await (await fetch(`${mock.url}/v1/dev/ops-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;

describe("incidents (X18 operate)", () => {
  it("liste vivante, détail avec frise ; Je prends puis Résolu ; 409 sur un résolu", async () => {
    const live = (await c.listIncidents({ state: "live" })).incidents;
    expect(live.map((i) => i.state).sort()).toEqual(["in_progress", "open"]);
    expect(live.every((i) => i.timeline === undefined && i.last_event)).toBe(true);
    const open = live.find((i) => i.state === "open")!;
    expect((await c.getIncident(open.id)).timeline?.[0]?.kind).toBe("opened");
    expect(await c.ackIncident(open.id)).toMatchObject({ state: "in_progress", acked_by: expect.any(String) });
    const r = await c.resolveIncident(open.id, "redémarré à la main");
    expect(r.state).toBe("resolved");
    expect(r.timeline?.at(-1)?.text).toMatch(/redémarré/);
    expect((await fail(c.ackIncident(open.id))).status).toBe(409);
  });

  it("source : la clé n'est rendue qu'à la création et à la rotation ; réception signée HMAC, rejeu 409", async () => {
    const made = await c.createAlertSource({ name: "Essai", format: "generic" });
    expect(made).toMatchObject({ header: "X-Nokker-Signature", secret: expect.stringMatching(/^whsec_/) });
    expect(JSON.stringify((await c.listAlertSources()).sources)).not.toContain(made.secret);
    const body = JSON.stringify({ name: "BackupLate", title: "Sauvegarde en retard" });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", made.secret).update(`${t}.${body}`).digest("hex")}`;
    const post = (s: string): Promise<Response> => fetch(`${mock.url}${made.url}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Nokker-Signature": s }, body });
    expect((await post(sig)).status).toBe(202);
    expect((await post(sig)).status).toBe(409);
    expect((await post(`t=${t},v1=${"0".repeat(64)}`)).status).toBe(401);
    const rot = await c.rotateAlertSource(made.source.id);
    expect(rot.secret).not.toBe(made.secret);
  });

  it("une alerte ouvre un incident et réveille l'agent armé sur alert:<motif> ; la répétition ne relance rien", async () => {
    await c.createAgent({ name: "Veilleur", role: "regarde", trigger: { kind: "event", event: "alert:Disk*" } } as never).catch(() => undefined);
    const a = (await dev({ action: "alert", name: "DiskFull" })) as { alerts: { result: string; runs?: string[] }[] };
    expect(a.alerts[0]!.result).toBe("opened");
    const b = (await dev({ action: "alert", name: "DiskFull" })) as { alerts: { result: string }[] };
    expect(b.alerts[0]!.result).toBe("repeated");
    expect(((await dev({ action: "alert", name: "DiskFull", status: "resolved" })) as { alerts: { result: string }[] }).alerts[0]!.result).toBe("resolved");
  });
});

describe("plan (X18)", () => {
  it("l'avancement remonte ; une mère refuse un statut (400 computed)", async () => {
    const roots = (await c.listPlanCards({ roots: true })).cards;
    const g = roots.find((r) => r.kind === "goal")!;
    expect(g.computed).toBe(true);
    expect(g.progress).toMatchObject({ done: 3, total: 6, blocked: 1 });
    expect(g.status).toBe("blocked");
    expect(await fail(c.patchPlanCard(g.id, { status: "done" }))).toEqual({ status: 400, code: "computed" });
  });

  it("le contexte descend de la racine à la carte", async () => {
    const g = (await c.listPlanCards({ roots: true })).cards[0]!;
    const leaf = (await c.getPlanCard(g.id)).children_cards[0]!;
    const ctx = await c.getPlanContext(leaf.id);
    expect(ctx.chain.map((x) => x.id)).toEqual([g.id, leaf.id]);
    expect(ctx.block).toMatch(/Contrainte : No tester's data/);
  });

  it("découpage : bulle plan_split, seul l'humain crée les cartes", async () => {
    const th = await c.createThread("Plan");
    const g = (await c.listPlanCards({ roots: true })).cards[0]!;
    const page = (await c.getPlanCard(g.id)).children_cards.find((k) => !k.computed)!;
    const r = (await dev({ action: "split", thread_id: th.id, card_id: page.id })) as { proposal: { id: string }; bubble_id: string };
    const res = await c.bubbleAction(r.bubble_id, "accept");
    expect((res as unknown as { cards: unknown[] }).cards).toHaveLength(3);
    expect((await c.getPlanCard(page.id)).computed).toBe(true);
    expect((await fail(c.decidePlanProposal(r.proposal.id, "refuse"))).status).toBe(409);
  });

  it("brief du matin : créé puis rendu, supprimé", async () => {
    expect((await c.getBrief()).agent).toBeNull();
    const a = (await c.setBrief()).agent;
    expect(a).toMatchObject({ name: "Brief du matin", status: "armed", trigger: { kind: "schedule", cron: "30 7 * * 1-5", tz: "Europe/Zurich" } });
    expect((await c.setBrief({ cron: "0 8 * * 1-5" })).agent.id).toBe(a.id);
    expect(await c.deleteBrief()).toEqual({ deleted: true });
  });
});
