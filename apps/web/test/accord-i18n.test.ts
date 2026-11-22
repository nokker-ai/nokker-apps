import { describe, expect, it } from "vitest";
import { FR_ACCORD } from "../src/i18n/fr-accord.js";
import { DE_ACCORD, IT_ACCORD } from "../src/i18n/accord-de-it.js";

const holes = (s: string): string[] => (s.match(/\{\d+\}/g) ?? []).sort();

describe("ACCORD · quatre langues, mêmes clés, mêmes trous", () => {
  for (const [name, table] of [["fr", FR_ACCORD], ["de", DE_ACCORD], ["it", IT_ACCORD]] as const) {
    it(`${name} : une traduction pour chaque libellé source, rien de plus, mêmes {n}`, () => {
      const base = Object.keys(FR_ACCORD).sort();
      expect(Object.keys(table).sort()).toEqual(base);
      for (const k of base) {
        expect(holes(table[k]!), `${name}: ${k}`).toEqual(holes(k));
        expect(table[k]!.trim(), `${name}: ${k}`).not.toBe("");
      }
    });
  }
  it("pas de vouvoiement ni de politesse en FR", () => {
    for (const v of Object.values(FR_ACCORD)) expect(v).not.toMatch(/\b(vous|votre|vos)\b|\b\w+ez\b(?! )/i);
  });
  it("vocabulaire : « carte d'approbation » (jamais « carte d'accord »)", () => {
    for (const v of Object.values(FR_ACCORD)) expect(v).not.toMatch(/carte[s]? d'accord/);
  });
});
