import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { accountMock, startMockServer, type MockServerHandle } from "../src/index.js";

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

describe("mon compte (contrat final de Nokker dev)", () => {
  it("profil, conditions acceptées et usage avec plafonds", async () => {
    const a = await c.getAccount();
    expect(a).toMatchObject({ status: "active", terms: { version: expect.any(String) } });
    const u = await c.getAccountUsage();
    expect(u.today.turns).toMatchObject({ used: 37, cap: 40, over: false, hard_cap: 150 });
    expect(u.mode).toBe("soft");
    expect(u.week).toMatchObject({ turns: { cap: 200, over: true } });
    expect(new Date(u.today.resets_at!).getUTCHours()).toBe(12);
    const wk = new Date(u.week!.resets_at);
    expect([wk.getUTCDay(), wk.getUTCHours()]).toEqual([1, 6]);
    expect(new Date(u.week!.starts).getTime()).toBe(wk.getTime() - 7 * 86_400_000);
    expect(u.today.browser).toBeUndefined();
    expect(u).not.toHaveProperty("today.deep");
    expect(u.plan).toBeNull();
  });

  it("locataire interne : cap null", async () => {
    accountMock(mock.state).internal = true;
    expect((await c.getAccountUsage()).today.turns.cap).toBeNull();
  });

  it("export synchrone : 202 ready avec téléchargement ; un second dans les 24 h → 429 export_limit + retry_at", async () => {
    const e = await c.startAccountExport();
    expect(e).toMatchObject({ status: "ready", size: expect.any(Number), download: `/v1/account/exports/${e.id}/download` });
    expect(Date.parse(e.expires_at) - Date.parse(e.created_at)).toBe(24 * 3600_000);
    expect(await c.getAccountExport(e.id)).toEqual(e);
    const file = await c.downloadAccountExport(e.id);
    expect(file.filename).toBe(`nokker-export-${e.id}.json`);
    expect(JSON.parse(file.json)).toMatchObject({ format: "nokker-account-export/1" });
    const again = await c.startAccountExport().catch((x) => x);
    expect(again.status).toBe(429);
    expect(again.code).toBe("export_limit");
    expect(again.retryAt).toBe(new Date(Date.parse(e.created_at) + 24 * 3600_000).toISOString());
  });

  it("export expiré : statut expired sans lien, téléchargement 410 export_expired, nouvelle demande acceptée", async () => {
    const e = await c.startAccountExport();
    accountMock(mock.state).exp = { id: e.id, created: Date.now() - 25 * 3600_000, expires: Date.now() - 3600_000 };
    expect(await c.getAccountExport(e.id)).toMatchObject({ status: "expired", download: null });
    const gone = await c.downloadAccountExport(e.id).catch((x) => x);
    expect([gone.status, gone.code]).toEqual([410, "export_expired"]);
    expect((await c.startAccountExport()).status).toBe("ready");
  });

  it("export d'un autre compte ou service non configuré", async () => {
    expect((await c.getAccountExport("ex_autre").catch((x) => x)).status).toBe(404);
    accountMock(mock.state).exportDisabled = true;
    const off = await c.startAccountExport().catch((x) => x);
    expect([off.status, off.code]).toEqual([503, "export_disabled"]);
  });

  it("suppression : 202 avec carte forte, une seule en attente (la même est rendue)", async () => {
    const r = await c.deleteAccount();
    expect(r).toMatchObject({ strength: "strong", reason: expect.any(String) });
    expect(Date.parse(r.expires_at)).toBeGreaterThan(Date.now());
    const ap = mock.state.approvals.get(r.approval_id);
    expect(ap).toMatchObject({ tool_name: "account_delete", strength: "strong", status: "pending" });
    expect((await c.deleteAccount()).approval_id).toBe(r.approval_id);
    expect([...mock.state.approvals.values()].filter((a) => a.tool_name === "account_delete")).toHaveLength(1);
  });

  it("carte de suppression accordée : le compte est suspendu tout de suite", async () => {
    const r = await c.deleteAccount();
    const ap = mock.state.approvals.get(r.approval_id)!;
    ap.status = "executed";
    const e = await c.getAccountUsage().catch((x) => x);
    expect([e.status, e.body]).toEqual([403, { error: { message: "forbidden" } }]);
  });

  it("compte suspendu : 403 forbidden partout, GET /v1/account et le reste de l'API compris (pas de code dédié)", async () => {
    accountMock(mock.state).deleting = true;
    for (const call of [() => c.getAccount(), () => c.getAccountUsage(), () => c.listThreads()]) {
      const e = await call().catch((x) => x);
      expect([e.status, e.body]).toEqual([403, { error: { message: "forbidden" } }]);
    }
  });
});

describe("abonnement", () => {
  it("sans abonnement : plans proposés, checkout, pas de portail", async () => {
    const b = await c.getBillingStatus();
    expect(b.plan).toBeNull();
    expect(b.plans.map((p) => p.id)).toEqual(["solo", "famille", "large"]);
    expect((await c.billingCheckout("solo")).url).toContain("solo");
    expect((await c.billingPortal().catch((e) => e)).status).toBe(404);
    expect((await c.billingCheckout("nope").catch((e) => e)).status).toBe(400);
  });

  it("abonné : état, portail, 409 already_subscribed ; les plafonds suivent la formule", async () => {
    Object.assign(accountMock(mock.state), { plan: "solo", status: "active" });
    expect(await c.getBillingStatus()).toMatchObject({ plan: "solo", status: "active", cancel_at_period_end: false });
    expect((await c.billingPortal()).url).toContain("stripe");
    expect((await c.billingCheckout("solo").catch((e) => e)).status).toBe(409);
    expect((await c.getAccountUsage()).today.turns.cap).toBe(40);
  });

  it("abonnement éteint côté noyau : 404 sur /v1/billing/*", async () => {
    accountMock(mock.state).billing = false;
    expect((await c.getBillingStatus().catch((e) => e)).status).toBe(404);
  });
});

describe("consentement d'entraînement", () => {
  it("jamais pré-coché, révocable, 400 sur un corps invalide", async () => {
    expect((await c.getAccount()).consents).toEqual({ training: false });
    expect(await c.setAccountConsent("training", true)).toEqual({ scope: "training", granted: true });
    expect((await c.getAccount()).consents.training).toBe(true);
    expect(await c.setAccountConsent("training", false)).toEqual({ scope: "training", granted: false });
    const bad = await c.setAccountConsent("nope" as "training", true).catch((e) => e);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "invalid" });
  });
});
