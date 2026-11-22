/**
 * Recette « hors ligne » (LOKKAL-PHONE §1.1 W6) : un fil ouvert est gardé dans l'appareil ; l'API coupée, la page
 * rechargée montre la COPIE (liste des fils, messages du fil) en lecture seule avec son âge, sans erreur de page ;
 * le réseau revenu (`online`), la session se refait et le bandeau disparaît. Rien n'est envoyé hors ligne.
 * Usage : `node e2e/offline.mjs` (E2E_SHOTS=<dossier>).
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
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_CAPABILITIES: "1", MOCK_CONNECTORS_MULTI: "1" };
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
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const problems = [];
  let cut = false;
  page.on("pageerror", (e) => problems.push(`erreur de page : ${e.message}`));
  page.on("response", (r) => {
    if (cut || r.status() < 500) return;
    problems.push(`HTTP ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`);
  });
  try {
    await login(page, s.base);
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    const sent = "Note pour la copie hors ligne";
    await page.fill(".composer input:not([type=file])", sent);
    await page.keyboard.press("Enter");
    await page.waitForFunction((t) => document.body.innerText.includes(t), sent, { timeout: STEP_MS });
    await page.waitForTimeout(1500); // fin du tour : la vue du fil est relue, donc gardée
    await page.reload();
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    await page.waitForTimeout(800);
    // L'API tombe (réseau coupé côté appareil) : la page rechargée s'appuie sur la copie.
    cut = true;
    await page.route("**/v1/**", (r) => r.abort("internetdisconnected"));
    await page.reload();
    await page.waitForSelector("[data-offline-copy]", { timeout: STEP_MS }).catch(() => {
      throw new StepError("pas de bandeau « copie hors ligne » après rechargement sans réseau");
    });
    if (!(await page.evaluate((t) => document.body.innerText.includes(t), sent))) throw new StepError("le message du fil n'est pas dans la copie");
    await shot(page, `offline-${dev}`);
    // Le réseau revient : la session se refait, la copie cède la place.
    await page.unroute("**/v1/**");
    cut = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForSelector("[data-offline-copy]", { state: "detached", timeout: STEP_MS }).catch(() => {
      throw new StepError("le bandeau reste une fois le réseau revenu");
    });
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   offline ${dev}`);
  } catch (e) {
    failed++;
    report.push(`FAIL offline ${dev}: ${e.message}`);
    await shot(page, `FAIL-offline-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
