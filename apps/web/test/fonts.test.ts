import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("polices servies par le paquet (LOKKAL-PHONE §1.1 W5)", () => {
  it("rien de Google Fonts dans la page ni dans la CSP ; chaque fichier de fonts.css existe, avec sa licence", () => {
    expect(read("apps/web/index.html")).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const csp = read("deploy/web/security-headers.conf");
    expect(csp).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(csp).toMatch(/font-src 'self';/);
    const css = read("packages/brand/assets/fonts/fonts.css");
    const files = [...css.matchAll(/url\(\/brand\/fonts\/([^)]+)\)/g)].map((m) => m[1]!);
    expect(files.length).toBe(16);
    for (const f of files) expect(existsSync(resolve(root, "packages/brand/assets/fonts", f)), f).toBe(true);
    for (const fam of ["Cinzel", "IBM Plex Sans", "IBM Plex Mono"]) expect(css).toContain(`font-family: '${fam}'`);
    for (const l of ["cinzel", "ibm-plex-sans", "ibm-plex-mono"]) expect(read(`packages/brand/assets/fonts/LICENSE-${l}.txt`)).toMatch(/SIL Open Font License/);
  });
});
