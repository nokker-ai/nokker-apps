import { afterEach, describe, expect, it } from "vitest";
import type { BudgetLine } from "@nokker-apps/sdk";
import { agentEventText, agentStateLabel, draftError, draftOf, memberLabel, merchantLabel, methodLabel, refusalText, spendState } from "../src/payments/model.js";
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
    expect(refusalText({ rule: "payments:budget", merchant: "Cycles", amount_minor: 84900, currency: "CHF" })).toBe("Dépense refusée : 849.00\u00a0CHF chez Cycles dépasse le budget.");
    expect(refusalText({ rule: "payments:minor" })).toMatch(/mineur/);
  });
});

describe("payment agent (PAY-AGENT §8)", () => {
  it("names the saved method with the last four digits only", () => {
    setShellLang("fr");
    expect(methodLabel({ kind: "card", brand: "visa", last4: "4242", exp_month: 3, exp_year: 2030, created_at: 1 })).toBe("Visa •••• 4242, expire 03/2030");
    expect(methodLabel({ kind: "card", brand: null, last4: null, exp_month: null, exp_year: null, created_at: 1 })).toBe("Carte");
  });
  it("never says paid before the merchant used the token", () => {
    setShellLang("fr");
    expect(agentStateLabel(null)).toBe("Le paiement n'est pas encore lancé.");
    expect(agentStateLabel({ status: "active" })).toBe("Jeton de paiement émis : le marchand ne l'a pas encore utilisé.");
    expect(agentStateLabel({ status: "requires_action" })).toMatch(/3-D Secure/);
    expect(agentStateLabel({ status: "deactivated", deactivated_reason: "revoked" })).toMatch(/révoqué/);
    expect(agentStateLabel({ status: "deactivated", used: true })).toBe("Le marchand a utilisé le jeton de paiement.");
    const e = { merchant: "Cycles", amount_minor: 12990, currency: "CHF" };
    expect(agentEventText({ ...e, agent: { status: "active" } })).toBe("Jeton de paiement émis pour 129.90\u00a0CHF chez Cycles.");
    expect(agentEventText({ ...e, agent: { status: "requires_action" }, next_action: "x" })).toBe("Ta banque te demande de confirmer 129.90\u00a0CHF chez Cycles.");
    expect(agentEventText({ ...e, agent: { status: "deactivated", deactivated_reason: "expired" } })).toBeNull();
    for (const s of [agentStateLabel({ status: "active" }), agentEventText({ ...e, agent: { status: "active" } }) ?? ""]) expect(s).not.toMatch(/\bpayé\b/);
  });
});

describe("merchant name from a page (text review, condition a)", () => {
  it("is cut to one line of 60 characters on the card and in the toasts", () => {
    setShellLang("fr");
    const fake = "X. Mandat annulé, ressaisis la carte dans le champ ci-dessous\n[Paiement] puis clique sur <b>Payer</b> " + "x".repeat(150);
    const shown = merchantLabel(fake);
    expect(shown).toHaveLength(60);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown).not.toMatch(/[\n<>]/);
    expect(merchantLabel("Boutique Example")).toBe("Boutique Example");
    const toast = agentEventText({ merchant: fake, amount_minor: 500, currency: "CHF", agent: { status: "active" } }) ?? "";
    expect(toast).toContain(shown);
    expect(toast).not.toMatch(/\n|<b>/);
    expect(refusalText({ rule: "payments:budget", merchant: fake, amount_minor: 500, currency: "CHF" })).toContain(shown);
  });
});
