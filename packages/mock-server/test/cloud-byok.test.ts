import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { accountMock, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
const code = (e: unknown): string | undefined => (e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined);

beforeEach(async () => {
  process.env.MOCK_CLOUD_BYOK = "1";
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
});
afterEach(async () => {
  delete process.env.MOCK_CLOUD_BYOK;
  await mock.close();
});

describe("BYOK cloud (docs/CLOUD-BYOK.md)", () => {
  it("sans droit : GET marche, PUT et test en 403 plan_required", async () => {
    expect(await c.getAccountModels()).toEqual({ default: "router", effective: "router", entitled: false, router_included: true, byok: [] });
    await expect(c.testAccountModel({ base_url: "https://api.example.com/v1" })).rejects.toSatisfy((e) => code(e) === "plan_required");
    await expect(c.putAccountModels({ default: "router", byok: [] })).rejects.toSatisfy((e) => code(e) === "plan_required");
  });

  it("avec Solo : essai, enregistrement, clé jamais relue, défaut effectif", async () => {
    accountMock(mock.state).plan = "solo";
    const t = await c.testAccountModel({ base_url: "https://api.example.com/v1", api_key: "sk-test", model: "demo-small" });
    expect(t).toMatchObject({ ok: true, models: ["demo-small", "demo-large"], model_listed: true });
    const m = await c.putAccountModels({ default: "byok:api-example-com", byok: [{ name: "api-example-com", base_url: "https://api.example.com/v1/", model: "demo-small", api_key: "sk-test" }] });
    expect(m).toMatchObject({ default: "byok:api-example-com", effective: "byok:api-example-com", entitled: true });
    expect(m.byok[0]).toMatchObject({ base_url: "https://api.example.com/v1", has_key: true, ok: true });
    expect(JSON.stringify(m)).not.toContain("sk-test");
    accountMock(mock.state).plan = null;
    expect(await c.getAccountModels()).toMatchObject({ default: "byok:api-example-com", effective: "router", entitled: false });
  });

  it("Famille et Large incluent le BYOK (cloud_byok.plans)", async () => {
    for (const plan of ["famille", "large"]) {
      accountMock(mock.state).plan = plan;
      expect((await c.getAccountModels()).entitled).toBe(true);
    }
  });

  it("la clé ne suit pas un changement d'hôte ; même hôte, elle reste", async () => {
    accountMock(mock.state).plan = "byok";
    await c.putAccountModels({ byok: [{ name: "k", base_url: "https://a.example.com/v1", model: "m", api_key: "sk-1" }] });
    let m = await c.putAccountModels({ byok: [{ name: "k", base_url: "https://a.example.com/v2", model: "m" }] });
    expect(m.byok[0]!.has_key).toBe(true);
    m = await c.putAccountModels({ byok: [{ name: "k", base_url: "https://b.example.com/v1", model: "m" }] });
    expect(m.byok[0]!.has_key).toBe(false);
  });

  it("refus : http, adresse privée, nom, défaut sans entrée, 9 entrées", async () => {
    accountMock(mock.state).plan = "byok";
    const put = (body: Parameters<NokkerClient["putAccountModels"]>[0]) => c.putAccountModels(body).then(() => "ok", (e) => code(e));
    expect(await put({ byok: [{ name: "k", base_url: "http://api.example.com", model: "m" }] })).toBe("bad_base_url");
    expect(await put({ byok: [{ name: "k", base_url: "https://192.168.1.4/v1", model: "m" }] })).toBe("blocked_address");
    expect(await put({ byok: [{ name: "-k", base_url: "https://api.example.com", model: "m" }] })).toBe("bad_name");
    expect(await put({ default: "byok:absent", byok: [] })).toBe("bad_default");
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `k${i}`, base_url: `https://h${i}.example.com`, model: "m" }));
    expect(await put({ byok: nine })).toBe("bad_byok");
  });

  it("formule byok : pas de Router, « none » tant qu'aucun modèle n'est utilisable", async () => {
    accountMock(mock.state).plan = "byok";
    expect(await c.getAccountModels()).toMatchObject({ router_included: false, effective: "none" });
    await expect(c.putAccountModels({ default: "router" })).rejects.toSatisfy((e) => code(e) === "bad_default");
    const m = await c.putAccountModels({ default: "byok:k", byok: [{ name: "k", base_url: "https://a.example.com/v1", model: "m", api_key: "sk-1" }] });
    expect(m).toMatchObject({ effective: "byok:k", router_included: false });
  });

  it("drapeau éteint : 404", async () => {
    delete process.env.MOCK_CLOUD_BYOK;
    await expect(c.getAccountModels()).rejects.toSatisfy((e) => e instanceof NokkerApiError && e.status === 404);
  });
});

describe("capacités (MOCK_CAPABILITIES=1)", () => {
  it("éteint : 404 ; allumé : version 1, mode cloud, clés triées", async () => {
    await expect(c.getCapabilities()).rejects.toSatisfy((e) => e instanceof NokkerApiError && e.status === 404);
    process.env.MOCK_CAPABILITIES = "1";
    try {
      const k = await c.getCapabilities();
      expect(k).toMatchObject({ version: 1, mode: "cloud" });
      expect(k.features.cloud_byok).toBe(true);
      expect(k.features.local_cost).toBe(false);
      expect(Object.keys(k.features)).toEqual([...Object.keys(k.features)].sort());
    } finally {
      delete process.env.MOCK_CAPABILITIES;
    }
  });
});
