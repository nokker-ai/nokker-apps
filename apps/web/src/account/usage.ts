import type { AccountUsage, BillingPrice, BillingStatus, UsageCounter } from "@nokker-apps/sdk";
import { formatMoney } from "@nokker-apps/sdk";

export type UsageKey = "turns" | "browser";
export type UsageLevel = "ok" | "warn" | "full";

export interface UsageRow {
  key: UsageKey;
  used: number;
  cap: number | null;
  /** 0–100, `null` sans plafond. */
  pct: number | null;
  level: UsageLevel;
  /** Au-dessus du quota. */
  over: boolean;
}

export function usagePct(used: number, cap: number | null): number | null {
  if (cap === null || cap === undefined) return null;
  if (cap <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((used / cap) * 100)));
}

export function usageLevel(pct: number | null): UsageLevel {
  if (pct === null) return "ok";
  if (pct >= 100) return "full";
  return pct >= 80 ? "warn" : "ok";
}

/** En mode `soft` (bêta) le dépassement ne coupe rien : la barre ne passe jamais au rouge, elle reste « warn ». */
function row(key: UsageKey, c: UsageCounter, soft: boolean): UsageRow {
  const cap = c.cap ?? null;
  const pct = usagePct(c.used, cap);
  const over = c.over ?? (cap !== null && c.used > cap);
  const level = usageLevel(pct);
  return { key, used: c.used, cap, pct, level: soft && level === "full" ? "warn" : level, over };
}

function rows(w: { turns: UsageCounter; browser?: UsageCounter }, soft: boolean): UsageRow[] {
  const out = [row("turns", w.turns, soft)];
  if (w.browser) out.push(row("browser", w.browser, soft));
  return out;
}

const isSoft = (u: AccountUsage): boolean => u.mode === "soft";

/** `browser` est facultatif côté noyau : affiché seulement s'il est présent. */
export function todayRows(u: AccountUsage): UsageRow[] {
  return rows(u.today, isSoft(u));
}

export function weekRows(u: AccountUsage): UsageRow[] {
  return u.week ? rows(u.week, isSoft(u)) : [];
}

export function monthTurns(u: AccountUsage): number | null {
  return u.month ? u.month.turns.used : null;
}

/** Vrai quand un compteur dépasse son quota alors que rien n'est coupé (bêta). */
export function softOver(u: AccountUsage): boolean {
  return isSoft(u) && [...todayRows(u), ...weekRows(u)].some((r) => r.over);
}

const ZURICH = "Europe/Zurich";
/** « 14:00 » ou « lundi 07:00 », heure de Zurich ; `null` si le noyau n'envoie pas l'échéance. */
export function fmtReset(lang: string, iso: string | undefined, withDay: boolean): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(lang, { timeZone: ZURICH, ...(withDay ? { weekday: "long" } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/** Plafonds d'un palier tels que le noyau les envoie (`turns_per_day`, `turns_per_week`, `household_members` pour un
 * foyer) ; `turns` = ancienne forme du mock, lue en repli. */
export function planCaps(caps: Record<string, number>): { day: number | null; week: number | null; seats: number | null } {
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { day: n(caps.turns_per_day) ?? n(caps.turns), week: n(caps.turns_per_week), seats: n(caps.household_members) };
}

export function planLabel(id: string): string {
  if (id === "byok") return "BYOK";
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

/** Prix d'un palier au format monétaire commun (`formatMoney` du SDK, décision du 05.11) : « 19 CHF » et « 9.50 CHF »
 * (fr), « CHF 19 » et « CHF 9.50 » (en) — entier sans décimales, comme la page tarifs. */
export function fmtAmount(lang: string, price: BillingPrice): string {
  return formatMoney(price.amount, price.currency, lang === "en" ? "en" : "fr", { whole: true });
}

/** Statuts Stripe → clé de libellé ; un statut inconnu reste affiché tel quel. */
export const STATUS_KEYS = {
  active: "accStActive",
  trialing: "accStTrialing",
  past_due: "accStPastDue",
  unpaid: "accStPastDue",
  canceled: "accStCanceled",
  incomplete: "accStIncomplete",
  incomplete_expired: "accStCanceled",
  paused: "accStPaused",
} as const;

export type BillingView =
  | { kind: "none" }
  | { kind: "subscribed"; plan: string; status: string; periodEnd: string | null; cancelling: boolean; trialEnd: string | null };

export function billingView(b: BillingStatus): BillingView {
  if (!b.plan) return { kind: "none" };
  return {
    kind: "subscribed",
    plan: b.plan,
    status: b.status ?? "active",
    periodEnd: b.current_period_end,
    cancelling: b.cancel_at_period_end,
    trialEnd: b.status === "trialing" ? (b.trial_end ?? null) : null,
  };
}

/** Ligne d'échéance sous la formule. Essai résilié (`cancel_at_period_end` pendant l'essai) : il s'arrête à la fin de
 * l'essai, sans débit — jamais « premier débit ce jour-là ». `zurich` : date de fin d'essai (23:59 heure de Zurich). */
export function subscriptionNote(v: BillingView): { key: "accTrialUntil" | "accTrialCancelled" | "accCancelsAt" | "accPeriodEnd"; at: string; zurich: boolean } | null {
  if (v.kind !== "subscribed") return null;
  if (v.trialEnd) return { key: v.cancelling ? "accTrialCancelled" : "accTrialUntil", at: v.trialEnd, zurich: true };
  if (v.periodEnd) return { key: v.cancelling ? "accCancelsAt" : "accPeriodEnd", at: v.periodEnd, zurich: false };
  return null;
}
