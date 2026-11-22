/** Accessibilité : le pinch-zoom reste possible (pas de maximum-scale ni de user-scalable=no) ; iOS zoome au focus d'un champ
 * < 16 px, ce que l'e2e téléphone vérifie sur chaque écran (`smallFields`). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("viewport", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const content = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
  it("ne bloque pas le zoom", () => {
    expect(content).toContain("width=device-width");
    expect(content).not.toMatch(/maximum-scale/i);
    expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
  });
});
