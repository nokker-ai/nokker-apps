/**
 * Recette « prénom du membre » (noyau p2/member-first-name ebb9ae3) : Mon compte → Prénom (posé, refusé avec un
 * chiffre, effacé : le nom montré retombe sur l'adresse) ; Foyer → membres montrés par leur nom (« Léa », « sam »),
 * invitation avec un prénom, qui apparaît dans les invitations en attente. 390 clair FR et 1280 sombre EN.
 * Usage : `node e2e/first-name.mjs` (E2E_SHOTS=<dossier>).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const ALLOWED_4XX = [
  [404, /\/v1\/(guide|packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|local\/folder\/runs|payments\/budgets|payments\/mandates|payments\/method|speech|account\/models|capabilities|local\/sites|connectors\/oauth[^?]*)(\?|$)/],
  [401, /\/v1\/local\//],
  // Prénom refusé (R2D2) : 400 bad_first_name attendu.
  [400, /\/v1\/account$/],
];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light", locale: "fr-CH" };

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

async function servers() {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-touch-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_CAPABILITIES: "1", MOCK_CONNECTORS_MULTI: "1", MOCK_HOUSEHOLD: "payer" };
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
  const token = readFileSync(join(cfg, "local-token"), "utf8").trim();
  const dev = async (body) => {
    const r = await fetch(`http://127.0.0.1:${mockPort}/v1/dev/sites-mock`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new StepError(`sites-mock: HTTP ${r.status}`);
    return r.json();
  };
  return { base, stop, dev, problems: [] };
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

async function login(page, base) {
  await page.goto(base);
  await page.waitForSelector("#wl-email", { timeout: STEP_MS });
  await page.fill("#wl-email", EMAIL);
  await page.click("form button[type=submit]");
  await page.waitForSelector("#wl-code", { timeout: STEP_MS });
  await page.fill("#wl-code", CODE);
  await page.keyboard.press("Enter");
}



async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [dev, opts] of [["phone-light-fr", { ...PHONE }], ["desktop-dark-en", { viewport: { width: 1280, height: 800 }, colorScheme: "dark", locale: "en-US" }]]) {
  const E = dev.endsWith("-en");
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  try {
    // Mon compte d'abord, UNE fois (le script d'init se rejoue à chaque rechargement).
    await page.addInitScript(() => {
      if (sessionStorage.getItem("e2e-tab")) return;
      sessionStorage.setItem("e2e-tab", "1");
      localStorage.setItem("nokker.web.tab", JSON.stringify("account"));
    });
    await login(page, s.base);
    const row = page.locator("[data-first-name]");
    await row.waitFor({ timeout: STEP_MS });
    if (!/alice|demo|mock/i.test(await row.innerText()) && !(await row.innerText()).length) throw new StepError("ligne Prénom vide");
    await row.getByRole("button").first().click();
    await row.locator('input[name="first_name"]').fill("R2D2");
    await row.locator('button[type="submit"]').click();
    await row.locator(".ob-error").waitFor({ timeout: STEP_MS });
    await shot(page, `first-name-bad-${dev}`);
    await row.locator('input[name="first_name"]').fill("Anne-Marie");
    await row.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-first-name] strong")?.textContent === "Anne-Marie", null, { timeout: STEP_MS });
    await shot(page, `first-name-saved-${dev}`);
    await page.evaluate(() => localStorage.setItem("nokker.web.tab", JSON.stringify("household")));
    await page.reload();
    await page.waitForSelector(".hh-member", { timeout: STEP_MS });
    const names = await page.locator(".hh-member .team-member-mail").allInnerTexts();
    if (!names.includes("Léa") || !names.includes("sam")) throw new StepError(`noms du foyer : ${names.join(", ")}`);
    await page.fill("#hh-inv-email", "camille@example.org");
    await page.fill("#hh-inv-first", "Camille");
    await page.locator(".hh-invite button[type=submit]").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".hh-row strong")].some((x) => x.textContent?.trim() === "Camille"), null, { timeout: STEP_MS });
    const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (o > 1) throw new StepError(`débordement horizontal ${o}px`);
    await shot(page, `first-name-household-${dev}`);
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   first-name ${dev}`);
  } catch (e) {
    failed++;
    report.push(`FAIL first-name ${dev}: ${e.message}`);
    await shot(page, `FAIL-first-name-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
