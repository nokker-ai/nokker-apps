/**
 * Payments « à payer » + budgets (core PAYMENTS §5): pure helpers of the web views. Texts: English source, French by
 * the catalogue (`i18n/fr-payments.ts`).
 */
import { formatMinor, minorToUnits, unitsToMinor, type BudgetLine, type MandateStatus, type PaymentRefusedEvent } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

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

export const fmt = formatMinor;

/** A refusal before any card, said in the interface's language (the core's sentence stays the agent's). */
export function refusalText(e: Pick<PaymentRefusedEvent, "rule" | "merchant" | "amount_minor" | "currency">): string {
  if (e.rule === "payments:minor") return tr("Spending refused: a minor profile only spends if the payer allows it in the budgets.");
  const what = e.amount_minor !== undefined && e.currency ? formatMinor(e.amount_minor, e.currency) : null;
  return what && e.merchant ? tr("Spending refused: {0} at {1} is beyond the budget.", what, e.merchant) : tr("Spending refused: beyond the budget.");
}
