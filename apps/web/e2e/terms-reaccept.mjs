/**
 * Recette « Les conditions ont changé » (core `terms_outdated`, `POST /v1/account/terms`), dans un vrai Chromium headless
 * contre le mock (MOCK_TERMS_OUTDATED=1 : la dernière version acceptée n'est plus la courante) :
 *  - après la connexion, écran BLOQUANT à la place de l'app (aucun composeur), texte des conditions, langue fr/en ;
 *  - « J'accepte » → l'app s'ouvre ; rechargée, l'écran ne revient pas ;
 *  - sans MOCK_TERMS_OUTDATED : jamais d'écran.
 * À 1280 clair FR et 390 sombre EN. Échoue sur une étape non atteinte, une erreur de page, un 5xx, un 4xx inattendu ou un
 * débordement horizontal. Usage : `node e2e/terms-reaccept.mjs` (E2E_SHOTS=<dossier> pour les captures).
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
const EMAIL = "alice@example.com";
const CODE = "123456";
// /v1/guide : le build de prod (E2E_PREVIEW=1) allume le guide, que le mock de cette recette ne sert pas (404).
const ALLOWED_4XX = [
  [404, /\/v1\/(guide|packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|local\/folder\/runs|payments\/budgets|payments\/mandates|payments\/method|speech|account\/models|capabilities)(\?|$)/],
  [401, /\/v1\/local\//],
];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DEVICES = [
  ["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }],
  ["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }],
];

class StepError extends Error {}

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

async function servers(outdated) {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-terms-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), ...(outdated ? { MOCK_TERMS_OUTDATED: "1" } : {}) };
  const procs = [
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("npx", [...webCommand(), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], {
      cwd: WEB,
      env: { ...process.env, NOKKER_SERVER_URL: `http://127.0.0.1:${mockPort}` },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    }),
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
  const base = `http://localhost:${webPort}`;
  await waitHttp(base);
  return { base, stop };
}

function watch(page, problems) {
  cspWatch(page, () => page.url().replace(/^https?:\/\/[^/]+/, ""));
  page.on("pageerror", (e) => problems.push(`erreur de page : ${e.message}`));
  page.on("response", (r) => {
    const s = r.status();
    if (s < 400) return;
    const url = r.url();
    if (s < 500 && ALLOWED_4XX.some(([code, re]) => code === s && re.test(url))) return;
    problems.push(`HTTP ${s} ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  });
}

async function until(page, what, fn, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout: STEP_MS, polling: 100 });
  } catch {
    throw new StepError(`délai dépassé : ${what}`);
  }
}

async function noOverflow(page, where) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 1) throw new StepError(`${where} : débordement horizontal de ${o}px`);
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

async function login(page, base) {
  await page.goto(base);
  await page.waitForSelector("#wl-email", { timeout: STEP_MS });
  await page.fill("#wl-email", EMAIL);
  await page.click("form button[type=submit]");
  await page.waitForSelector("#wl-code", { timeout: STEP_MS });
  await page.fill("#wl-code", CODE);
  await page.keyboard.press("Enter");
}

const en = (dev) => dev.endsWith("-en");

async function reaccept(page, s, dev) {
  await login(page, s.base);
  await until(page, "écran « les conditions ont changé »", () => !!document.querySelector("[data-terms-reaccept]"));
  if (await page.locator("#nk-composer").count()) throw new StepError("l'app est utilisable derrière l'écran bloquant");
  await until(page, "texte des conditions", () => !!document.querySelector("[data-terms-reaccept] .ob-terms")?.textContent?.match(/Nokker/));
  if (en(dev)) {
    await page.getByRole("button", { name: "EN" }).click();
    await until(page, "texte anglais", () => /beta terms/i.test(document.querySelector("[data-terms-reaccept] .ob-terms")?.textContent ?? ""));
  }
  const title = await page.locator("#reacc-title").innerText();
  if (!(en(dev) ? /terms have changed/i : /conditions ont changé/i).test(title)) throw new StepError(`titre : « ${title} »`);
  await noOverflow(page, "écran de réacceptation");
  await shot(page, `${dev}-reaccept`);
  await page.getByRole("button", { name: en(dev) ? "I accept" : "J'accepte" }).click();
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS }).catch(() => {
    throw new StepError("l'app ne s'ouvre pas après « J'accepte »");
  });
  if (await page.locator("[data-terms-reaccept]").count()) throw new StepError("l'écran reste après l'accord");
  await shot(page, `${dev}-accepted`);
  await page.reload();
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.waitForTimeout(800);
  if (await page.locator("[data-terms-reaccept]").count()) throw new StepError("l'écran revient après rechargement");
}

async function current(page, s) {
  await login(page, s.base);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.waitForTimeout(800);
  if (await page.locator("[data-terms-reaccept]").count()) throw new StepError("écran de réacceptation alors que les conditions sont à jour");
}

const JOURNEYS = [
  ["reaccept", reaccept, true],
  ["current", current, false],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = [];
let failed = 0;
for (const [name, fn, outdated] of JOURNEYS) {
  for (const [dev, opts] of DEVICES) {
    const s = await servers(outdated);
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
    const problems = [];
    watch(page, problems);
    const t0 = Date.now();
    try {
      await fn(page, s, dev);
      if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
      report.push(`ok   ${name} ${dev} ${Date.now() - t0} ms`);
    } catch (e) {
      failed++;
      report.push(`FAIL ${name} ${dev}: ${e.message}`);
      await shot(page, `FAIL-${name}-${dev}`).catch(() => {});
    } finally {
      await ctx.close();
      s.stop();
    }
  }
}
await browser.close();
console.log(report.join("\n"));
console.log(`${report.length - failed}/${report.length}`);
process.exit(failed ? 1 : 0);
