import { describe, expect, it } from "vitest";
import { formatMinor, formatMoney, formatMoneyMinor } from "../src/index.js";

describe("montants affichés (format commun du 05.11)", () => {
  it("fr-CH : montant puis devise, point décimal, espaces insécables", () => {
    expect(formatMoney(42.9, "CHF")).toBe("42.90 CHF");
    expect(formatMoney(9.5, "CHF", "fr")).toBe("9.50 CHF");
    expect(formatMoney(1234.5, "CHF")).toBe("1 234.50 CHF");
  });
  it("en-CH : devise devant", () => {
    expect(formatMoney(42.9, "CHF", "en")).toBe("CHF 42.90");
    expect(formatMoney(1234.5, "chf", "en")).toBe("CHF 1'234.50");
  });
  it("unités mineures, et formatMinor garde le format du noyau pour les données", () => {
    expect(formatMoneyMinor(4290, "CHF")).toBe("42.90 CHF");
    expect(formatMoneyMinor(4290, "CHF", "en")).toBe("CHF 42.90");
    expect(formatMinor(4290, "CHF")).toBe("42.90 CHF");
  });
  it("whole : prix entier sans décimales, jamais pour un montant à centimes", () => {
    expect(formatMoney(19, "CHF", "fr", { whole: true })).toBe("19\u00a0CHF");
    expect(formatMoney(19, "CHF", "en", { whole: true })).toBe("CHF\u00a019");
    expect(formatMoney(9.5, "CHF", "fr", { whole: true })).toBe("9.50\u00a0CHF");
    expect(formatMoney(19, "CHF")).toBe("19.00\u00a0CHF");
  });
  it("devise inconnue de l'Intl : même forme", () => {
    expect(formatMoney(3, "XYZ1")).toBe("3.00 XYZ1");
  });
});
