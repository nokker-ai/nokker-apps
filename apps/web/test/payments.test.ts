import { afterEach, describe, expect, it } from "vitest";
import type { BudgetLine } from "@nokker-apps/sdk";
import { draftError, draftOf, memberLabel, refusalText, spendState } from "../src/payments/model.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));
const line = (x: Partial<BudgetLine>): BudgetLine => ({ account: "us_a", role: "member", source: "none", budget: null, can_spend: false, ...x });
const chf = { account: "us_a", currency: "CHF", per_purchase_minor: 5000, per_day_minor: 10000, per_month_minor: 30000, minor_allowed: false, set_by: "us_p", updated_at: 1 };

describe("payments model (PAYMENTS §5)", () => {
  it("a budget becomes the units a PUT takes, and back", () => {
    expect(draftOf(line({ source: "set", budget: chf, can_spend: true }))).toEqual({ currency: "CHF", per_purchase: "50", per_day: "100", per_month: "300", minor_allowed: false });
    expect(draftOf(line({}))).toMatchObject({ currency: "CHF", per_purchase: "" });
  });
  it("checks the caps like the core before saving", () => {
    const ok = { currency: "chf", per_purchase: "20", per_day: "20", per_month: "49,90", minor_allowed: false };
    expect(draftError(ok)).toBeNull();
    expect(draftError({ ...ok, per_purchase: "30" })).toMatch(/Per purchase ≤ per day/);
    expect(draftError({ ...ok, per_day: "0" })).toMatch(/positive/);
    expect(draftError({ ...ok, currency: "francs" })).toMatch(/three letters/);
  });
  it("says who and what in words, in the interface language", () => {
    setShellLang("fr");
    const names = new Map([["us_b", "sam@example.com"]]);
    expect(memberLabel(line({ account: "us_me" }), "us_me", names, 0)).toBe("Toi");
    expect(memberLabel(line({ account: "us_b" }), "us_me", names, 1)).toBe("sam@example.com");
    expect(memberLabel(line({ account: "us_c" }), "us_me", names, 2)).toBe("Membre 3");
    expect(spendState(line({ role: "minor" }))).toBe("ne dépense pas (mineur)");
    expect(spendState(line({ role: "payer", source: "default", budget: chf, can_spend: true }))).toBe("budget par défaut");
    expect(refusalText({ rule: "payments:budget", merchant: "Cycles", amount_minor: 84900, currency: "CHF" })).toBe("Dépense refusée : 849.00 CHF chez Cycles dépasse le budget.");
    expect(refusalText({ rule: "payments:minor" })).toMatch(/mineur/);
  });
});
