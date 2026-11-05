/**
 * Commun aux recettes e2e : le web sous `vite` (dev) ou, avec E2E_PREVIEW=1, le BUILD sous `vite preview` — celui-ci
 * sert les en-têtes de sécurité de deploy/web/security-headers.conf (CSP comprise), comme nginx en prod.
 * E2E_PREVIEW_PREBUILT=1 : le build est déjà fait (un seul build pour tout un passage).
 * E2E_CSP_LOG=<fichier> : chaque violation CSP de la page (événement securitypolicyviolation) y est ajoutée en JSON.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PREVIEW_MODE = process.env.E2E_PREVIEW === "1";
let built = process.env.E2E_PREVIEW_PREBUILT === "1";

/** Arguments de `npx` pour lancer le web (après le build si besoin). */
export function webCommand() {
  if (PREVIEW_MODE && !built) {
    const b = spawnSync("npx", ["vite", "build"], { cwd: WEB, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, VITE_NOKKER_SHOW_ME: process.env.VITE_NOKKER_SHOW_ME ?? "1", VITE_NOKKER_GUIDE: process.env.VITE_NOKKER_GUIDE ?? "1" } });
    if (b.status !== 0) throw new Error("vite build failed");
    built = true;
  }
  return PREVIEW_MODE ? ["vite", "preview"] : ["vite"];
}

/** Relève les violations CSP d'une page (rapport ET blocage) dans E2E_CSP_LOG. */
export function cspWatch(page, where) {
  const log = process.env.E2E_CSP_LOG;
  if (!log) return;
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.warn(`NKCSP ${JSON.stringify({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample, disposition: e.disposition, page: location.pathname })}`);
    });
  });
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("NKCSP ")) appendFileSync(log, `${JSON.stringify({ script: process.argv[1]?.split("/").pop(), where: where(), ...JSON.parse(t.slice(6)) })}\n`);
  });
}
