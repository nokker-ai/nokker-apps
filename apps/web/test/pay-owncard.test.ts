import { afterEach, describe, expect, it } from "vitest";
import { agentEventText, agentStateLabel, ownCardStateLabel } from "../src/payments/model.js";
import { cardNumberOk, parseExpiry } from "../src/payments/OwnCardAccount.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

describe("« ta carte » (own_card, Lokkal, PAY-AGENT §11)", () => {
  it("checks the card like the payment agent before sending it", () => {
    expect(cardNumberOk("4242 4242 4242 4242")).toBe(true);
    expect(cardNumberOk("4242-4242-4242-4241")).toBe(false);
    expect(cardNumberOk("12345")).toBe(false);
    const now = new Date(2026, 10, 3);
    expect(parseExpiry("12/31", now)).toEqual([12, 2031]);
    expect(parseExpiry("1/2027", now)).toEqual([1, 2027]);
    expect(parseExpiry("10/26", now)).toBeNull();
    expect(parseExpiry("13/30", now)).toBeNull();
  });
  it("says the payment's state in words, never a « token »", () => {
    expect(ownCardStateLabel({ kind: "own_card", status: "active", prompt: { kind: "otp", expires_at: 1 } })).toMatch(/code/);
    expect(ownCardStateLabel({ kind: "own_card", status: "active", prompt: { kind: "bank_app", expires_at: 1 } })).toMatch(/bank's app/);
    expect(ownCardStateLabel({ kind: "own_card", status: "deactivated", used: true, deactivated_reason: "used" })).toMatch(/^Paid with your card/);
    expect(ownCardStateLabel({ kind: "own_card", status: "deactivated", deactivated_reason: "handoff" })).toMatch(/yourself/);
    for (const s of ["active", "deactivated"]) expect(agentStateLabel({ kind: "own_card", status: s })).not.toMatch(/token/);
  });
  it("toasts what the bank asks, on one line, and nothing else", () => {
    const base = { merchant: "Boutique\nX", amount_minor: 4290, currency: "CHF" };
    expect(agentEventText({ ...base, agent: { kind: "own_card", status: "active", prompt: { kind: "otp", expires_at: 1 } } })).toBe("CHF\u00a042.90 at Boutique X: enter the code from your bank in Nokker.");
    expect(agentEventText({ ...base, agent: { kind: "own_card", status: "active" } })).toBeNull();
  });
  it("is in French too", () => {
    setShellLang("fr");
    expect(ownCardStateLabel({ kind: "own_card", status: "active", prompt: { kind: "otp", expires_at: 1 } })).toBe("Ta banque t'a envoyé un code : entre-le dans Nokker.");
  });
});
