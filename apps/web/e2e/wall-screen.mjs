/**
 * Recette « Écran pour le mur » (lot V7, noyau docs/SCREENS.md), dans un vrai Chromium headless contre le mock
 * (MOCK_SCREENS=1) :
 *  - « make me a screen for the wall » → bulle `screen` : aperçu dans un cadre SERVI PAR LE NOYAU (src signé, jamais
 *    srcdoc), `sandbox=""` (ni scripts, ni même origine), le titre de l'écran lisible dedans ;
 *  - « Publish on the wall » → carte forte, la bulle attend la carte ; approuvée (geste simulé du téléphone), la bulle
 *    dit que la version est sur le mur ;
 *  - aucun débordement horizontal, aucune erreur de page, aucun 4xx/5xx inattendu. Avec E2E_PREVIEW=1 (vrais en-têtes)
 *    et E2E_CSP_LOG=<fichier>, les violations de CSP de la page sont journalisées.
 * À 1280 clair FR et 390 sombre EN. Usage : `node e2e/wall-screen.mjs` (E2E_SHOTS=<dossier> pour les captures).
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

async function servers() {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-screen-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_SCREENS: "1" };
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
  const approve = async () => {
    const r = await fetch(`http://127.0.0.1:${mockPort}/v1/dev/screens/approve`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new StepError(`screens approve: HTTP ${r.status}`);
    return (await r.json()).approved;
  };
  return { base, stop, approve };
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

async function newSession(page, name) {
  // Le téléphone montre le bouton du tiroir, le bureau l'en-tête du tiroir : attendre l'un des deux avant de choisir.
  await page.waitForSelector(".drawer-fab, .drawer-head button.icon-btn", { state: "visible", timeout: STEP_MS });
  const fab = page.locator(".drawer-fab");
  if (await fab.isVisible()) {
    await fab.click();
    await until(page, "drawer opens", () => document.querySelector(".app")?.classList.contains("drawer-open"));
  }
  await page.locator(".drawer-head button.icon-btn").click();
  const choose = page.locator(".drawer-choose button").first();
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.fill("#nk-new-session", name);
  await page.keyboard.press("Enter");
  await until(page, `session “${name}” is current`, (n) => document.querySelector("button.session-row.current")?.textContent?.includes(n), name);
  // On the phone, creating a session closes the drawer (like picking one); Escape is a no-op otherwise.
  if (await fab.isVisible()) await page.keyboard.press("Escape");
}

async function journey(page, s, dev) {
  const E = dev.endsWith("-en");
  const fonts = [];
  page.on("response", (r) => r.url().endsWith(".woff2") && r.url().includes("/v1/screens/fonts/") && fonts.push(r.status()));
  await login(page, s.base);
  // Bureau : une session neuve ; téléphone : la session ouverte (le tiroir n'y a pas le même bouton).
  if (!E) await newSession(page, `e2e wall screen ${Date.now().toString(36)}`);
  else await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.fill("#nk-composer", "make me a screen for the wall");
  await page.click("button.send");
  const body = page.locator(".bubble-body.screen").first();
  await body.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("pas de bulle screen (mock lancé avec MOCK_SCREENS=1 ?)");
  });
  const frame = body.locator("iframe.screen-frame");
  await frame.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("pas de cadre d'aperçu");
  });
  const src = await frame.getAttribute("src");
  if (!src || !/\/v1\/screens\/frame\/[A-Za-z0-9_-]+\?exp=\d+&sig=[0-9a-f]{32}$/.test(src) || (await frame.getAttribute("srcdoc")) !== null)
    throw new StepError(`l'aperçu n'est pas le cadre signé du noyau : src=${src}`);
  if ((await frame.getAttribute("sandbox")) !== "") throw new StepError(`sandbox « ${await frame.getAttribute("sandbox")} », attendu « » (aucun jeton)`);
  const h1 = page.frameLocator(".bubble-body.screen iframe.screen-frame").locator("h1");
  await h1.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("l'écran ne s'affiche pas dans son cadre");
  });
  if ((await h1.innerText()).trim() !== "Kitchen") throw new StepError(`titre dans le cadre : « ${await h1.innerText()} »`);
  // Polices de la marque, servies en même origine que le cadre (font-src 'self') : elles doivent arriver en 200.
  for (let i = 0; i < 50 && fonts.length < 2; i++) await page.waitForTimeout(100);
  if (fonts.length < 2 || fonts.some((st) => st !== 200)) throw new StepError(`polices du cadre : ${JSON.stringify(fonts)}`);
  if (!(E ? /nothing is on the wall before you publish it/i : /rien n.est sur le mur avant que tu le publies/i).test(await body.innerText()))
    throw new StepError("pas de « rien n'est sur le mur avant publication »");
  await noOverflow(page, "bulle screen");
  await shot(page, `${dev}-1-preview`);

  await body.locator("button", { hasText: "Publish on the wall" }).click();
  await until(page, "la bulle attend la carte", () => !document.querySelector(".bubble-body.screen button"));
  if (!(E ? /Approve the card/ : /Approuve la carte/).test(await body.innerText())) throw new StepError("pas de « approuve la carte »");
  await shot(page, `${dev}-2-pending`);
  if ((await s.approve()) !== 1) throw new StepError("aucune carte wall_publish en attente");
  await until(page, "version sur le mur", (re) => new RegExp(re).test(document.querySelector(".bubble-body.screen")?.textContent ?? ""), E ? "This version is on the wall" : "Cette version est sur le mur");
  await noOverflow(page, "publié");
  await shot(page, `${dev}-3-published`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = [];
let failed = 0;
for (const [dev, opts] of DEVICES) {
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  // Le script d'init tourne aussi dans le cadre de l'écran, sans origine (sandbox="") : localStorage y est refusé, et
  // c'est voulu.
  if (dev.includes("dark"))
    await page.addInitScript(() => {
      try {
        localStorage.setItem("nokker.web.theme", JSON.stringify("dark"));
      } catch {
        /* cadre sans origine */
      }
    });
  const problems = [];
  watch(page, problems);
  const t0 = Date.now();
  try {
    await journey(page, s, dev);
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   wall-screen ${dev} ${Date.now() - t0} ms`);
  } catch (e) {
    failed++;
    report.push(`FAIL wall-screen ${dev}: ${e.message}`);
    await shot(page, `FAIL-wall-screen-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
