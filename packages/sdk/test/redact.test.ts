import { describe, expect, it } from "vitest";
import { avsValid, checkVectors, dialectProblem, ibanValid, luhnValid, maskText, REDACT_RULES_SNAPSHOT as R, unmaskForDisplay, unmaskText, type RedactDict } from "../src/index.js";

describe("masquage sur l'appareil (P9b)", () => {
  it("la copie embarquée passe ses vecteurs et respecte le dialecte commun", () => {
    expect(checkVectors(R)).toEqual([]);
    for (const r of R.rules) expect(dialectProblem(r.pattern), r.id).toBeNull();
    expect(dialectProblem("(?<=a)b")).toBe("lookbehind");
    expect(dialectProblem("\\bx")).toBe("word_boundary");
    expect(dialectProblem("\\p{L}")).toBe("unicode_property");
    expect(dialectProblem("a++")).toBe("possessive");
  });
  it("validateurs", () => {
    expect(ibanValid("CH93 0076 2011 6238 5295 7")).toBe(true);
    expect(ibanValid("CH93 0076 2011 6238 5295 8")).toBe(false);
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("0000000000000000")).toBe(false);
    expect(avsValid("756.9217.0769.85")).toBe(true);
  });
  it("marqueurs stables dans un fil, même valeur = même marqueur, idempotent, démasquage à l'affichage", () => {
    const dict: RedactDict = {};
    const a = maskText("Appelle le 079 123 45 67 puis écris à a@example.ch", R, dict);
    expect(a.text).toBe("Appelle le ⟦PHONE-1⟧ puis écris à ⟦EMAIL-1⟧");
    expect(a.meta).toEqual({ rules_version: R.version, counts: { PHONE: 1, EMAIL: 1 } });
    Object.assign(dict, a.added);
    const b = maskText("Rappelle le 0791234567 et le 022 345 67 89", R, dict);
    expect(b.text).toBe("Rappelle le ⟦PHONE-1⟧ et le ⟦PHONE-2⟧");
    expect(Object.keys(b.added)).toEqual(["⟦PHONE-2⟧"]);
    Object.assign(dict, b.added);
    expect(maskText(b.text, R, dict).text).toBe(b.text);
    // La personne laisse une valeur en clair.
    expect(maskText("écris à a@example.ch", R, dict, { keep: new Set(["a@example.ch"]) }).text).toBe("écris à a@example.ch");
    // Familles choisies seulement.
    expect(maskText("079 123 45 67 / a@example.ch", R, dict, { kinds: new Set(["email"]) }).text).toBe("079 123 45 67 / ⟦EMAIL-1⟧");
    expect(unmaskForDisplay("J'ai noté ⟦PHONE-1⟧ et ⟦IBAN-1⟧.", dict)).toEqual([{ text: "J'ai noté " }, { marker: "⟦PHONE-1⟧", value: "079 123 45 67" }, { text: " et " }, { marker: "⟦IBAN-1⟧", value: null }, { text: "." }]);
    expect(unmaskText("⟦PHONE-2⟧ ⟦CARD-9⟧", dict)).toBe("022 345 67 89 ⟦CARD-9⟧");
    // Un marqueur que cet appareil n'a pas émis dans ce fil (dictionnaire d'un autre fil) reste tel quel.
    expect(unmaskText("⟦PHONE-1⟧", {})).toBe("⟦PHONE-1⟧");
  });
});
