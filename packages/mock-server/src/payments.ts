/**
 * Payments « à payer » + budgets — mock of core docs/PAYMENTS.md §5 (shapes of nokker/payments/{http,service,mandate}.py;
 * flag `payments` off by default like the core: option `payments` or `MOCK_PAYMENTS=1` → else 404 on `/v1/payments/*`).
 *
 * Demo, following the household mode of the mock (`MOCK_HOUSEHOLD`): no household → `alice` alone, payer of herself
 * (default budget CHF 200 / 300 / 1000); `payer` → also `sam` (adult member, budget set) and `lea` (teen, no budget:
 * refused); `member` / `minor` → `alice` is a member / a minor of `bob`'s household. A mandate signed yesterday is in the history. In a chat, « achète … » / « buy … » prepares a cart and
 * asks the « to pay » card (strong, `payments:to_pay`, `mandate_sha256` in the challenge); above the per-purchase cap
 * (« achète un vélo ») the spend is refused BEFORE any card (`payment.refused`). Only a passkey (WebAuthn proof)
 * approves it — a raw device signature is a 403, like the core's ProofInvalid; rejecting is always possible.
 */
import { argsSha256, canonicalJson, formatMinor, unitsToMinor, type Approval, type BudgetLine, type MandateDetail, type MandateStatus, type PayCard } from "@nokker-apps/sdk";
import { createHash } from "node:crypto";
import { approvalBubble } from "./demo.js";
import { MOCK_USER, randomId, type MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;
const PREFIX = "/v1/payments";
const TZ = "Europe/Zurich";

interface Person {
  account: string;
  role: BudgetLine["role"];
}
interface StoredBudget {
  currency: string;
  per_purchase_minor: number;
  per_day_minor: number;
  per_month_minor: number;
  minor_allowed: boolean;
  set_by: string | null;
  updated_at: number;
}
interface Rec extends Omit<MandateDetail, "status"> {
  status: MandateStatus;
  created: number;
}
interface P {
  people: Person[];
  budgets: Map<string, StoredBudget>;
  mandates: Rec[];
}
const all = new WeakMap<MockState, P>();
const DEFAULT: Omit<StoredBudget, "set_by" | "updated_at"> = { currency: "CHF", per_purchase_minor: 20000, per_day_minor: 30000, per_month_minor: 100000, minor_allowed: false };

const sha = (x: unknown): string => createHash("sha256").update(canonicalJson(x)).digest("hex");
const iso = (s: number): string => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const nowS = (): number => Date.now() / 1000;

function makeRec(state: MockState, account: string, args: { merchant: string; amount_minor: number; currency: string; items: PayCard["items"]; url: string | null; source: PayCard["source"]; reference: string | null }, approvalId: string, at: number, status: MandateStatus): Rec {
  const id = randomId("md");
  const cart = { merchant: args.merchant, amount: formatMinor(args.amount_minor, args.currency).split(" ")[0], currency: args.currency, items: args.items, url: args.url, source: args.source, reference: args.reference };
  const payee = { id: `mch_${sha(args.merchant).slice(0, 12)}`, name: args.merchant, ...(args.url ? { website: args.url } : {}) };
  const mandate = {
    format: "nokker.mandate.v1",
    mandate_id: id,
    approval_id: approvalId,
    principal: { account, approver: account },
    agent: "nokker",
    cart,
    cart_sha256: sha(cart),
    merchant: payee,
    max_amount: { amount: args.amount_minor, currency: args.currency },
    source: args.source,
    valid_from: iso(at),
    valid_until: iso(at + 24 * 3600),
    human_pays: true,
  };
  void state;
  return {
    mandate_id: id,
    approval_id: approvalId,
    account,
    approver: account,
    status,
    merchant: args.merchant,
    amount_minor: args.amount_minor,
    currency: args.currency,
    amount: formatMinor(args.amount_minor, args.currency),
    items: args.items,
    url: args.url,
    source: args.source,
    reference: args.reference,
    valid_until: mandate.valid_until,
    mandate_sha256: sha(mandate),
    handoff: args.source === "browser" ? { kind: "browser", url: args.url } : { kind: args.source },
    mandate,
    envelope: null,
    created: at,
  };
}

function seal(rec: Rec, by: string): void {
  rec.status = "signed";
  rec.envelope = {
    format: "nokker.mandate.v1",
    mandate: rec.mandate,
    mandate_sha256: rec.mandate_sha256,
    proof: { kind: "webauthn", decision: "approve", device_id: "dev_demo", origin: "https://app.example.com", rp_id: "app.example.com" },
    signed_by: by,
    signed_at: iso(nowS()),
  };
}

function seed(state: MockState): P {
  const p: P = {
    people:
      state.household === "payer"
        ? [
            { account: MOCK_USER, role: "payer" },
            { account: "sam", role: "member" },
            { account: "lea", role: "minor" },
          ]
        : state.household === "member" || state.household === "minor"
          ? [
              { account: "bob", role: "payer" },
              { account: MOCK_USER, role: state.household },
            ]
          : [{ account: MOCK_USER, role: "payer" }],
    budgets: new Map([["sam", { currency: "CHF", per_purchase_minor: 5000, per_day_minor: 10000, per_month_minor: 30000, minor_allowed: false, set_by: MOCK_USER, updated_at: nowS() - 3 * 86400 }]]),
    mandates: [],
  };
  const yesterday = nowS() - 26 * 3600;
  const rec = makeRec(state, MOCK_USER, { merchant: "Librairie du Lac", amount_minor: 3450, currency: "CHF", items: [{ name: "Carnet A5", quantity: 2, unit_price: "8.25" }, { name: "Stylo plume", quantity: 1, unit_price: "18.00" }], url: "https://shop.example.com/cart/42", source: "browser", reference: null }, "appr_demo_books", yesterday, "pending");
  seal(rec, MOCK_USER);
  p.mandates.push(rec);
  return p;
}
function pay(state: MockState): P {
  let x = all.get(state);
  if (!x) all.set(state, (x = seed(state)));
  return x;
}

const statusOf = (r: Rec): MandateStatus => (r.status === "pending" && Date.parse(r.valid_until ?? "") < Date.now() ? "expired" : r.status);
const card = ({ created: _c, mandate: _m, envelope: _e, ...r }: Rec): PayCard => ({ ...r, status: statusOf(r as Rec) });

function windows(now: number): [number, number] {
  const local = new Date(new Date(now * 1000).toLocaleString("en-US", { timeZone: TZ }));
  const shift = now * 1000 - local.getTime();
  const day = new Date(local);
  day.setHours(0, 0, 0, 0);
  const month = new Date(day);
  month.setDate(1);
  return [(day.getTime() + shift) / 1000, (month.getTime() + shift) / 1000];
}
const spent = (p: P, account: string, currency: string, from: number): number =>
  p.mandates.filter((m) => m.account === account && m.currency === currency && m.created >= from && (statusOf(m) === "pending" || m.status === "signed")).reduce((n, m) => n + m.amount_minor, 0);

function effective(p: P, who: Person): [StoredBudget | null, BudgetLine["source"]] {
  const b = p.budgets.get(who.account);
  if (b) return [b, "set"];
  if (who.role === "payer") return [{ ...DEFAULT, set_by: null, updated_at: 0 }, "default"];
  return [null, "none"];
}
function line(p: P, who: Person): BudgetLine {
  const [b, source] = effective(p, who);
  const out: BudgetLine = { account: who.account, role: who.role, source, budget: b ? { account: who.account, ...b, updated_at: b.updated_at || null } : null, can_spend: !!b && (who.role !== "minor" || b.minor_allowed) };
  if (b) {
    const [d0, m0] = windows(nowS());
    out.spent_today_minor = spent(p, who.account, b.currency, d0);
    out.spent_month_minor = spent(p, who.account, b.currency, m0);
  }
  return out;
}

/** Same sentences as the core's `Payments.refusal` (seen by the model, relayed in `payment.refused`). */
function refusal(p: P, account: string, amount: number, currency: string): [string, string] | null {
  const who = p.people.find((x) => x.account === account) ?? { account, role: "member" as const };
  const [b] = effective(p, who);
  if (who.role === "minor" && (!b || !b.minor_allowed)) return ["payments:minor", "dépense refusée : un profil mineur ne dépense pas, sauf accord explicite du payeur du foyer dans ses réglages de budget."];
  if (!b) return ["payments:budget", "dépense refusée : aucun budget de dépense pour ce membre ; le payeur du foyer le règle."];
  if (b.currency !== currency) return ["payments:budget", `dépense refusée : le budget est en ${b.currency}, la dépense en ${currency}.`];
  const amt = formatMinor(amount, currency);
  if (amount > b.per_purchase_minor) return ["payments:budget", `dépense refusée : ${amt} dépasse le plafond par achat (${formatMinor(b.per_purchase_minor, currency)}).`];
  const [d0, m0] = windows(nowS());
  const sd = spent(p, account, currency, d0);
  if (sd + amount > b.per_day_minor) return ["payments:budget", `dépense refusée : ${amt} dépasserait le plafond du jour (${formatMinor(sd, currency)} déjà engagés sur ${formatMinor(b.per_day_minor, currency)}).`];
  const sm = spent(p, account, currency, m0);
  if (sm + amount > b.per_month_minor) return ["payments:budget", `dépense refusée : ${amt} dépasserait le plafond du mois (${formatMinor(sm, currency)} déjà engagés sur ${formatMinor(b.per_month_minor, currency)}).`];
  return null;
}

const DEMO_CARTS: { match: RegExp; merchant: string; items: PayCard["items"]; amount_minor: number; url: string }[] = [
  { match: /velo|bike/, merchant: "Cycles Léman", items: [{ name: "Vélo de ville", quantity: 1, unit_price: "849.00" }], amount_minor: 84900, url: "https://bikes.example.com/cart" },
  { match: /./, merchant: "Papeterie Centrale", items: [{ name: "Cartouches d'encre", quantity: 2, unit_price: "24.95" }, { name: "Papier A4 (500 f.)", quantity: 1, unit_price: "9.90" }], amount_minor: 5980, url: "https://paper.example.com/cart/7" },
];

/** « achète … » / « buy … » in a chat (flag on): a « to pay » card, or a refusal before any card. */
export function payDemo(state: MockState, threadId: string, normalized: string): string | null {
  if (!state.payments || !/^(?:achete|commande|buy|order)\b/.test(normalized)) return null;
  const p = pay(state);
  const pick = DEMO_CARTS.find((c) => c.match.test(normalized))!;
  const why = refusal(p, MOCK_USER, pick.amount_minor, "CHF");
  if (why) {
    state.publish({ type: "payment.refused", thread_id: threadId, account: MOCK_USER, rule: why[0], reason: why[1], merchant: pick.merchant, amount_minor: pick.amount_minor, currency: "CHF" });
    return `I prepared the cart at ${pick.merchant}, but ${why[1]}`;
  }
  const args = { merchant: pick.merchant, amount: formatMinor(pick.amount_minor, "CHF").split(" ")[0], currency: "CHF", items: pick.items, url: pick.url, source: "browser" };
  const approval: Approval = {
    id: randomId("appr"),
    thread_id: threadId,
    turn_index: state.threads.get(threadId)?.turns.length ?? 0,
    channel: "web",
    tool_name: "pay_request",
    arguments: args,
    args_sha256: argsSha256(args),
    effect: null,
    rule: "payments:to_pay",
    reason: `Cart ready at ${pick.merchant}: you pay it yourself after approving.`,
    advice: null,
    strength: "strong",
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decided_by: null,
    decided_via: null,
    decided_at: null,
    result_summary: null,
    error: null,
  };
  const rec = makeRec(state, MOCK_USER, { merchant: pick.merchant, amount_minor: pick.amount_minor, currency: "CHF", items: pick.items, url: pick.url, source: "browser", reference: null }, approval.id, nowS(), "pending");
  p.mandates.unshift(rec);
  state.approvals.set(approval.id, approval);
  // The core's executor: once the passkey sealed the mandate, the browser is handed to the person (nothing is paid).
  state.approvalEffects.set(approval.id, () => "Browser handed over: pay on the merchant's page yourself.");
  state.publish({ type: "approval.requested", approval });
  state.publish({ type: "payment.to_pay", ...card(rec), thread_id: threadId, strength: "strong" });
  approvalBubble(state, approval);
  return `Cart ready at ${pick.merchant} (${rec.amount}). Approve the « to pay » card with your passkey, then you pay on the merchant's page — I never pay.`;
}

/** Challenge of a « to pay » card: it carries the mandate's hash (signed as is). */
export function payChallengeBinding(state: MockState, approvalId: string): string | null {
  if (!state.payments) return null;
  return pay(state).mandates.find((m) => m.approval_id === approvalId)?.mandate_sha256 ?? null;
}

/** Before a decision: approving a « to pay » card takes a passkey (WebAuthn proof); returns the 403 message else. */
export function payProofRefusal(state: MockState, approval: Approval, decision: string, via: string): string | null {
  if (!state.payments || decision !== "approve" || via === "webauthn") return null;
  return payChallengeBinding(state, approval.id) ? "carte « à payer » : approbation par passkey exigée (mandat signé)" : null;
}

/** After a decision: seal or reject the mandate (the reserved amount is released on a rejection). */
export function payDecided(state: MockState, approval: Approval, decision: "approve" | "reject", by: string): void {
  if (!state.payments) return;
  const rec = pay(state).mandates.find((m) => m.approval_id === approval.id);
  if (!rec || rec.status !== "pending") return;
  if (decision === "approve") {
    seal(rec, by);
    state.publish({ type: "payment.mandate_signed", mandate_id: rec.mandate_id, approval_id: approval.id, thread_id: approval.thread_id, account: rec.account, merchant: rec.merchant, amount_minor: rec.amount_minor, currency: rec.currency, signed_by: by });
  } else {
    rec.status = "rejected";
    state.publish({ type: "payment.rejected", mandate_id: rec.mandate_id, approval_id: approval.id, thread_id: approval.thread_id, account: rec.account });
  }
}

const err = (send: Send, status: number, code: string, message: string): true => (send(status, { error: { code, message } }), true);

export async function handlePayments(state: MockState, user: string, method: string, url: URL, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, "");
  if (path !== PREFIX && !path.startsWith(PREFIX + "/")) return false;
  if (!state.payments) return err(send, 404, "not_found", "not found");
  const p = pay(state);
  const me = p.people.find((x) => x.account === user) ?? { account: user, role: "payer" as const };
  const isPayer = me.role === "payer";
  const manageable = (account: string): Person => {
    const who = p.people.find((x) => x.account === account);
    if (who && isPayer) return who;
    if (account === user) throw Object.assign(new Error("seul le payeur du foyer règle les budgets de dépense"), { status: 403, code: "payer_only" });
    throw Object.assign(new Error("membre inconnu dans ce foyer"), { status: 404, code: "not_found" });
  };
  try {
    if (path === PREFIX + "/budgets" && method === "GET") {
      return send(200, { is_payer: isPayer, timezone: TZ, members: (isPayer ? p.people : [me]).map((x) => line(p, x)) }), true;
    }
    let m = /^\/v1\/payments\/budgets\/([^/]+)$/.exec(path);
    if (m && (method === "PUT" || method === "DELETE")) {
      const who = manageable(decodeURIComponent(m[1]!));
      if (method === "DELETE") p.budgets.delete(who.account);
      else {
        const b = await readBody();
        const cur = String(b.currency ?? "").toUpperCase();
        const caps = (["per_purchase", "per_day", "per_month"] as const).map((k) => (typeof b[k] === "string" || typeof b[k] === "number" ? unitsToMinor(b[k] as string | number, cur) : null));
        if (caps.some((c) => c === null)) return err(send, 400, "invalid", "plafond illisible : le montant doit être positif");
        if (!/^[A-Z]{3}$/.test(cur)) return err(send, 400, "invalid", "devise : code ISO 4217 à trois lettres attendu");
        const minor = caps as number[];
        if (!(minor[0]! <= minor[1]! && minor[1]! <= minor[2]!)) return err(send, 400, "invalid", "plafonds incohérents : par achat ≤ par jour ≤ par mois");
        if (b.minor_allowed !== undefined && typeof b.minor_allowed !== "boolean") return err(send, 400, "invalid", "minor_allowed : booléen attendu");
        p.budgets.set(who.account, { currency: cur, per_purchase_minor: minor[0]!, per_day_minor: minor[1]!, per_month_minor: minor[2]!, minor_allowed: who.role === "minor" && b.minor_allowed === true, set_by: user, updated_at: nowS() });
      }
      const l = line(p, who);
      state.publish({ type: "payment.budget_changed", account: who.account, by: user, line: l });
      return send(200, l), true;
    }
    if (method === "GET" && (path === PREFIX + "/mandates" || path.startsWith(PREFIX + "/mandates/"))) {
      const member = url.searchParams.get("member");
      const target = member ?? user;
      if (target !== user) manageable(target);
      const mine = p.mandates.filter((r) => r.account === target);
      if (path === PREFIX + "/mandates") return send(200, { mandates: mine.map(card) }), true;
      m = /^\/v1\/payments\/mandates\/([^/]+)(\/verify)?$/.exec(path);
      const rec = m ? mine.find((r) => r.mandate_id === m![1]) : undefined;
      if (!rec) return err(send, 404, "not_found", "mandat inconnu");
      if (!m![2]) {
        const { created: _c, ...rest } = rec;
        return send(200, { ...rest, status: statusOf(rec) }), true;
      }
      if (!rec.envelope) return send(200, { mandate_id: rec.mandate_id, status: statusOf(rec), valid: false, expired: false, checks: {}, errors: ["mandat non signé"] }), true;
      const checks = Object.fromEntries(["format", "mandate_sha256", "cart_sha256", "coherence", "challenge", "signature", "device_key_trusted"].map((k) => [k, true]));
      return send(200, { mandate_id: rec.mandate_id, status: statusOf(rec), valid: true, expired: Date.parse(rec.valid_until ?? "") < Date.now(), checks, errors: [] }), true;
    }
  } catch (e) {
    const x = e as Error & { status?: number; code?: string };
    if (x.status) return err(send, x.status, x.code ?? "error", x.message);
    throw e;
  }
  return err(send, 404, "not_found", "not found");
}
