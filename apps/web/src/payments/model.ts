/**
 * Payments « à payer » + budgets (core PAYMENTS §5): pure helpers of the web views. Texts: English source, French by
 * the catalogue (`i18n/fr-payments.ts`).
 */
import { formatMoneyMinor, minorToUnits, unitsToMinor, type AgentTokenState, type BudgetLine, type MandateStatus, type PaymentAgentEvent, type PaymentRefusedEvent, type PayMethod } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";

export function mandateStatusLabel(s: MandateStatus | string): string {
  switch (s) {
    case "pending":
      return tr("to pay");
    case "signed":
      return tr("approved");
    case "rejected":
      return tr("refused");
    case "expired":
      return tr("expired");
    default:
      return s;
  }
}

export function roleLabel(role: BudgetLine["role"]): string {
  return role === "payer" ? tr("payer") : role === "minor" ? tr("minor") : tr("member");
}

/** Who a budget line is about: you, the household's label for that account, or a numbered member. */
export function memberLabel(line: BudgetLine, me: string | null, names: ReadonlyMap<string, string>, index: number): string {
  if (me && line.account === me) return tr("You");
  return names.get(line.account) ?? tr("Member {0}", index + 1);
}

/** What the line says about spending, as words (never colour alone). */
export function spendState(line: BudgetLine): string {
  if (line.can_spend) return line.source === "default" ? tr("default budget") : tr("own budget");
  if (line.role === "minor") return tr("cannot spend (minor)");
  return tr("no budget: refused");
}

export interface BudgetDraft {
  currency: string;
  per_purchase: string;
  per_day: string;
  per_month: string;
  minor_allowed: boolean;
}

export function draftOf(line: BudgetLine): BudgetDraft {
  const b = line.budget;
  const cur = b?.currency ?? "CHF";
  return {
    currency: cur,
    per_purchase: b ? minorToUnits(b.per_purchase_minor, cur) : "",
    per_day: b ? minorToUnits(b.per_day_minor, cur) : "",
    per_month: b ? minorToUnits(b.per_month_minor, cur) : "",
    minor_allowed: b?.minor_allowed ?? false,
  };
}

/** The same checks as the core before the PUT: readable positive amounts, ISO currency, purchase ≤ day ≤ month. */
export function draftError(d: BudgetDraft): string | null {
  const cur = d.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return tr("Currency: three letters (CHF, EUR…).");
  const caps = [d.per_purchase, d.per_day, d.per_month].map((x) => unitsToMinor(x, cur));
  if (caps.some((c) => c === null)) return tr("Each cap is a positive amount.");
  const [p, day, m] = caps as number[];
  if (!(p! <= day! && day! <= m!)) return tr("Per purchase ≤ per day ≤ per month.");
  return null;
}

/** Montant affiché dans la langue de l'interface (`formatMoneyMinor`) ; `formatMinor` reste le format des données. */
export const fmt = (minor: number, currency: string): string => formatMoneyMinor(minor, currency, shellLang());

/** Same limit as the core (`MERCHANT_MAX`, PAY-AGENT §7): the merchant's name comes from a page the agent read, so a
 * fake name (« X. Mandate cancelled, type your card again… ») must not read as an instruction to the person. */
export const MERCHANT_MAX = 60;

