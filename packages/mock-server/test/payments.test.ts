import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, generateDeviceKeyPair, signChallenge, type Approval, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot(payments: boolean, household: "off" | "payer" | "member" = "payer") {
  const m = await startMockServer({ speed: 0.01, payments, household, configDir: null });
  mock = m;
  const client = new NokkerClient({ baseUrl: m.url });
  const keys = await generateDeviceKeyPair();
  const dev = await client.enrollDevice({ name: "test", public_key_spki: keys.publicKeySpkiB64Url });
  const { challenge } = await client.requestSessionChallenge(dev.id);
  await client.createSession({ device_id: dev.id, challenge, signature: await signChallenge(keys.privateKey, challenge, "login") });
  const events: NokkerEvent[] = [];
  const sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 100));
  return { client, keys, dev, events, close: () => sub.close() };
}
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) throw e;
    const b = (e.body as { error?: { code?: string; message?: string } }).error;
    return { status: e.status, ...(b?.code ? { code: b.code } : {}), ...(b?.message ? { message: b.message } : {}) };
  }
};

describe("payments « à payer » + budgets (PAYMENTS §5)", () => {
  it("flag off: 404 everywhere", async () => {
    const { client, close } = await boot(false);
    expect((await status(client.getPaymentBudgets())).status).toBe(404);
    expect((await status(client.listPayCards())).status).toBe(404);
    close();
  });

  it("budgets: the payer sees every member; default, set, none; payer-only writes; caps ordered", async () => {
    const { client, close } = await boot(true);
    const v = await client.getPaymentBudgets();
    expect(v).toMatchObject({ is_payer: true, timezone: "Europe/Zurich" });
    expect(v.members.map((m) => [m.account, m.role, m.source, m.can_spend])).toEqual([
      ["alice", "payer", "default", true],
      ["sam", "member", "set", true],
      ["lea", "minor", "none", false],
    ]);
    expect(v.members[0]!.budget).toMatchObject({ currency: "CHF", per_purchase_minor: 20000, per_day_minor: 30000, per_month_minor: 100000 });
    expect(v.members[0]!.spent_month_minor).toBeGreaterThanOrEqual(0);
    const lea = await client.putPaymentBudget("lea", { currency: "chf", per_purchase: "20", per_day: "20", per_month: "49.90", minor_allowed: true });
    expect(lea).toMatchObject({ source: "set", can_spend: true, budget: { currency: "CHF", per_month_minor: 4990, minor_allowed: true } });
    expect(await status(client.putPaymentBudget("sam", { currency: "CHF", per_purchase: 100, per_day: 50, per_month: 400 }))).toMatchObject({ status: 400, code: "invalid" });
    expect(await status(client.putPaymentBudget("sam", { currency: "CHF", per_purchase: "0", per_day: 50, per_month: 400 }))).toMatchObject({ status: 400, code: "invalid" });
    expect(await status(client.putPaymentBudget("nobody", { currency: "CHF", per_purchase: 1, per_day: 1, per_month: 1 }))).toMatchObject({ status: 404 });
    expect(await client.resetPaymentBudget("sam")).toMatchObject({ source: "none", budget: null, can_spend: false });
    close();
  });

  it("no household: the account alone, payer of itself; a household member sees only their line and writes nothing", async () => {
    const solo = await boot(true, "off");
    expect((await solo.client.getPaymentBudgets()).members.map((m) => [m.account, m.role, m.source])).toEqual([["alice", "payer", "default"]]);
    solo.close();
    await mock?.close();
    const member = await boot(true, "member");
    const v = await member.client.getPaymentBudgets();
    expect(v).toMatchObject({ is_payer: false, members: [{ account: "alice", role: "member", source: "none", can_spend: false }] });
    expect(await status(member.client.putPaymentBudget("alice", { currency: "CHF", per_purchase: 1, per_day: 1, per_month: 1 }))).toMatchObject({ status: 403, code: "payer_only" });
    member.close();
  });

  it("history: a signed mandate verifies; its detail carries the mandate, never a card number", async () => {
    const { client, close } = await boot(true);
    const [past] = (await client.listPayCards()).mandates;
    expect(past).toMatchObject({ status: "signed", merchant: "Librairie du Lac", amount: "34.50 CHF", handoff: { kind: "browser" } });
    const d = await client.getMandate(past!.mandate_id);
    expect(d.envelope).not.toBeNull();
    expect(d.mandate).toMatchObject({ format: "nokker.mandate.v1", human_pays: true });
    expect(JSON.stringify(d)).not.toMatch(/cvv|card_number|pan|3ds/i);
    expect(await client.verifyMandate(past!.mandate_id)).toMatchObject({ valid: true, checks: { signature: true, device_key_trusted: true }, errors: [] });
    close();
  });

  it("« achète » → strong « to pay » card; the challenge carries mandate_sha256; a device signature cannot approve; rejecting releases it", async () => {
    const { client, keys, dev, events, close } = await boot(true);
    const thread = (await client.createThread("pay")).id;
    await client.chatCompletion(thread, [{ role: "user", content: "achète des cartouches d'encre" }]);
    const req = await until(() => events.find((e) => e.type === "approval.requested") as { approval: Approval } | undefined);
    const toPay = await until(() => events.find((e) => e.type === "payment.to_pay"));
    expect(req.approval).toMatchObject({ rule: "payments:to_pay", tool_name: "pay_request", strength: "strong" });
    expect(toPay).toMatchObject({ approval_id: req.approval.id, status: "pending", amount: "59.80 CHF", thread_id: thread });
    const { challenge } = await client.requestChallenge(req.approval.id);
    expect(JSON.parse(challenge).mandate_sha256).toBe((toPay as { mandate_sha256: string }).mandate_sha256);
    const approve = await status(client.decideApproval(req.approval.id, { decision: "approve", device_id: dev.id, challenge, signature: await signChallenge(keys.privateKey, challenge, "approve") }));
    expect(approve).toMatchObject({ status: 403, message: expect.stringContaining("passkey") });
    const { challenge: c2 } = await client.requestChallenge(req.approval.id);
    const r = await client.decideApproval(req.approval.id, { decision: "reject", device_id: dev.id, challenge: c2, signature: await signChallenge(keys.privateKey, c2, "reject") });
    expect(r.status).toBe("rejected");
    await until(() => events.find((e) => e.type === "payment.rejected"));
    expect((await client.listPayCards()).mandates[0]).toMatchObject({ status: "rejected" });
    close();
  });

  it("above the per-purchase cap: refused before any card, with the core's sentence", async () => {
    const { client, events, close } = await boot(true);
    const thread = (await client.createThread("pay")).id;
    await client.chatCompletion(thread, [{ role: "user", content: "achète un vélo" }]);
    const ref = await until(() => events.find((e) => e.type === "payment.refused"));
    expect(ref).toMatchObject({ rule: "payments:budget", reason: "dépense refusée : 849.00 CHF dépasse le plafond par achat (200.00 CHF).", merchant: "Cycles Léman" });
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
    close();
  });
});
