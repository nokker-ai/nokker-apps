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
 *
 * Payment agent (core docs/PAY-AGENT.md, flag `pay_agent`; off → 404 on these routes, cards unchanged):
 *   GET    /v1/payments/method                          → PayMethodView
 *   POST   /v1/payments/method/challenge {payment_method} → {challenge}  (sign it as is, like a card: `.approve`)
 *   PUT    /v1/payments/method {payment_method, proof}  → {method}      (proof checked by the payment agent)
 *   DELETE /v1/payments/method                          → {removed}     (live tokens revoked too)
 *   POST   /v1/payments/method/link {person}            → {link}            (issuer wise: opens the Wise account, KYC by Wise)
 *   POST   /v1/payments/method/link/url                 → {url, expires_at} (Wise-hosted verification, ~5 min; the core sets the return)
 *   GET    /v1/payments/method/balance                  → {balances}
 *   PUT    /v1/payments/method/card {number, exp_month, exp_year, holder, keep_cvv?, cvv?} → {method}  (own_card, Lokkal)
 *   POST   /v1/payments/method/cvv-mode {keep, cvv?}    → {cvv_kept}
 *   POST   /v1/payments/mandates/{id}/cvv|otp {value}   → {accepted}   (own_card: only what the agent asked, once)
 *   GET|POST /v1/local/passkeys[/options], DELETE /v1/local/passkeys/{device_id}   (passkey of this machine)
 *   POST   /v1/payments/mandates/{id}/revoke            → PayCard (+ agent)
 *   GET    /v1/payments/mandates/{id}/3ds               → ThreeDSPending  (issuer `wise`: bank confirmation waiting)
 *   POST   /v1/payments/mandates/{id}/3ds {challenge_id, proof | decline: true} → PayCard (+ agent); 410 = expired
 * Issuer `wise` (core PAY-AGENT §10, default): a virtual card in the person's name, reserved to ONE purchase, capped
 * to the mandate. 3-D Secure arrives as `payment.agent` with `agent.threeds`; the person confirms with a SECOND passkey
 * on the details the issuer sent (challenge `nokker-3ds`, signed as is with `.approve`), never with the mandate's.
 * The card is typed into Stripe's Payment Element (Stripe.js from js.stripe.com): Nokker only gets a `pm_…`, which
 * never comes back from the core. When the signed mandate says so (`pay_by: "agent"`), the payment agent issues ONE
 * bounded Shared Payment Token (currency, max amount, expiry, seller); 3-D Secure comes back as `payment.agent` with
 * `next_action` for `stripe.handleNextAction`.
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
  handoff: { kind: "browser"; url: string | null } | { kind: "qr_bill" | "pain001" | "agent" | (string & {}) };
  /** Payment agent (flag `pay_agent`): present only when the signed mandate hands the payment to the agent. */
  pay_by?: "agent";
  agent?: AgentTokenState | null;
  /** Only in the `payment.to_pay` event. */
  thread_id?: string;
  strength?: string;
}

/** What the core keeps of a Shared Payment Token: never its `spt_…` number. */
export interface AgentTokenState {
  id?: string;
  /** `card`: virtual card of the issuer `wise`; absent: Stripe Shared Payment Token. */
  kind?: "card" | (string & {});
  status: "active" | "requires_action" | "deactivated" | (string & {});
  used?: boolean;
  currency?: string;
  max_amount_minor?: number;
  expires_at?: number;
  deactivated_reason?: string | null;
  /** Issuer `wise`: a bank confirmation (3-D Secure) waiting for the person. */
  threeds?: ThreeDSSummary;
  /** Issuer `own_card` (Lokkal): what the bank asks the person for THIS payment — never a value. */
  prompt?: PayPrompt;
}

/** own_card: `cvv` (security code of this payment), `otp` (code received from the bank, typed by the payment agent's
 * component — never the model), `bank_app` (confirm in the bank's app; the agent waits without touching). */
export interface PayPrompt {
  kind: "cvv" | "otp" | "bank_app" | (string & {});
  /** Unix seconds. */
  expires_at: number;
}

/** own_card: the person's card as the payment agent describes it (brand, last four, expiry — never the number). */
export interface OwnCard extends PayMethod {
  /** The security code is kept in the machine's vault (else asked for each payment). */
  cvv_kept?: boolean;
}

