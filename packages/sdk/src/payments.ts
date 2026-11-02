/**
 * Payments « à payer » + spending budgets (core docs/PAYMENTS.md §5, shapes of nokker/payments/{http,service,mandate}.py;
 * flag `payments` off → 404 on every `/v1/payments/*` route, challenges unchanged). Account session, 60 writes/min.
 *
 *   GET    /v1/payments/budgets                         → BudgetsView
 *   PUT    /v1/payments/budgets/{account} BudgetInput   → BudgetLine   (payer only: 403 payer_only, 404, 400 invalid)
 *   DELETE /v1/payments/budgets/{account}               → BudgetLine   (back to the default)
 *   GET    /v1/payments/mandates[?member=]              → {mandates: PayCard[]}
 *   GET    /v1/payments/mandates/{id}[?member=]         → MandateDetail (envelope null until signed)
 *   GET    /v1/payments/mandates/{id}/verify[?member=]  → MandateVerification
 *
 * The agent prepares, the person pays: a « to pay » card (rule `payments:to_pay`, or `household:guardian` for an
 * allowed minor) is a STRONG approval card; its challenge carries `mandate_sha256` and is signed as is. Only a passkey
 * (WebAuthn) approves it: no local token, no TOTP, no relayed decision, no Telegram Mini App. Rejecting stays possible
 * everywhere. Never a card number, CVV or 3-D Secure in the client.
 */

export const PAY_RULE = "payments:to_pay";
export const PAY_TOOL = "pay_request";

export type BudgetRole = "payer" | "member" | "minor";
export type BudgetSource = "set" | "default" | "none";

export interface Budget {
  account: string;
  currency: string;
  per_purchase_minor: number;
  per_day_minor: number;
  per_month_minor: number;
  minor_allowed: boolean;
  set_by: string | null;
  updated_at: number | null;
}

export interface BudgetLine {
  account: string;
  role: BudgetRole;
  source: BudgetSource;
  budget: Budget | null;
  /** Present only when a budget is in force (pending cards reserve their amount). */
  spent_today_minor?: number;
  spent_month_minor?: number;
  can_spend: boolean;
}

export interface BudgetsView {
  is_payer: boolean;
  timezone: string;
  members: BudgetLine[];
}

/** Amounts in units (« 50 », « 49.90 »); `minor_allowed` only means something for a minor. */
export interface BudgetInput {
  currency: string;
  per_purchase: string | number;
  per_day: string | number;
  per_month: string | number;
  minor_allowed?: boolean;
}

export type MandateStatus = "pending" | "signed" | "rejected" | "expired";
export type PaySource = "browser" | "qr_bill" | "pain001";

export interface PayItem {
  name: string;
  quantity: number;
  unit_price?: string | number;
}

export interface PayCard {
  mandate_id: string;
  approval_id: string;
  account: string;
  approver: string | null;
  status: MandateStatus;
  merchant: string;
  amount_minor: number;
  currency: string;
  /** Server-formatted, « 129.90 CHF »: shown as is. */
  amount: string;
  items: PayItem[];
  url: string | null;
  source: PaySource | (string & {});
  reference: string | null;
  valid_until: string | null;
  mandate_sha256: string;
  /** `browser`: after approval the browser is handed to the person; `qr_bill` / `pain001`: pay from e-banking. */
  handoff: { kind: "browser"; url: string | null } | { kind: "qr_bill" | "pain001" | (string & {}) };
  /** Only in the `payment.to_pay` event. */
  thread_id?: string;
  strength?: string;
}

export interface MandateDetail extends PayCard {
  mandate: Record<string, unknown>;
  envelope: Record<string, unknown> | null;
}

export interface MandateVerification {
  mandate_id: string;
  status: MandateStatus;
  /** The passkey signature holds; an expired mandate stays valid (`expired` says it apart). */
  valid: boolean;
  expired: boolean;
  /** format, mandate_sha256, cart, cart_sha256, coherence, proof, challenge, signature, device_key_trusted. */
  checks: Record<string, boolean>;
  errors: string[];
}

export interface PaymentToPayEvent extends PayCard {
  type: "payment.to_pay";
}
export interface PaymentSignedEvent {
  type: "payment.mandate_signed";
  mandate_id: string;
  approval_id: string;
  thread_id: string;
  account: string;
  merchant: string;
  amount_minor: number;
  currency: string;
  signed_by: string;
}
export interface PaymentRejectedEvent {
  type: "payment.rejected";
  mandate_id: string;
  approval_id: string;
  thread_id: string;
  account: string;
}
/** Refused BEFORE any card (budget or minor rule); `reason` is the core's French sentence. */
export interface PaymentRefusedEvent {
  type: "payment.refused";
  thread_id: string;
  account: string | null;
  rule: "payments:budget" | "payments:minor" | (string & {});
  reason: string;
  merchant?: string;
  amount_minor?: number;
  currency?: string;
}
export interface PaymentBudgetChangedEvent {
  type: "payment.budget_changed";
  account: string;
  by: string;
  line: BudgetLine;
}
export type PaymentEvent = PaymentToPayEvent | PaymentSignedEvent | PaymentRejectedEvent | PaymentRefusedEvent | PaymentBudgetChangedEvent;

/** ISO 4217 currencies without minor units (same set as the core). */
const ZERO_DECIMALS = new Set(["JPY", "KRW", "ISK", "CLP", "VND"]);
export const currencyExponent = (currency: string): number => (ZERO_DECIMALS.has(currency.toUpperCase()) ? 0 : 2);

/** Minor units → « 129.90 CHF », exactly like the core's `format_minor`. */
export function formatMinor(minor: number, currency: string): string {
  const cur = currency.toUpperCase();
  if (currencyExponent(cur) === 0) return `${minor} ${cur}`;
  const abs = Math.abs(Math.trunc(minor));
  return `${minor < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${cur}`;
}

/** Minor units → the decimal text a PUT takes (« 49.90 », « 200 »). */
export function minorToUnits(minor: number, currency: string): string {
  if (currencyExponent(currency) === 0) return String(minor);
  const s = formatMinor(minor, currency).split(" ")[0]!;
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}

/** « 49.90 », « 49,9 », « 1'000 » → minor units; `null` when unreadable, not positive or out of bounds (core `to_minor`). */
export function unitsToMinor(text: string | number, currency: string): number | null {
  const t = String(text).trim().replace(/['’ ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const exp = currencyExponent(currency);
  const [int, frac = ""] = t.split(".");
  // Half-up rounding on the first dropped digit, like Decimal.quantize(ROUND_HALF_UP).
  const kept = (frac + "0".repeat(exp)).slice(0, exp);
  let minor = Number(int) * 10 ** exp + (kept ? Number(kept) : 0);
  if ((frac[exp] ?? "0") >= "5") minor += 1;
  return minor > 0 && minor <= 1e12 ? minor : null;
}

/** A « to pay » card: the rule of the core's payment cards (a minor's card goes to the guardian with its own rule). */
export const isPayApproval = (a: { rule?: string | null; tool_name?: string | null }): boolean => a.rule === PAY_RULE || a.tool_name === PAY_TOOL;
