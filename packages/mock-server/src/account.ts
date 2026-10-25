/**
 * « Mon compte » en démo : `/v1/account*` (contrat final de Nokker dev, 22.10.2026) et `/v1/billing/*`
 * (nokker/billing). Le réglage de la démo passe par `POST /v1/dev/account-mock` (mock seulement) :
 * `{billing: bool, plan: "solo"|"famille"|"large"|null, status, deleting: bool, internal: bool}`.
 */
import { argsSha256, type Approval, type BillingStatus } from "@nokker-apps/sdk";
import { MOCK_USER, randomId, type MockState } from "./state.js";
import { householdMinor, householdUsage } from "./household.js";

type Send = (status: number, payload: unknown) => void;

interface AccountMock {
  billing: boolean;
  plan: string | null;
  status: string | null;
  deleting: boolean;
  internal: boolean;
  exportId: string | null;
  exportPolls: number;
  turnsToday: number;
  mode: "soft" | "hard";
  training: boolean;
}

const mocks = new WeakMap<MockState, AccountMock>();
export function accountMock(state: MockState): AccountMock {
  let m = mocks.get(state);
  if (!m) {
    m = { billing: true, plan: null, status: null, deleting: false, internal: false, exportId: null, exportPolls: 0, turnsToday: 37, mode: "soft", training: false };
    mocks.set(state, m);
  }
  return m;
}

// Paliers du noyau (nokker/billing/plans.py, 25.10) : mêmes clés que `GET /v1/billing/plan`.
const PLANS: { id: string; caps: Record<string, number> }[] = [
  { id: "solo", caps: { turns_per_day: 40, turns_per_week: 200 } },
  { id: "famille", caps: { turns_per_day: 110, turns_per_week: 550, household_members: 6 } },
  { id: "large", caps: { turns_per_day: 230, turns_per_week: 1150, household_members: 6 } },
];

/** Prochain midi UTC. */
function nextNoonUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Lundi 06:00 UTC : `offsetDays` 0 = le prochain, -7 = celui d'avant. */
function weekStartUtc(offsetDays: number, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6));
  const toMonday = (8 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + toMonday + offsetDays);
  if (offsetDays === 0 && d.getTime() - now.getTime() > 7 * 86_400_000) d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString();
}

const zurichDay = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date());

