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
    return { status: e.status, code: (e.body as { error?: { code?: string } }).error?.code };
  }
};
const byName = async (name: string) => (await c.listProjects()).projects.find((p) => p.name === name)!;
const ops = (b: unknown) => fetch(`${mock.url}/v1/dev/ops-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

describe("budget, agents des membres, journal (§7.27)", () => {
  it("budget : fenêtres, une ligne par membre (anciens compris) pour l'owner, plafond posé et journalisé", async () => {
    const s = await byName("Marketing site");
    const v = await c.getProjectBudget(s.id);
    expect(v).toMatchObject({ counted: true, tz: "Europe/Zurich", month: { cap: 50, state: "warning" }, today: { state: "none" } });
    expect(v.members?.find((m) => m.former)).toMatchObject({ email: null });
    expect(await fail(c.putProjectBudget(s.id, {}))).toEqual({ status: 400, code: "bad_request" });
    expect((await c.putProjectBudget(s.id, { daily: 4, monthly: 100, currency: "CHF" })).budget).toEqual({ daily: 4, monthly: 100, currency: "CHF" });
    expect((await c.getProjectBudget(s.id)).today).toMatchObject({ cap: 4, state: "over" });
    await c.deleteProjectBudget(s.id);
    expect((await c.getProjectAudit(s.id)).events.map((e) => e.event)).toEqual(["budget_removed", "budget_set"]);
    const r = await byName("Research"); // lectrice : sa ligne seulement, pas de journal
    expect((await c.getProjectBudget(r.id)).members?.every((m) => m.you)).toBe(true);
    expect((await fail(c.getProjectAudit(r.id))).status).toBe(403);
  });

  it("agents : ceux des autres réduits, désarmer celui d'un autre (owner) est journalisé", async () => {
    const s = await byName("Marketing site");
    const { agents } = await c.listProjectAgents(s.id);
    const other = agents.find((a) => !a.mine)!;
    expect(Object.keys(other).sort()).toEqual(["can_disarm", "id", "last_run", "mine", "name", "owner", "status", "trigger"]);
    expect(other.can_disarm).toBe(true);
    expect((await c.disarmProjectAgent(s.id, other.id)).agent).toMatchObject({ status: "paused", can_disarm: false });
    expect((await c.getProjectAudit(s.id)).events[0]).toMatchObject({ event: "agent_disarmed", detail: { owner_account: "bob" } });
    expect((await fail(c.disarmProjectAgent(s.id, "ag_inconnu"))).status).toBe(404);
  });

  it("quarantaine : remettre une version, la courante y part, la ligne reste marquée", async () => {
    const s = await byName("Marketing site");
    const q = (await c.listProjectQuarantine(s.id)).quarantine[0]!;
    const r = await c.restoreQuarantinedNote(s.id, q.id);
    expect(r.note).toMatchObject({ name: q.name, sha: q.sha });
    const after = (await c.listProjectQuarantine(s.id)).quarantine;
    expect(after.find((x) => x.id === q.id)?.restored_at).toBeTruthy();
    expect(after.some((x) => x.reason.includes("restauration"))).toBe(true);
    expect(await fail(c.restoreQuarantinedNote(s.id, q.id))).toEqual({ status: 409, code: "already_current" });
    expect((await c.getProjectAudit(s.id)).events[0]).toMatchObject({ event: "note_restored", detail: { name: q.name } });
  });
});

describe("livraison du brief (§7.18.5)", () => {
  it("éteinte par défaut ; Telegram ; e-mail derrière une carte forte, armé une fois signée", async () => {
    expect(await c.getBriefDelivery()).toMatchObject({ telegram: { enabled: false, chats: 1 }, email: { state: "off" }, last: null });
    expect((await c.putBriefDelivery({ telegram: true })).telegram.enabled).toBe(true);
    const p = await c.putBriefDelivery({ email: "alice@example.com" });
    expect(p.email).toMatchObject({ address: "alice@example.com", from: "alice@example.com", state: "pending" });
    expect(p.email.approval_id).toMatch(/^appr_/);
    await ops({ delivery: { approve: true } });
    expect((await c.getBriefDelivery()).email.state).toBe("armed");
    expect((await c.putBriefDelivery({ email: "autre@example.com" })).email.state).toBe("pending"); // nouvelle adresse : nouvelle carte
    expect((await c.putBriefDelivery({ email: null })).email.state).toBe("off");
    expect(await fail(c.putBriefDelivery({ email: "pas une adresse" }))).toEqual({ status: 400, code: "invalid" });
    await ops({ delivery: { chats: 0, sender: null } });
    expect(await fail(c.putBriefDelivery({ telegram: true }))).toEqual({ status: 409, code: "no_telegram" });
    expect(await fail(c.putBriefDelivery({ email: "alice@example.com" }))).toEqual({ status: 409, code: "no_mail_connector" });
  });
});
