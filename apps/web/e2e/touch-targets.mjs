/**
 * Recette « cibles tactiles » (LOKKAL-PHONE §1.1 W9) : au téléphone (390 px, toucher), sur le chat, le tiroir des
 * sessions, Mon compte et Connecteurs, chaque bouton, lien et champ visible mesure au moins 44 px dans sa plus petite
 * dimension utile (hauteur ; largeur aussi pour un bouton à icône seule). Échoue sous 44 px, et liste ce qui manque.
 * Usage : `node e2e/touch-targets.mjs` (E2E_SHOTS=<dossier>, E2E_REPORT=1 pour lister sans échouer).
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
const MIN = 44;

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

/** Cibles visibles trop petites dans `root` (sélecteur). Une cible dont le parent cliquable (label) est assez grand compte. */
async function small(page, root) {
  return page.evaluate(
    ([root, min]) => {
      const out = [];
      const scope = document.querySelector(root) ?? document.body;
      for (const el of scope.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem]")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden" || el.closest("[hidden], [aria-hidden=true]")) continue;
        const hit = el.closest("label") ?? el;
        const h = hit.getBoundingClientRect();
        const iconOnly = el.tagName === "BUTTON" && !(el.textContent ?? "").trim();
        if (h.height >= min && (!iconOnly || h.width >= min)) continue;
        // Lien dans une phrase (texte courant) : WCAG 2.5.8 l'exempte (cible en ligne).
        if (el.tagName === "A" && getComputedStyle(el).display === "inline" && el.closest("p, li")) continue;
        const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || `${el.tagName}#${el.id}[${el.getAttribute("type") ?? ""}]`).trim().replace(/\s+/g, " ").slice(0, 40);
        out.push(`${name} [${el.className || el.tagName}] ${Math.round(h.width)}×${Math.round(h.height)}`);
      }
      return out;
    },
    [root, MIN],
  );
}

const report = [];
let bad = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const s = await servers();
const ctx = await browser.newContext(PHONE);
const page = await ctx.newPage();
const problems = [];
watch(page, problems);
try {
  await login(page, s.base);
  await page.waitForSelector(".composer", { timeout: STEP_MS });
  const screens = [
    ["chat", async () => {}, ".app"],
    ["tiroir", async () => { await page.locator(".drawer-fab").click(); await page.waitForTimeout(400); }, "#nk-drawer"],
    ["mon-compte", async () => { await page.evaluate(() => localStorage.setItem("nokker.web.tab", JSON.stringify("account"))); await page.reload(); await page.waitForTimeout(1500); }, ".app"],
    ["connecteurs", async () => { await page.evaluate(() => localStorage.setItem("nokker.web.tab", JSON.stringify("connectors"))); await page.reload(); await page.waitForTimeout(1500); }, ".app"],
  ];
  for (const [name, go, root] of screens) {
    await go();
    await shot(page, `touch-${name}`);
    const list = await small(page, root);
    report.push(`${list.length ? "SMALL" : "ok   "} ${name}: ${list.length}`);
    for (const l of list) report.push(`       ${l}`);
    bad += list.length;
  }
  if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
} catch (e) {
  bad++;
  report.push(`FAIL ${e.message}`);
} finally {
  await ctx.close();
  await browser.close();
  s.stop();
}
console.log(report.join("\n"));
process.exit(bad && !process.env.E2E_REPORT ? 1 : 0);
