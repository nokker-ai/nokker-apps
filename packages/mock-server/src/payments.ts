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
import { argsSha256, canonicalJson, formatMinor, unitsToMinor, type Approval, type BudgetLine, type MandateDetail, type MandateStatus, type PayCard, type PayLink, type PayMethod, type ThreeDSPending } from "@nokker-apps/sdk";
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
interface ThreeDSRec extends ThreeDSPending {
  status: "pending" | "approved" | "rejected" | "expired";
}
/** Payment agent, issuer wise (PAY-AGENT §10; `MOCK_PAY_AGENT`): the Wise account, the method, waiting 3-D Secure. */
interface AgentMock {
  link: PayLink | null;
  method: PayMethod | null;
  threeds: Map<string, ThreeDSRec>;
}
interface P {
  people: Person[];
  budgets: Map<string, StoredBudget>;
  mandates: Rec[];
  agent: AgentMock;
}
const WISE_PROFILE = "wise:29751964";
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
    agent: {
      link: state.payAgent === "wise-linked" ? { state: "PASSED", required_by: null, updated_at: nowS() - 86400 } : null,
      method: state.payAgent === "wise-linked" ? { kind: "wise_card", issuer: "wise", brand: "VISA", last4: null, exp_month: null, exp_year: null, created_at: nowS() - 86400 } : null,
      threeds: new Map(),
    },
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

/** Mock only (« ta carte », PAY-AGENT §11): the mandate of a card made by `payDemo` becomes the Lokkal owner's, paid
 * by the payment agent with the person's own card when `ownCard`. */
export function ownCardMandate(state: MockState, approvalId: string, account: string, ownCard: boolean): void {
  const rec = pay(state).mandates.find((m) => m.approval_id === approvalId);
  if (!rec) return;
  rec.account = account;
  if (!ownCard) return;
  rec.pay_by = "agent";
  rec.handoff = { kind: "agent" };
}

