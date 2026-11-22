import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasFont, flowEligible, lineHeightPx, pretextEnabled } from "../src/pretext/pretext.js";

describe("V5 Pretext : drapeau, éligibilité, polices", () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("éteint par défaut ; allumé par le drapeau de build ou de recette", () => {
    expect(pretextEnabled()).toBe(false);
    mem.set("nokker.web.pretext", "1");
    expect(pretextEnabled()).toBe(true);
    mem.clear();
    vi.stubEnv("VITE_NOKKER_PRETEXT", "1");
    expect(pretextEnabled()).toBe(true);
  });

  it("une valeur mémorisée « 0 » éteint même si le build allume ; « 1 » allume sans build", () => {
    vi.stubEnv("VITE_NOKKER_PRETEXT", "1");
    mem.set("nokker.web.pretext", "0");
    expect(pretextEnabled()).toBe(false);
    mem.set("nokker.web.pretext", "1");
    expect(pretextEnabled()).toBe(true);
  });

  it("seuls les paragraphes de texte brut sont éligibles (la mesure du texte brut = la hauteur rendue)", () => {
    expect(flowEligible("Voici une réponse simple, sur une seule ligne de texte.")).toBe(true);
    for (const bad of ["", "   ", "deux\nparagraphes", "du **gras**", "du `code`", "# titre", "- une liste", "1. un item", "a | b", "[lien](x)", "> citation"]) {
      expect(flowEligible(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("police en notation canvas, interligne en pixels", () => {
    expect(canvasFont({ fontStyle: "normal", fontWeight: "600", fontSize: "16px", fontFamily: "Inter, sans-serif" })).toBe("600 16px Inter, sans-serif");
    expect(canvasFont({ fontStyle: "italic", fontWeight: "400", fontSize: "14px", fontFamily: "serif" })).toBe("italic 400 14px serif");
    expect(lineHeightPx({ lineHeight: "24px", fontSize: "16px" })).toBe(24);
    expect(lineHeightPx({ lineHeight: "normal", fontSize: "10px" })).toBeCloseTo(14);
  });
});