/** Sent ONCE to the local payment agent (Lokkal), which writes it to the machine's vault; nothing else keeps it. */
export interface OwnCardInput {
  number: string;
  exp_month: number;
  exp_year: number;
  holder: string;
  keep_cvv?: boolean;
  cvv?: string;
}

/** A passkey of THIS machine (Lokkal, rpId localhost). */
export interface LocalPasskey {
  device_id: string;
  credential_id: string;
  name: string;
  created_at: number;
}

export interface LocalPasskeyOptions {
  challenge: string;
  rp_id: string;
  rp_name: string;
  user: { id: string; name: string; display_name: string };
  pub_key_cred_params: { type: "public-key"; alg: number }[];
  exclude_credentials: string[];
  timeout_ms?: number;
}

export interface LocalPasskeyRegistration {
  challenge: string;
  credential_id: string;
  /** SPKI DER from `AuthenticatorAttestationResponse.getPublicKey()`, base64url. */
  public_key_spki: string;
  /** -7 (ES256) only. */
  public_key_alg: number;
  client_data_json: string;
  name?: string;
}

/** A 3-D Secure confirmation as the issuer sent it (no card number, no transaction reference). */
export interface ThreeDSSummary {
  challenge_id: string;
  amount_minor: number;
  currency: string;
  /** As the issuer names it (one line, ≤ 60 characters on the core side). */
  merchant: string;
  /** Unix seconds: after it, the answer no longer counts (410). */
  expires_at: number;
}

export interface ThreeDSPending extends ThreeDSSummary {
  merchant_url: string | null;
  merchant_country: string | null;
  /** `host`: the issuer's merchant URL is the approved merchant's; `unverified`: the issuer sent no URL. */
  merchant_match: "host" | "unverified" | (string & {});
  /** Canonical JSON `{"aud":"nokker-3ds",…}` to sign as is with the passkey (`.approve`). */
  challenge: string;
}

/** The person's registered payment method, as the payment agent describes it (no `pm_…`, no card number). */
export interface PayMethod {
  /** `wise_card` (issuer wise), `card`, `link`… */
  kind: string;
  /** `wise` | `stripe_spt` (absent on older cores: stripe_spt). */
  issuer?: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  created_at: number;
}

/** Identity sent once to open the person's Wise account (the payment agent passes it to Wise, keeps none of it). */
export interface PayLinkPerson {
  first_name: string;
  last_name: string;
  /** YYYY-MM-DD */
  date_of_birth: string;
  address_line: string;
  city: string;
  post_code?: string;
  /** ISO 3166-1 alpha-3, lower case: `che`, `fra`… */
  country_iso3: string;
  email: string;
  /** E.164: `+41…` */
  phone: string;
}

/** The Wise account opened by the payment agent: its verification state at Wise. */
export interface PayLink {
  /** NEW | WAITING_CUSTOMER_INPUT | PROCESSING | PASSED | PASSED_WITH_REQUIREMENTS (as Wise says it). */
  state: string;
  required_by: string | null;
  updated_at?: number;
}

export interface PayBalance {
  currency: string;
  amount_minor: number;
}

export interface PayMethodView {
  /** `wise` (default) or `stripe_spt`; absent on older cores (stripe_spt). */
  issuer?: string;
  /** Issuer wise: the account opened at Wise for this person, or null. */
  link?: PayLink | null;
  /** `pk_…` for Stripe.js (stripe_spt); null when the core has none configured (then no card can be added). */
  publishable_key: string | null;
  method: PayMethod | null;
}

export interface PayMethodProof {
  challenge: string;
  device_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
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
/** Payment agent: token issued, 3-D Secure needed (`next_action`), used, deactivated. */
export interface PaymentAgentEvent {
  type: "payment.agent";
  mandate_id: string;
  approval_id: string;
  account: string | null;
  merchant: string;
  amount_minor: number;
  currency: string;
  agent: AgentTokenState;
  /** `hashedValue` for `stripe.handleNextAction` (3-D Secure), only when the bank asks. */
  next_action?: string;
}
export type PaymentEvent = PaymentToPayEvent | PaymentSignedEvent | PaymentRejectedEvent | PaymentRefusedEvent | PaymentBudgetChangedEvent | PaymentAgentEvent;

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
