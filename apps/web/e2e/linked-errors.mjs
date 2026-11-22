/**
 * Recette « machines liées en erreur » (bug de prod 47.1, hotfix r47.2) : un compte avec DEUX machines Lokkal liées
 * en ligne, dont la passerelle ne répond pas (connexion refusée ; en E2E_PREVIEW=1, la CSP réelle la bloque en plus),
 * et dont le deck de la seconde porte des dates inattendues (nombre, null — MOCK_DECK_ODD=1). L'interface DOIT
 * s'afficher : composeur, tiroir avec les fils du cloud et ceux du deck, aucune erreur de page.
 * 1280 clair FR et 390 sombre EN. Usage : `node e2e/linked-errors.mjs` (E2E_SHOTS=<dossier>, E2E_PREVIEW=1).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { cspWatch, webCommand } from "./web-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const MOCK = resolve(WEB, "../../packages/mock-server");
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 20000);
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : null;

const freePort = () =>
  new Promise((ok, ko) => {
    const s = createServer();
    s.once("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function waitHttp(url, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* pas encore */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} injoignable`);
}

const mockPort = await freePort();
const webPort = await freePort();
const dead1 = await freePort();
const dead2 = await freePort();
const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-linked-"));
const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_CAPABILITIES: "1", MOCK_GATEWAY_TOKEN: "gw_e2e", MOCK_DECK_ODD: "1" };
const procs = [
  spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
  spawn("npx", [...webCommand(), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB, env: { ...process.env, NOKKER_SERVER_URL: `http://127.0.0.1:${mockPort}` }, stdio: ["ignore", "ignore", "inherit"], detached: true }),
];
const stop = () => {
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* parti */
    }
  }
  rmSync(cfg, { recursive: true, force: true });
};
process.on("exit", stop);
await waitHttp(`http://127.0.0.1:${mockPort}/`);
const link = (b) => fetch(`http://127.0.0.1:${mockPort}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
// Deux machines EN LIGNE dont la passerelle ne répond pas (ports fermés).
await link({ linked: true, machine: "atelier", last_seen_s: 3, host: `127.0.0.1:${dead1}`, mirror: true });
await link({ linked: true, machine: "bureau", last_seen_s: 5, host: `127.0.0.1:${dead2}`, mirror: true });
const base = `http://localhost:${webPort}`;
await waitHttp(base);

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [dev, opts] of [
  ["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }],
  ["phone-dark-en", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", locale: "en-US" }],
]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  cspWatch(page, () => page.url());
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base);
    await page.waitForSelector("#wl-email", { timeout: STEP_MS });
    await page.fill("#wl-email", "alice@example.com");
    await page.click("form button[type=submit]");
    await page.waitForSelector("#wl-code", { timeout: STEP_MS });
    await page.fill("#wl-code", "123456");
    await page.keyboard.press("Enter");
    // L'interface s'affiche (pas d'écran blanc) et reste debout le temps de lire les machines.
    await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
    await page.waitForTimeout(6000);
    if (!(await page.locator("#nk-composer").isVisible())) throw new Error("l'interface est tombée après la lecture des machines");
    if (dev.includes("phone")) await page.locator(".drawer-fab").click();
    await page.waitForSelector("#nk-drawer .session-row", { timeout: STEP_MS });
    if (!(await page.locator("#nk-drawer .session-row.remote").count())) throw new Error("les fils du deck des machines ne s'affichent pas");
    if (errors.length) throw new Error(`erreur de page : ${errors[0]}`);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `linked-errors-${dev}.png`) });
    }
    report.push(`ok   linked-errors ${dev}`);
  } catch (e) {
    failed++;
    report.push(`FAIL linked-errors ${dev}: ${e.message}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `FAIL-linked-errors-${dev}.png`) }).catch(() => {});
  } finally {
    await ctx.close();
  }
}
await browser.close();
stop();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
