/**
 * Toute variable VITE_* lue par le code web doit pouvoir se lever à la construction de l'image : déclarée en ARG dans
 * deploy/web/Dockerfile et exportée par sa boucle. Sinon `--build-arg` est ignoré en silence (KIOSK le 07.11, puis
 * NINA_LIVE). VITE_PWA_KILL passe par l'ARG PWA_KILL.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const DOCKERFILE = readFileSync(join(ROOT, "deploy/web/Dockerfile"), "utf8");
const SOURCES = [join(ROOT, "apps/web/src"), ...readdirSync(join(ROOT, "packages")).map((p) => join(ROOT, "packages", p, "src"))];
const VIA_OTHER_ARG: Record<string, string> = { VITE_PWA_KILL: "PWA_KILL" };

function files(dir: string): string[] {
  let st;
  try { st = statSync(dir); } catch { return []; }
  if (!st.isDirectory()) return /\.(ts|tsx|js|mjs)$/.test(dir) ? [dir] : [];
  return readdirSync(dir).flatMap((n) => (n === "node_modules" || n === "dist" ? [] : files(join(dir, n))));
}

/** Lectures réelles : `import.meta.env.VITE_X`, `import.meta.env?.VITE_X`, `env.VITE_X` (alias de import.meta.env). */
function readVars(): Set<string> {
  const out = new Set<string>();
  const re = /(?:import\.meta\.env\??\.|\benv\??\.)(VITE_[A-Z0-9_]+)/g;
  for (const f of SOURCES.flatMap(files)) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(re)) out.add(m[1]);
  }
  return out;
}

function loopVars(): Set<string> {
  const m = DOCKERFILE.match(/RUN for v in ([\s\S]*?); do/);
  return new Set((m?.[1] ?? "").replace(/\\\n/g, " ").split(/\s+/).filter(Boolean));
}

describe("Dockerfile web : variables VITE_* de construction", () => {
  const read = readVars();

  it("trouve les lectures connues (garde-fou du motif)", () => {
    expect(read.has("VITE_NOKKER_KIOSK")).toBe(true);
    expect(read.has("VITE_PWA_KILL")).toBe(true);
  });

  it("chaque variable lue par le code est déclarée en ARG et exportée par la boucle", () => {
    const loop = loopVars();
    const missing = [...read].sort().filter((v) => {
      const arg = VIA_OTHER_ARG[v] ?? v;
      return !new RegExp(`^ARG ${arg}=`, "m").test(DOCKERFILE) || (!VIA_OTHER_ARG[v] && !loop.has(v));
    });
    expect(missing, `à déclarer dans deploy/web/Dockerfile (ARG + boucle) : ${missing.join(", ")}`).toEqual([]);
  });

  it("chaque ARG VITE_* est aussi dans la boucle d'export (et réciproquement)", () => {
    const args = new Set([...DOCKERFILE.matchAll(/^ARG (VITE_[A-Z0-9_]+)=/gm)].map((m) => m[1]));
    expect([...args].sort()).toEqual([...loopVars()].sort());
  });
});
