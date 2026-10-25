import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
});
afterEach(async () => {
  await mock.close();
});

const seed = async (body: Record<string, unknown> = {}): Promise<string> => {
  const r = await fetch(`${mock.url}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return ((await r.json()) as { user_code: string }).user_code;
};
const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof NokkerApiError ? e.status : -1;
  }
};

describe("page /link (flux d'appareil)", () => {
  it("sans session : 401", async () => {
    expect(await status(c.getLinkPending("AAAA-BBBB"))).toBe(401);
    expect(await status(c.decideLink("AAAA-BBBB", "approve"))).toBe(401);
  });

  it("pending montre la machine sans effet de bord ; approve la lie", async () => {
    await c.demoSessionMockExtension();
    const code = await seed({ machine: "Atelier" });
    expect(await c.getLinkPending(code.toLowerCase())).toMatchObject({ machine_name: "Atelier", expires_in: expect.any(Number) });
    expect(await c.getLinkPending(code)).toMatchObject({ machine_name: "Atelier" });
    expect(await c.decideLink(code, "approve")).toMatchObject({ state: "approved", machine_id: expect.any(String), host: expect.any(String) });
    expect(await status(c.getLinkPending(code))).toBe(404);
  });

  it("refuser : denied, le code est consommé", async () => {
    await c.demoSessionMockExtension();
    const code = await seed();
    expect(await c.decideLink(code, "deny")).toEqual({ state: "denied" });
    expect(await status(c.decideLink(code, "approve"))).toBe(404);
  });

  it("code inconnu ou expiré : 404 (pas d'oracle) ; rate : 429 une fois", async () => {
    await c.demoSessionMockExtension();
    expect(await status(c.getLinkPending("ZZZZ-ZZZZ"))).toBe(404);
    const old = await seed({ expires_in: -1 });
    expect(await status(c.getLinkPending(old))).toBe(404);
    const code = await seed({ rate: true });
    expect(await status(c.getLinkPending(code))).toBe(429);
    expect(await status(c.getLinkPending(code))).toBe(200);
  });
});

describe("mes machines", () => {
  it("sans session : 401", async () => {
    expect(await status(c.listMachines())).toBe(401);
    expect(await status(c.revokeMachine("mc_x"))).toBe(401);
  });

  it("une machine approuvée par /link apparaît ; la délier la retire", async () => {
    await c.demoSessionMockExtension();
    expect((await c.listMachines()).machines).toEqual([]);
    const code = await seed({ machine: "Atelier" });
    const { machine_id } = await c.decideLink(code, "approve");
    const { machines } = await c.listMachines();
    expect(machines).toEqual([
      { machine_id, name: "Atelier", host: expect.stringMatching(/^atelier\./), created_at: expect.any(Number), last_seen_at: null },
    ]);
    expect(await c.revokeMachine(machine_id!)).toEqual({ revoked: true });
    expect((await c.listMachines()).machines).toEqual([]);
    expect(await status(c.revokeMachine(machine_id!))).toBe(404);
  });

  it("deux machines du même nom : hôtes distincts ; machine inconnue : 404", async () => {
    await c.demoSessionMockExtension();
    await seed({ linked: true, machine: "Atelier", last_seen_s: 30 });
    await seed({ linked: true, machine: "Atelier" });
    const { machines } = await c.listMachines();
    expect(new Set(machines.map((m) => m.host)).size).toBe(2);
    expect(machines[0]!.last_seen_at).toBeGreaterThan(Date.now() / 1000 - 60);
    expect(await status(c.revokeMachine("mc_inconnue"))).toBe(404);
  });
});

describe("approbation forte à distance", () => {
  const proof = { device_id: "dev_1", webauthn_client_data_json: "a", webauthn_authenticator_data: "b", webauthn_signature: "c" };
  it("lire, décider (forwarded puis verdict du « Lokkal »), pas deux fois", async () => {
    await c.demoSessionMockExtension();
    const r = await fetch(`${mock.url}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linked: true, approval: true }) });
    const { machine_id, approval_id } = (await r.json()) as { machine_id: string; approval_id: string };
    const a = await c.getMachineApproval(machine_id, approval_id);
    expect(a).toMatchObject({ approval_id, status: "pending", strength: "strong", challenge: expect.any(String) });
    expect(await status(c.decideMachineApproval(machine_id, approval_id, "approve", { ...proof, webauthn_signature: "" }))).toBe(400);
    expect(await status(c.decideMachineApproval(machine_id, approval_id, "deny" as "reject", proof))).toBe(400);
    // Carte forte : la clé simple seule est refusée (X10), la passkey passe.
    expect(await status(c.decideMachineApproval(machine_id, approval_id, "reject", { device_id: "dev_1", signature: "sig" }))).toBe(403);
    expect(await c.decideMachineApproval(machine_id, approval_id, "reject", proof)).toEqual({ status: "forwarded" });
    expect(await status(c.decideMachineApproval(machine_id, approval_id, "approve", proof))).toBe(409);
    await new Promise((res) => setTimeout(res, 1700));
    const final = await c.getMachineApproval(machine_id, approval_id);
    expect(final.status).toBe("rejected");
    expect(final.summary).toMatchObject({ erased: true, lines: [] });
    expect(await status(c.getMachineApproval("mc_autre", approval_id))).toBe(404);
  });

  it("X20c : carte d'un connecteur relayé, résumé de nokker.ai (ligne par ligne)", async () => {
    await c.demoSessionMockExtension();
    const r = await fetch(`${mock.url}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linked: true, approval: true, approval_kind: "mail" }) });
    const { machine_id, approval_id } = (await r.json()) as { machine_id: string; approval_id: string };
    const a = await c.getMachineApproval(machine_id, approval_id);
    expect(a).toMatchObject({ summary_source: "nokker.ai", summary: { class: "external_send", headline: expect.any(String), erased: false }, args_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(a.summary!.lines.map((l) => l.key)).toEqual(["to", "subject", "body"]);
  });
});