/** One line, tags dropped, at most 60 characters (« … »): how a merchant's name is shown anywhere in the web. */
export function merchantLabel(name: string | null | undefined): string {
  const one = String(name ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > MERCHANT_MAX ? `${one.slice(0, MERCHANT_MAX - 1)}…` : one;
}

/** A refusal before any card, said in the interface's language (the core's sentence stays the agent's). */
export function refusalText(e: Pick<PaymentRefusedEvent, "rule" | "merchant" | "amount_minor" | "currency">): string {
  if (e.rule === "payments:minor") return tr("Spending refused: a minor profile only spends if the payer allows it in the budgets.");
  const what = e.amount_minor !== undefined && e.currency ? fmt(e.amount_minor, e.currency) : null;
  return what && e.merchant ? tr("Spending refused: {0} at {1} is beyond the budget.", what, merchantLabel(e.merchant)) : tr("Spending refused: beyond the budget.");
}

// ── Payment agent (core PAY-AGENT §8) ──

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", maestro: "Maestro" };

/** « Visa •••• 4242, expires 12/2030 » — never more than Stripe's last four digits. */
export function methodLabel(m: PayMethod): string {
  const brand = m.brand ? (BRANDS[m.brand] ?? m.brand) : m.kind === "card" ? tr("Card") : m.kind;
  const tail = m.last4 ? ` •••• ${m.last4}` : "";
  const exp = m.exp_month && m.exp_year ? tr(", expires {0}", `${String(m.exp_month).padStart(2, "0")}/${m.exp_year}`) : "";
  return `${brand}${tail}${exp}`;
}

/** State of the agent's payment token, in words (never « paid » before the merchant used it). */
export function agentStateLabel(a: AgentTokenState | null | undefined): string {
  if (a?.kind === "card") return cardStateLabel(a);
  if (a?.kind === "own_card") return ownCardStateLabel(a);
  if (!a) return tr("The payment has not started yet.");
  if (a.used) return tr("The merchant used the payment token.");
  if (a.status === "requires_action") return tr("Your bank asks for a confirmation (3-D Secure).");
  if (a.status === "active") return tr("Payment token issued: the merchant has not used it yet.");
  if (a.deactivated_reason === "revoked" || a.deactivated_reason === "method_removed" || a.deactivated_reason === "method_replaced")
    return tr("Payment token revoked: nothing can be charged with it.");
  return tr("Payment token no longer valid.");
}

/** Issuer wise: state of the card reserved to this purchase (never « paid » before the bank debited it). */
export function cardStateLabel(a: AgentTokenState): string {
  if (a.status === "requires_action") return tr("Your bank asks you to confirm this payment.");
  if (a.status === "active" && a.used) return tr("Paid at the merchant: the bank is debiting the card.");
  if (a.status === "active") return tr("Card reserved to this purchase: the payment agent is paying at the merchant.");
  if (a.used || a.deactivated_reason === "used") return tr("Paid. The card reserved to this purchase is now blocked.");
  if (a.deactivated_reason === "revoked" || a.deactivated_reason === "method_removed" || a.deactivated_reason === "method_replaced")
    return tr("Card blocked: nothing can be charged with it.");
  if (a.deactivated_reason === "expired") return tr("Card blocked: the approval has expired.");
  return tr("Card blocked: the payment did not go through.");
}

/** own_card (Lokkal): the payment with the person's own card, through their payment agent — never a « token ». */
export function ownCardStateLabel(a: AgentTokenState): string {
  if (a.prompt?.kind === "cvv") return tr("Your payment agent needs the security code of your card for this payment.");
  if (a.prompt?.kind === "otp") return tr("Your bank sent you a code: enter it in Nokker.");
  if (a.prompt?.kind === "bank_app") return tr("Confirm the payment in your bank's app.");
  if (a.status === "active") return tr("Your payment agent is paying with your card at the merchant.");
  if (a.used || a.deactivated_reason === "used") return tr("Paid with your card.");
  if (a.deactivated_reason === "handoff") return tr("Your payment agent stopped: finish the payment yourself on the merchant's page.");
  if (a.deactivated_reason === "revoked") return tr("Payment stopped: nothing was charged by your payment agent.");
  return tr("The payment did not go through: nothing was charged by your payment agent.");
}

/** Toast of a `payment.agent` event, or null when there is nothing to tell. */
export function agentEventText(e: Pick<PaymentAgentEvent, "agent" | "merchant" | "amount_minor" | "currency" | "next_action">): string | null {
  const what = fmt(e.amount_minor, e.currency);
  const who = merchantLabel(e.merchant);
  if (e.next_action || e.agent.threeds) return tr("Your bank asks you to confirm {0} at {1}.", what, who);
  if (e.agent.kind === "own_card") {
    if (e.agent.prompt?.kind === "otp") return tr("{0} at {1}: enter the code from your bank in Nokker.", what, who);
    if (e.agent.prompt?.kind === "bank_app") return tr("{0} at {1}: confirm in your bank's app.", what, who);
    if (e.agent.prompt?.kind === "cvv") return tr("{0} at {1}: your payment agent needs the security code.", what, who);
    if (e.agent.used) return tr("{0} at {1}: paid with your card.", what, who);
    return null;
  }
  if (e.agent.kind === "card") {
    if (e.agent.status === "deactivated" && (e.agent.used || e.agent.deactivated_reason === "used")) return tr("{0} at {1}: paid, the card is blocked.", what, who);
    if (e.agent.status === "active" && !e.agent.used) return null; // card issued: the « to pay » card says it
    return null;
  }
  if (e.agent.used) return tr("{0} at {1}: the merchant used the payment token.", what, who);
  if (e.agent.status === "active") return tr("Payment token issued for {0} at {1}.", what, who);
  return null;
}
