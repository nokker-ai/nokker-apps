import { afterEach, describe, expect, it } from "vitest";
import { agentEventText, agentStateLabel, cardStateLabel } from "../src/payments/model.js";
import { timeLeft } from "../src/payments/ThreeDSConfirm.js";
import { linkStateLabel, personError } from "../src/payments/WiseAccount.js";
import { setShellLang } from "../src/i18n/index.js";
import { FR_PAYMENTS } from "../src/i18n/fr-payments.js";

afterEach(() => setShellLang(null));
const person = { first_name: "Alice", last_name: "Example", date_of_birth: "1990-01-31", address_line: "Rue Exemple 1", city: "Genève", post_code: "1200", country_iso3: "che", email: "alice@example.com", phone: "+41790000000" };

describe("payment agent, issuer wise (PAY-AGENT §10)", () => {
  it("checks the identity like the payment agent before sending it to Wise", () => {
    expect(personError(person)).toBeNull();
    expect(personError({ ...person, phone: "079 000 00 00" })).toMatch(/international/);
    expect(personError({ ...person, date_of_birth: "31.01.1990" })).toMatch(/YYYY-MM-DD/);
    expect(personError({ ...person, email: "alice" })).toMatch(/e-mail/);
    expect(personError({ ...person, city: " " })).toMatch(/required/);
    expect(personError({ ...person, country_iso3: "" })).toMatch(/country/);
  });
  it("says the Wise verification state in words, never « verified » before Wise says PASSED", () => {
    expect(linkStateLabel("PASSED")).toMatch(/verified by Wise/);
    expect(linkStateLabel("WAITING_CUSTOMER_INPUT")).toMatch(/waiting for you/);
    expect(linkStateLabel("PROCESSING")).toMatch(/checking/);
    expect(linkStateLabel("NEW")).toMatch(/preparing/);
    expect(linkStateLabel(undefined)).not.toMatch(/verified/);
  });
  it("counts down the bank's delay, never below zero", () => {
    expect(timeLeft(1000 + 125, 1000_000)).toBe("2:05");
    expect(timeLeft(1000, 2000_000)).toBe("0:00");
  });
  it("tells the card's state, never « paid » before the bank says so", () => {
    expect(cardStateLabel({ kind: "card", status: "active" })).toMatch(/reserved to this purchase/);
    expect(cardStateLabel({ kind: "card", status: "requires_action" })).toMatch(/confirm/);
    expect(cardStateLabel({ kind: "card", status: "deactivated", used: true, deactivated_reason: "used" })).toMatch(/^Paid/);
    expect(cardStateLabel({ kind: "card", status: "deactivated", deactivated_reason: "revoked" })).toMatch(/blocked/);
    expect(cardStateLabel({ kind: "card", status: "deactivated", deactivated_reason: "checkout_failed" })).toMatch(/did not go through/);
    expect(agentStateLabel({ kind: "card", status: "active" })).toBe(cardStateLabel({ kind: "card", status: "active" }));
    expect(agentStateLabel({ status: "active" })).toMatch(/token/);
  });
  it("a 3-D Secure request becomes a toast naming amount and merchant on one line", () => {
    const threeds = { challenge_id: "3ds_1", amount_minor: 4290, currency: "CHF", merchant: "BOUTIQUE", expires_at: 1 };
    expect(agentEventText({ agent: { kind: "card", status: "requires_action", threeds }, merchant: "Boutique\nX. Retape ta carte", amount_minor: 4290, currency: "CHF" })).toBe("Your bank asks you to confirm CHF\u00a042.90 at Boutique X. Retape ta carte.");
    expect(agentEventText({ agent: { kind: "card", status: "active" }, merchant: "B", amount_minor: 1, currency: "CHF" })).toBeNull();
  });
  it("every new sentence has its French, and none still says « usage unique » for the card", () => {
    setShellLang("fr");
    expect(linkStateLabel("PASSED")).toBe("Identité vérifiée par Wise.");
    expect(cardStateLabel({ kind: "card", status: "active" })).toBe("Carte réservée à cet achat : l'agent de paiement paie chez le marchand.");
    const card = Object.entries(FR_PAYMENTS).filter(([k]) => /card|Wise|bank|passkey/i.test(k));
    expect(card.some(([, v]) => /usage unique/.test(v) && /carte/.test(v))).toBe(false);
  });
});
