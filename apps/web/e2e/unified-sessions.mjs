/**
 * Recette « liste unique » (LOKKAL-PHONE §1.2, contrats C3 et C5) : le mock cloud et un SECOND mock qui joue une
 * machine derrière sa passerelle (autre origine : CORS réel). Le tiroir réunit les fils du cloud et ceux de la
 * machine en ligne « atelier » (pastille d'origine), plus ceux du deck de la machine éteinte « bureau » (grisés,
 * « hors ligne depuis … ») ; filtre par origine ; recherche fusionnée (cloud + atelier) ; un fil d'atelier s'ouvre sur
 * la page, par le client de la passerelle de sa machine (adresse `#/t/<mc_…>/<fil>`) : ses messages, un envoi et sa
 * réponse viennent de la machine ; le retour ramène au fil du cloud d'avant. 1280 clair FR et 390 sombre EN.
 * Usage : `node e2e/unified-sessions.mjs` (E2E_SHOTS=<dossier>).
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
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_CAPABILITIES: "1", MOCK_CONNECTORS_MULTI: "1", MOCK_GATEWAY_TOKEN: "gw_e2e" };
  const machinePort = await freePort();
  const machineCfg = mkdtempSync(join(tmpdir(), "nokker-e2e-machine-"));
  const procs = [
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env: { ...env, MOCK_PORT: String(machinePort), NOKKER_CONFIG_DIR_OVERRIDE: machineCfg }, stdio: ["ignore", "ignore", "inherit"], detached: true }),
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
  await waitHttp(`http://127.0.0.1:${machinePort}/`);
  const link = (b) => fetch(`http://127.0.0.1:${mockPort}/v1/dev/link-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  await link({ linked: true, machine: "atelier", last_seen_s: 3, host: `127.0.0.1:${machinePort}` });
  await link({ linked: true, machine: "bureau", last_seen_s: 3600, mirror: true });
  const base = `http://localhost:${webPort}`;
  await waitHttp(base);
  const token = readFileSync(join(cfg, "local-token"), "utf8").trim();
  const dev = async (body) => {
    const r = await fetch(`http://127.0.0.1:${mockPort}/v1/dev/sites-mock`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new StepError(`sites-mock: HTTP ${r.status}`);
    return r.json();
  };
  return { base, stop, dev, problems: [], machinePort };
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
for (const [dev, opts] of [["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }], ["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }]]) {
  const E = dev.endsWith("-en");
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  try {
    await login(page, s.base);
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    if (dev.startsWith("phone")) await page.locator(".drawer-fab").click();
    await page.waitForSelector('#nk-drawer [data-origin^="mc_"]', { timeout: STEP_MS }).catch(() => {
      throw new StepError("aucun fil d'une machine dans le tiroir");
    });
    const atelier = page.locator('#nk-drawer .session-row.remote:not(.offline)');
    const bureau = page.locator("#nk-drawer .session-row.remote.offline");
    if (!(await atelier.count())) throw new StepError("pas de fil de la machine en ligne");
    if (!(await bureau.count())) throw new StepError("pas de fil grisé de la machine éteinte");
    const off = await bureau.last().innerText();
    if (!(E ? /bureau offline for \d+ min/ : /bureau hors ligne depuis \d+ min/).test(off)) throw new StepError(`ligne éteinte : « ${off} »`);
    if (!/atelier/.test(await atelier.first().innerText())) throw new StepError("pastille d'origine absente");
    const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (o > 1) throw new StepError(`débordement horizontal ${o}px`);
    await page.waitForTimeout(500); // fin de la glissade du tiroir au téléphone
    await shot(page, `unified-${dev}`);
    // Filtre : atelier seulement.
    await page.locator(".origin-chip", { hasText: /^atelier$/ }).click();
    const origins = await page.locator("#nk-drawer .session-row").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-origin") ?? "cloud"))]);
    if (origins.length !== 1 || !origins[0].startsWith("mc_")) throw new StepError(`filtre atelier : ${origins.join(", ")}`);
    await page.locator(".origin-chip").first().click();
    // Recherche fusionnée : « Infra » existe dans le cloud ET sur atelier (même jeu de démo).
    await page.fill(".origin-search", "Infra");
    await page.waitForSelector("[data-search-results] .search-hit", { timeout: STEP_MS });
    await page.waitForFunction(() => document.querySelectorAll("[data-search-results] .search-hit").length >= 2, null, { timeout: STEP_MS });
    const pills = await page.locator("[data-search-results] .origin-pill").allInnerTexts();
    if (!pills.includes("atelier") || !pills.includes("cloud")) throw new StepError(`recherche : origines ${pills.join(", ")}`);
    await shot(page, `unified-search-${dev}`);
    await page.fill(".origin-search", "");
    // Un fil d'atelier s'ouvre DANS la page, par la passerelle de sa machine.
    if (dev.startsWith("phone") && !(await page.locator("#nk-drawer .session-row.remote").first().isVisible())) await page.locator(".drawer-fab").click();
    const before = await page.evaluate(() => location.hash);
    const machineCalls = [];
    page.on("request", (r) => r.url().startsWith(`http://127.0.0.1:${s.machinePort}/v1/`) && machineCalls.push(r.url()));
    await atelier.first().click();
    await page.waitForFunction(() => /^#\/t\/mc_[^/]+\/./.test(location.hash), null, { timeout: STEP_MS }).catch(() => {
      throw new StepError(`adresse du fil de machine : ${before} → ${location.hash}`);
    });
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    if (!/atelier/.test((await page.locator("[data-current-origin]").innerText().catch(() => "")) ?? "")) throw new StepError("l'en-tête ne dit pas la machine du fil");
    const said = `Bonjour atelier ${dev}`;
    await page.fill(".composer input:not([type=file])", said);
    await page.keyboard.press("Enter");
    await page.waitForFunction((t) => document.body.innerText.includes(`received: “${t}”`), said, { timeout: STEP_MS });
    if (!machineCalls.some((u) => /\/v1\/chat\/completions/.test(u))) throw new StepError("l'envoi n'est pas parti vers la machine");
    if (!machineCalls.some((u) => /\/v1\/threads\//.test(u))) throw new StepError("le fil n'a pas été lu sur la machine");
    await shot(page, `unified-remote-${dev}`);
    const remoteHash = await page.evaluate(() => location.hash);
    await page.goBack();
    await page.waitForFunction((h) => location.hash === h, before, { timeout: STEP_MS }).catch(() => {
      throw new StepError("le retour ne ramène pas au fil d'avant");
    });
    // Flux en direct de la machine (≤ 4) : la ligne du fil d'atelier reprend la réponse sans attendre le deck (60 s).
    if (dev.startsWith("phone")) await page.locator(".drawer-fab").click();
    await page.waitForFunction((t) => [...document.querySelectorAll('#nk-drawer .session-row.remote:not(.offline)')].some((r) => r.textContent?.includes(t)), said, { timeout: 15000 }).catch(() => {
      throw new StepError("la ligne de la machine ne suit pas en direct");
    });
    // Machine éteinte avec miroir : la copie s'ouvre en lecture seule, puis « Continuer dans le cloud ».
    await bureau.filter({ hasText: "site" }).first().click();
    await page.waitForSelector("[data-read-only]", { timeout: STEP_MS }).catch(() => {
      throw new StepError("la copie du miroir n'est pas en lecture seule");
    });
    if (await page.locator("#nk-composer").count()) throw new StepError("composeur présent sur une copie");
    await page.waitForTimeout(500);
    await shot(page, `unified-copy-${dev}`);
    await page.locator("[data-continue-cloud]").click();
    await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
    const t = await page.locator(".topbar-title").innerText();
    if (!/suite de « site » \(bureau\)/.test(t)) throw new StepError(`titre du fil continué : « ${t} »`);
    await shot(page, `unified-continued-${dev}`);
    // Lien d'une notification (C4) : `/t/<mc_…>/<fil>` ouvre ce fil de machine dans la page.
    await page.goto(`${s.base}/${remoteHash.slice(2)}`);
    await page.waitForSelector("[data-current-origin]", { timeout: STEP_MS }).catch(() => {
      throw new StepError(`le lien de notification n'ouvre pas le fil de la machine (${remoteHash})`);
    });
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   unified-sessions ${dev}`);
  } catch (e) {
    failed++;
    report.push(`FAIL unified-sessions ${dev}: ${e.message}`);
    await shot(page, `FAIL-unified-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