export async function handleAccount(
  state: MockState,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  const m = accountMock(state);

  if (method === "POST" && path === "/v1/dev/account-mock") {
    const b = await readBody();
    for (const k of ["billing", "deleting", "internal"] as const) if (typeof b[k] === "boolean") m[k] = b[k] as boolean;
    if ("plan" in b) m.plan = (b.plan as string | null) ?? null;
    if ("status" in b) m.status = (b.status as string | null) ?? null;
    else if ("plan" in b) m.status = m.plan ? "active" : null;
    if (typeof b.turns_today === "number") m.turnsToday = b.turns_today;
    if (b.mode === "soft" || b.mode === "hard") m.mode = b.mode;
    send(200, { ok: true });
    return true;
  }

  if (!path.startsWith("/v1/account") && !path.startsWith("/v1/billing/")) return false;

  if (m.deleting) return send(403, { error: "account_deleting" }), true;

  if (method === "GET" && path === "/v1/account") {
    send(200, {
      email: `${MOCK_USER}@example.ch`,
      lang: "fr",
      created_at: "2026-10-12T08:30:00+02:00",
      status: "active",
      terms: { version: "2026-10-28", accepted_at: "2026-10-12T08:31:10+02:00" },
      consents: householdMinor(state, MOCK_USER) ? { training: false, training_locked: "minor" } : { training: m.training },
    });
    return true;
  }

  if (method === "PUT" && path === "/v1/account/consent") {
    const b = await readBody();
    if (b.scope !== "training" || typeof b.granted !== "boolean") return send(400, { error: "invalid" }), true;
    if (b.granted && householdMinor(state, MOCK_USER)) return send(403, { error: { code: "minor_training_refused", message: "profil mineur : jamais d'entraînement" } }), true;
    m.training = b.granted;
    send(200, { scope: "training", granted: m.training });
    return true;
  }

  if (method === "GET" && path === "/v1/account/usage") {
    const plan = m.billing ? m.plan : null;
    const caps = m.internal ? null : (PLANS.find((p) => p.id === plan)?.caps ?? { turns_per_day: 40, turns_per_week: 200 });
    const dayCap = caps ? (caps.turns_per_day ?? null) : null;
    const weekCap = caps ? (caps.turns_per_week ?? null) : null;
    const weekUsed = m.turnsToday + 173;
    send(200, {
      tz: "Europe/Zurich",
      mode: m.mode,
      plan,
      today: {
        day: zurichDay(),
        resets_at: nextNoonUtc(),
        turns: { used: m.turnsToday, cap: dayCap, over: dayCap !== null && m.turnsToday > dayCap, hard_cap: dayCap === null ? null : 150 },
      },
      week: {
        starts: weekStartUtc(-7),
        resets_at: weekStartUtc(0),
        turns: { used: weekUsed, cap: weekCap, over: weekCap !== null && weekUsed > weekCap },
      },
      month: { turns: { used: 412 } },
      ...(householdUsage(state, MOCK_USER) ? { household: householdUsage(state, MOCK_USER) } : {}),
    });
    return true;
  }

  if (method === "POST" && path === "/v1/account/export") {
    if (m.exportId && m.exportPolls > 1) return send(429, { error: "rate", retry_after_s: 86_400 }), true;
    const fresh = !m.exportId;
    if (fresh) {
      m.exportId = randomId("ex");
      m.exportPolls = 0;
    }
    send(fresh ? 202 : 200, { id: m.exportId, status: "pending" });
    return true;
  }
  if (method === "GET" && path.startsWith("/v1/account/exports/")) {
    const id = decodeURIComponent(path.slice("/v1/account/exports/".length));
    if (id !== m.exportId) return send(404, { error: "not_found" }), true;
    m.exportPolls += 1;
    if (m.exportPolls < 2) return send(200, { status: "pending" }), true;
    send(200, { status: "ready", download_url: `https://export.example/${id}.json`, expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() });
    return true;
  }

  if (method === "POST" && path === "/v1/account/delete") {
    const args = { account: MOCK_USER };
    const approval: Approval = {
      id: randomId("appr"),
      thread_id: "",
      turn_index: 0,
      channel: "web",
      tool_name: "account.delete",
      arguments: args,
      args_sha256: argsSha256(args),
      effect: "destructive",
      rule: "effect:destructive",
      reason: "Suppression définitive du compte et de toutes ses données (démo).",
      advice: null,
      strength: "strong",
      status: "pending",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      decided_by: null,
      decided_via: null,
      decided_at: null,
      result_summary: null,
      error: null,
    };
    state.approvals.set(approval.id, approval);
    state.publish({ type: "approval.requested", approval });
    send(202, { approval_id: approval.id });
    return true;
  }

  if (path.startsWith("/v1/billing/")) {
    if (!m.billing) return send(404, { error: "not_found" }), true;
    if (method === "GET" && path === "/v1/billing/plan") {
      const body: BillingStatus = {
        plan: m.plan,
        status: m.status,
        current_period_end: m.plan ? new Date(Date.now() + 20 * 86_400_000).toISOString() : null,
        cancel_at_period_end: m.status === "canceling",
        plans: PLANS,
      };
      send(200, body);
      return true;
    }
    if (method === "POST" && path === "/v1/billing/checkout") {
      const b = await readBody();
      if (!PLANS.some((p) => p.id === b.plan)) return send(400, { error: "bad_plan" }), true;
      if (m.plan) return send(409, { error: "already_subscribed" }), true;
      send(200, { url: `https://checkout.stripe.example/c/${String(b.plan)}` });
      return true;
    }
    if (method === "POST" && path === "/v1/billing/portal") {
      if (!m.plan) return send(404, { error: "no_customer" }), true;
      send(200, { url: "https://billing.stripe.example/p/session" });
      return true;
    }
  }
  return false;
}
