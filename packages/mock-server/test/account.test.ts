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

  it("export asynchrone : pending puis ready ; un second export le même jour → 429 rate", async () => {
    const s = await c.startAccountExport();
    expect(s.status).toBe("pending");
    expect((await c.getAccountExport(s.id)).status).toBe("pending");
    const ready = await c.getAccountExport(s.id);
    expect(ready.status).toBe("ready");
    expect(ready.download_url).toContain(s.id);
    const again = await c.startAccountExport().catch((e) => e);
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: "rate" });
  });

  it("suppression : 202 avec une carte d'approbation account.delete forte", async () => {
    const r = await c.deleteAccount();
    const ap = mock.state.approvals.get(r.approval_id);
    expect(ap).toMatchObject({ tool_name: "account.delete", strength: "strong", status: "pending" });
  });

  it("compte en suppression : 403 account_deleting partout", async () => {
    accountMock(mock.state).deleting = true;
    const e = await c.getAccountUsage().catch((x) => x);
    expect(e.status).toBe(403);
    expect(e.body).toEqual({ error: "account_deleting" });
  });
});

describe("abonnement", () => {
  it("sans abonnement : plans proposés, checkout, pas de portail", async () => {
    const b = await c.getBillingStatus();
    expect(b.plan).toBeNull();
    expect(b.plans.map((p) => p.id)).toEqual(["essentiel", "solo"]);
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
