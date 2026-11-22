import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock.close();
  delete process.env.MOCK_GATEWAY_TOKEN;
});

describe("liste unique (deck v2, passerelle, recherche)", () => {
  it("deck v2 : fils des machines, titres sous la règle du miroir ; jeton de passerelle pour un hôte lié", async () => {
    process.env.MOCK_GATEWAY_TOKEN = "gw_test";
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const dev = (b: object) => fetch(`${mock.url}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await dev({ linked: true, machine: "atelier", last_seen_s: 3, host: "127.0.0.1:9", mirror: true });
    await dev({ linked: true, machine: "bureau", last_seen_s: 3600 });
    const deck = await c.getDeck();
    expect(deck.v).toBe(2);
    const [a, b] = deck.machines;
    expect(a).toMatchObject({ name: "atelier", online: true, mirror: true, host: "127.0.0.1:9" });
    expect(a!.threads!.map((t) => t.title)).toEqual(["site", "Factures"]);
    expect(b).toMatchObject({ name: "bureau", online: false, mirror: false });
    expect(b!.threads!.every((t) => t.title === null)).toBe(true);
    expect(await c.gatewayAccessToken("127.0.0.1:9")).toEqual({ access_token: "gw_test", expires_in: 900 });
    expect(await c.gatewayAccessToken("inconnu.example").catch((e) => (e as NokkerApiError).status)).toBe(404);
    // Le même mock, vu comme la machine : ce jeton est le propriétaire relayé.
    const asMachine = new NokkerClient({ baseUrl: mock.url, token: "gw_test" });
    expect(Array.isArray(await asMachine.listThreads())).toBe(true);
  });
  it("continuer dans le cloud : nouveau fil amorcé par la copie du miroir ; 404 not_mirrored sans copie", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    await fetch(`${mock.url}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linked: true, machine: "bureau", last_seen_s: 3600, mirror: true }) });
    const mc = (await c.getDeck()).machines[0]!;
    const copyId = `lokkal-${mc.machine_id}-th_${mc.machine_id}_site`;
    expect((await c.listThreads()).some((t) => t.id === copyId)).toBe(true);
    const r = await c.continueInCloud({ machine_id: mc.machine_id, thread_id: `th_${mc.machine_id}_site` });
    expect(r.title).toBe("suite de « site » (bureau)");
    const v = await c.getThread(r.thread_id);
    expect(v.messages.map((m) => m.content).join(" ")).toMatch(/copie du miroir de bureau/);
    const code = await c.continueInCloud({ machine_id: mc.machine_id, thread_id: "th_inconnu" }).catch((e) => ((e as NokkerApiError).body as { error: { code: string } }).error.code);
    expect(code).toBe("not_mirrored");
  });
  it("recherche : titres et tours, sans accents ni casse, extrait, tri par date ; 400 bad_query", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const t = await c.createThread("Facturé en été");
    const r = await c.searchThreads("facture");
    expect(r.results.some((x) => x.thread_id === t.id && x.turn_index === null)).toBe(true);
    expect(await c.searchThreads("x").catch((e) => ((e as NokkerApiError).body as { error: { code: string } }).error.code)).toBe("bad_query");
  });
});
