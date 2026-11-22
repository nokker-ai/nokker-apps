/**
 * Dérive de la copie embarquée des règles de masquage (P9b) : la source qui fait foi est l'export du noyau
 * (`GET /v1/redact/rules`). Avec `NOKKER_CORE_REDACT_RULES=<fichier JSON de cet export>`, la copie doit avoir les
 * mêmes règles (ids, motifs, validateurs, contextes) et les mêmes vecteurs ; sans le fichier, le test le dit et passe.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkVectors, compareRedactRules, REDACT_RULES_SNAPSHOT, type RedactRules } from "../src/index.js";

const path = process.env.NOKKER_CORE_REDACT_RULES;

describe("copie embarquée des règles de masquage", () => {
  it("passe ses propres vecteurs", () => expect(checkVectors(REDACT_RULES_SNAPSHOT)).toEqual([]));
  it("compareRedactRules voit une règle changée et un vecteur manquant", () => {
    const core: RedactRules = { ...REDACT_RULES_SNAPSHOT, rules: REDACT_RULES_SNAPSHOT.rules.map((r) => (r.id === "email" ? { ...r, pattern: r.pattern + "x" } : r)), vectors: REDACT_RULES_SNAPSHOT.vectors.slice(1) };
    const d = compareRedactRules(REDACT_RULES_SNAPSHOT, core);
    expect(d).toContain("email.pattern diffère");
    expect(d.some((x) => x.startsWith("vecteur absent du noyau"))).toBe(true);
    expect(compareRedactRules(REDACT_RULES_SNAPSHOT, REDACT_RULES_SNAPSHOT)).toEqual([]);
  });
  it.skipIf(!path)("suit l'export du noyau (NOKKER_CORE_REDACT_RULES)", () => {
    const core = JSON.parse(readFileSync(path!, "utf8")) as RedactRules;
    expect(checkVectors(core)).toEqual([]);
    expect(compareRedactRules(REDACT_RULES_SNAPSHOT, core)).toEqual([]);
  });
});
