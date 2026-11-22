import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — module .mjs du dépôt, sans types
import { checkPlugins } from "../../../scripts/ios-ci/check-plugins.mjs";

describe("plugins maison de la coque", () => {
  it("chaque plugin enregistré côté Swift est dans NATIVE_PLUGINS (sinon il reste vide dans l'interface)", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const r = checkPlugins(root) as { registered: string[]; problems: string[] };
    expect(r.problems).toEqual([]);
    expect(r.registered).toContain("NokkerVault");
  });
});
