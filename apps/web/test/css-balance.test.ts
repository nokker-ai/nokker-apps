import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Garde-fou : une résolution de conflit a déjà fait sauter une accolade (tout le CSS qui suivait était ignoré
// par le navigateur, sans erreur visible au build).
describe("theme.css", () => {
  it("accolades équilibrées, jamais négatives", () => {
    const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