/** Mock only: after the passkey, the core's payment agent starts on an own_card mandate (`agent.kind: "own_card"`). */
export function ownCardStarted(state: MockState, approvalId: string): void {
  const rec = pay(state).mandates.find((m) => m.approval_id === approvalId);
  if (rec?.pay_by === "agent") rec.agent = { kind: "own_card", status: "active", used: false, currency: rec.currency, max_amount_minor: rec.amount_minor };
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
    const agentDone = await handlePayAgent(state, p, user, method, path, readBody, send);
    if (agentDone) return true;
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

// ── Payment agent, issuer wise (PAY-AGENT §10) — mock of nokker/payments/http.py `_method_route` and the 3DS routes ──

const KYC_DONE = ["PASSED", "PASSED_WITH_REQUIREMENTS"];

function agentPublish(state: MockState, rec: Rec): void {
  state.publish({ type: "payment.agent", mandate_id: rec.mandate_id, approval_id: rec.approval_id, account: rec.account, merchant: rec.merchant, amount_minor: rec.amount_minor, currency: rec.currency, agent: rec.agent ?? { status: "active" } });
}

async function handlePayAgent(state: MockState, p: P, user: string, method: string, path: string, readBody: () => Promise<Record<string, unknown>>, send: Send): Promise<boolean> {
  const on = state.payAgent === "wise" || state.payAgent === "wise-linked"; // own_card : owncard.ts
  const a = p.agent;
  if (path === PREFIX + "/method" || path.startsWith(PREFIX + "/method/")) {
    if (!on) return err(send, 404, "not_found", "not found");
    if (path === PREFIX + "/method" && method === "GET") return send(200, { issuer: "wise", publishable_key: null, method: a.method, link: a.link }), true;
    if (path === PREFIX + "/method" && method === "DELETE") {
      const had = !!a.method;
      a.method = null;
      return send(200, { removed: had }), true;
    }
    if (path === PREFIX + "/method/link" && method === "POST") {
      const b = await readBody();
      const person = (b.person ?? {}) as Record<string, unknown>;
      const ok = ["first_name", "last_name", "date_of_birth", "address_line", "city", "country_iso3", "email", "phone"].every((k) => typeof person[k] === "string" && (person[k] as string).trim());
      if (!ok || !/^\+[1-9]\d{6,14}$/.test(String(person.phone)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(person.date_of_birth))) return err(send, 400, "invalid", "identité illisible");
      a.link ??= { state: "WAITING_CUSTOMER_INPUT", required_by: null, updated_at: nowS() };
      return send(200, { link: a.link }), true;
    }
    if (path === PREFIX + "/method/link/url" && method === "POST") {
      if (!a.link) return err(send, 404, "not_found", "aucun compte émetteur ouvert");
      if (a.link.state !== "WAITING_CUSTOMER_INPUT" && a.link.state !== "PASSED_WITH_REQUIREMENTS") return err(send, 409, "kyc_no_link", "pas de lien KYC");
      // Wise's hosted page is not mocked: back at once, `status=success`; Wise checks for a moment, then PASSED.
      a.link = { ...a.link, state: "PROCESSING", updated_at: nowS() };
      state.later(1500, () => {
        if (a.link) a.link = { ...a.link, state: "PASSED", updated_at: nowS() };
      });
      return send(200, { url: "/?wise=kyc&status=success#account", expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }), true;
    }
    if (path === PREFIX + "/method/balance" && method === "GET") {
      if (!a.link) return err(send, 404, "not_found", "aucun compte émetteur ouvert");
      return send(200, { balances: [{ currency: "CHF", amount_minor: 18450 }, { currency: "EUR", amount_minor: 4200 }] }), true;
    }
    if (path === PREFIX + "/method/challenge" && method === "POST") {
      if (!a.link) return err(send, 409, "no_link", "aucun compte émetteur ouvert");
      const challenge = canonicalJson({ account: user, aud: "nokker-pay-method", iat: Math.floor(nowS()), payment_method: WISE_PROFILE });
      return send(200, { challenge, payment_method: WISE_PROFILE }), true;
    }
    if (path === PREFIX + "/method" && method === "PUT") {
      const b = await readBody();
      const proof = (b.proof ?? {}) as Record<string, unknown>;
      if (!a.link || !KYC_DONE.includes(a.link.state)) return err(send, 409, "kyc", "vérification d'identité pas encore terminée chez l'émetteur");
      if (b.payment_method !== WISE_PROFILE) return err(send, 403, "profile", "ce profil n'a pas été ouvert pour ce compte");
      if (typeof proof.client_data_json !== "string" || typeof proof.signature !== "string") return err(send, 403, "proof", "preuve passkey attendue");
      a.method = { kind: "wise_card", issuer: "wise", brand: "VISA", last4: null, exp_month: null, exp_year: null, created_at: nowS() };
      return send(200, { method: a.method }), true;
    }
    return err(send, 404, "not_found", "not found");
  }
  const m = /^\/v1\/payments\/mandates\/([^/]+)\/3ds$/.exec(path);
  if (!m) return false;
  if (!on) return err(send, 404, "not_found", "not found");
  const rec = p.mandates.find((r) => r.mandate_id === m[1] && r.account === user);
  const t = rec ? a.threeds.get(rec.mandate_id) : undefined;
  if (!rec || !t || t.status !== "pending") return err(send, 404, "not_found", "aucune confirmation en attente");
  if (method === "GET") {
    const { status: _s, ...pending } = t;
    return send(200, pending), true;
  }
  if (method !== "POST") return err(send, 404, "not_found", "not found");
  const b = await readBody();
  if (b.challenge_id !== t.challenge_id) return err(send, 404, "not_found", "aucune confirmation en attente");
  if (t.expires_at <= nowS()) {
    t.status = "expired";
    rec.agent = { ...(rec.agent ?? { status: "active" }), status: "active" };
    delete rec.agent.threeds;
    agentPublish(state, rec);
    return err(send, 410, "expired", "délai de confirmation dépassé");
  }
  if (b.decline === true) t.status = "rejected";
  else {
    const proof = (b.proof ?? {}) as Record<string, unknown>;
    if (proof.challenge !== t.challenge || typeof proof.client_data_json !== "string") return err(send, 403, "proof", "le défi signé ne porte pas sur ce paiement");
    t.status = "approved";
  }
  rec.agent = { ...(rec.agent ?? { status: "active" }), status: "active" };
  delete rec.agent.threeds;
  if (t.status === "approved") {
    state.later(1500, () => {
      rec.agent = { ...(rec.agent ?? { status: "active" }), status: "deactivated", used: true, deactivated_reason: "used" };
      agentPublish(state, rec);
    });
  }
  agentPublish(state, rec);
  return send(200, { ...card(rec), agent: rec.agent }), true;
}

/** Demo (`MOCK_PAY_AGENT`): « simule 3ds » / « simulate 3ds » in a chat — a signed card paid by the agent, then the
 * bank asks a 3-D Secure confirmation (5 minutes). Mock only: the core gets it from Wise. */
export function payAgentDemo(state: MockState, normalized: string): string | null {
  if ((state.payAgent !== "wise" && state.payAgent !== "wise-linked") || !/^(?:simule|simulate)\s+3ds\b/.test(normalized)) return null;
  const p = pay(state);
  const rec = makeRec(state, MOCK_USER, { merchant: "Boutique du Lac", amount_minor: 4290, currency: "CHF", items: [{ name: "Bougie parfumée", quantity: 2, unit_price: "21.45" }], url: "https://shop.example.com/checkout", source: "browser", reference: null }, randomId("appr"), nowS(), "pending");
  seal(rec, MOCK_USER);
  rec.pay_by = "agent";
  rec.handoff = { kind: "agent" };
  const id = randomId("3ds");
  const expires = Math.floor(nowS()) + 300;
  const challenge = canonicalJson({ amount_minor: 4290, aud: "nokker-3ds", challenge_id: id, currency: "CHF", expires_at: expires, mandate_id: rec.mandate_id, merchant: "BOUTIQUE DU LAC", merchant_url: "https://shop.example.com" });
  p.agent.threeds.set(rec.mandate_id, { challenge_id: id, amount_minor: 4290, currency: "CHF", merchant: "BOUTIQUE DU LAC", expires_at: expires, merchant_url: "https://shop.example.com", merchant_country: "CH", merchant_match: "host", challenge, status: "pending" });
  rec.agent = { id: "cd_demo", kind: "card", status: "requires_action", used: false, currency: "CHF", max_amount_minor: 4290, expires_at: expires + 3600, threeds: { challenge_id: id, amount_minor: 4290, currency: "CHF", merchant: "BOUTIQUE DU LAC", expires_at: expires } };
  p.mandates.unshift(rec);
  state.later(400, () => agentPublish(state, rec));
  return "The payment agent is paying Boutique du Lac (42.90 CHF) with the card reserved to this purchase; your bank asks you to confirm.";
}

// ── « Ta carte » (own_card, Lokkal, PAY-AGENT §11) — démo et demandes de la banque (mock seulement) ──

const ownPrompts = new WeakMap<MockState, Map<string, { kind: "cvv" | "otp" | "bank_app"; expires_at: number }>>();
const promptsOf = (state: MockState) => {
  let m = ownPrompts.get(state);
  if (!m) ownPrompts.set(state, (m = new Map()));
  return m;
};

function ownAsk(state: MockState, rec: Rec, kind: "cvv" | "otp" | "bank_app", ttl = 300): void {
  const expires_at = Math.floor(nowS()) + ttl;
  promptsOf(state).set(rec.mandate_id, { kind, expires_at });
  rec.agent = { ...(rec.agent ?? { status: "active" }), kind: "own_card", status: "active", prompt: { kind, expires_at } };
  agentPublish(state, rec);
}

function ownEnd(state: MockState, rec: Rec, reason: "used" | "checkout_failed"): void {
  promptsOf(state).delete(rec.mandate_id);
  rec.agent = { ...(rec.agent ?? { status: "active" }), kind: "own_card", status: "deactivated", used: reason === "used", deactivated_reason: reason };
  delete rec.agent.prompt;
  agentPublish(state, rec);
}

/** `POST /v1/payments/mandates/{id}/cvv|otp` : seulement ce que l'agent a demandé, une fois. Le code de test de la
 * banque est 123456 ; tout autre code : paiement refusé. */
export function ownCardPrompt(state: MockState, mandateId: string, kind: "cvv" | "otp", value: string): "ok" | "none" | "invalid" {
  const p = promptsOf(state).get(mandateId);
  const rec = pay(state).mandates.find((r) => r.mandate_id === mandateId);
  if (!p || !rec || p.kind !== kind || p.expires_at < nowS()) return "none";
  if (kind === "cvv" ? !/^\d{3,4}$/.test(value) : !/^[0-9A-Za-z]{4,10}$/.test(value)) return "invalid";
  promptsOf(state).delete(mandateId);
  if (kind === "cvv") state.later(600, () => ownAsk(state, rec, "otp"));
  else state.later(600, () => ownEnd(state, rec, value === "123456" ? "used" : "checkout_failed"));
  return "ok";
}

/** « simule ta carte » / « simulate my card » (et « … appli » / « … app ») : une carte « à payer » own_card signée, puis
 * l'agent demande le CVV (sauf s'il est gardé), puis le code de la banque — ou la confirmation dans l'appli. */
export function ownCardDemo(state: MockState, normalized: string, cvvKept: boolean): string | null {
  if (state.payAgent !== "own_card" || !/^(?:simule ta carte|simulate my card)\b/.test(normalized)) return null;
  const app = /\b(appli|app)\b/.test(normalized);
  const p = pay(state);
  const rec = makeRec(state, MOCK_USER, { merchant: "Boutique de test", amount_minor: 4290, currency: "CHF", items: [{ name: "Bouilloire inox", quantity: 1, unit_price: "42.90" }], url: "https://shop.example.com/checkout", source: "browser", reference: null }, randomId("appr"), nowS(), "pending");
  seal(rec, MOCK_USER);
  rec.pay_by = "agent";
  rec.handoff = { kind: "agent" };
  rec.agent = { id: "cd_own", kind: "own_card", status: "active", used: false, currency: "CHF", max_amount_minor: 4290 };
  p.mandates.unshift(rec);
  if (app) {
    state.later(400, () => ownAsk(state, rec, "bank_app", 600));
    state.later(6000, () => ownEnd(state, rec, "used"));
  } else state.later(400, () => ownAsk(state, rec, cvvKept ? "otp" : "cvv"));
  return "Your payment agent is paying Boutique de test (42.90 CHF) with your own card; your bank may ask you something in Nokker.";
}
