/**
 * Recette « Connexions OAuth » (core docs/CONNECTORS-OAUTH.md, features.connectors_oauth), dans un vrai Chromium headless
 * contre le mock (MOCK_CAPABILITIES=1 MOCK_CONNECTORS_MULTI=1 MOCK_CONNECTORS_OAUTH=1, fournisseurs simulés) :
 *  - « Connecter un compte Microsoft » : choix des services, page du fournisseur (un service décoché), retour sur
 *    Connecteurs (message, « pas accordé », adresse nettoyée), compte relié, boîte « via Microsoft » ;
 *  - jeton révoqué → « À reconnecter » → Reconnecter → de nouveau relié ; « Ajouter un service » (contacts) ;
 *  - Google Drive à part : sélecteur (simulé), fichier donné puis retiré ;
 *  - refus chez le fournisseur → message d'erreur ; « Déconnecter le compte » retire ses services.
 * À 1280 clair FR et 390 sombre EN. Échoue sur une étape non atteinte, une erreur de page, un 5xx, un 4xx inattendu ou un
 * débordement horizontal. Usage : `node e2e/connectors-oauth.mjs` (E2E_SHOTS=<dossier> pour les captures).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const MOCK = resolve(WEB, "../../packages/mock-server");
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 20000);
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : null;
const EMAIL = "alice@example.com";
const CODE = "123456";
const ALLOWED_4XX = [
  [404, /\/v1\/(packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|local\/folder\/runs|payments\/budgets|payments\/mandates|payments\/method|speech|account\/models|capabilities)(\?|$)/],
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

async function servers(oauth = true) {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-oauth-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_CAPABILITIES: "1", MOCK_CONNECTORS_MULTI: "1", MOCK_CONNECTORS_OAUTH: oauth ? "1" : "presets" };
  const procs = [
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("npx", ["vite", "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], {
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
    const r = await fetch(`http://127.0.0.1:${mockPort}/v1/dev/connectors-mock`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new StepError(`connectors-mock: HTTP ${r.status}`);
  };
  return { base, stop, dev };
}

function watch(page, problems) {
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
const card = (page, label) => page.locator(".cm-item", { has: page.locator(".cm-label", { hasText: new RegExp(`^${label}$`) }) });

/** Page du fournisseur simulé : décoche `untick`, puis Autoriser (ou Refuser). */
async function provider(page, name, { untick = [], deny = false } = {}) {
  await page.waitForSelector(`[data-fake-provider="${name}"]`, { timeout: STEP_MS }).catch(() => {
    throw new StepError(`pas de page du fournisseur ${name}`);
  });
  for (const k of untick) await page.locator(`input[name=granted][value=${k}]`).uncheck();
  await page.getByRole("button", { name: deny ? "Refuser" : "Autoriser" }).click();
}

async function back(page, what) {
  await until(page, `retour sur Connecteurs (${what})`, () => !!document.querySelector("[data-connectors-multi] [data-cm-oauth]"));
  if (/[?&]oauth=/.test(page.url()) || new URL(page.url()).pathname !== "/") throw new StepError(`adresse non nettoyée : ${page.url()}`);
}

async function journey(page, s, dev) {
  const E = en(dev);
  await page.addInitScript(() => localStorage.setItem("nokker.web.tab", JSON.stringify("connectors")));
  await login(page, s.base);
  await until(page, "comptes reliés", () => !!document.querySelector("[data-cm-oauth]"));
  const buttons = await page.locator("[data-cm-oauth] [data-connect]").allInnerTexts();
  const want = E ? ["Connect a Microsoft account", "Connect a Google account", "Connect Google Drive"] : ["Connecter un compte Microsoft", "Connecter un compte Google", "Connecter Google Drive"];
  if (buttons.join("|") !== want.join("|")) throw new StepError(`boutons : ${buttons.join(" | ")}`);
  for (const k of ["contacts", "files", "tasks"]) if (!(await page.locator(`[data-cm-kind=${k}]`).count())) throw new StepError(`pas de section ${k}`);
  await noOverflow(page, "départ");
  await shot(page, `${dev}-0-start`);

  // Microsoft : mail, agenda, contacts demandés ; contacts décoché chez le fournisseur.
  await page.locator('[data-cm-oauth] [data-connect="microsoft"]').click();
  const form = page.locator('[data-connect-form="microsoft"]');
  for (const k of ["files", "tasks"]) await form.locator(`input[value=${k}]`).uncheck();
  await noOverflow(page, "choix des services");
  await shot(page, `${dev}-1-choose`);
  await form.locator("button[type=submit]").click();
  await provider(page, "microsoft", { untick: ["contacts"] });
  await back(page, "Microsoft");
  const banner = page.locator('[data-oauth-return="done"]');
  if (!(E ? /Microsoft account connected/ : /Compte Microsoft relié/).test(await banner.innerText())) throw new StepError(`bannière : ${await banner.innerText()}`);
  if (!(E ? /Not granted there: contacts/ : /Pas accordé là-bas : contacts/).test(await banner.innerText())) throw new StepError("« pas accordé : contacts » absent");
  if (!(await page.locator("[data-oauth-fresh]").count())) throw new StepError("le compte relié n'est pas mis en avant");
  const ms = page.locator("[data-oauth-account]").first();
  if (!(E ? /Connected for: mail, calendar/ : /Relié pour : mail, agenda/).test(await ms.innerText())) throw new StepError(`compte : ${await ms.innerText()}`);
  await card(page, "alex@outlook.example").waitFor({ timeout: STEP_MS });
  if (!(E ? /via Microsoft/ : /via Microsoft/).test(await card(page, "alex@outlook.example").innerText())) throw new StepError("boîte Outlook sans « via Microsoft »");
  await noOverflow(page, "retour Microsoft");
  await shot(page, `${dev}-2-linked`);

  // Jeton révoqué → à reconnecter → Reconnecter.
  await s.dev({ oauth_reconnect: "all" });
  await page.reload();
  await until(page, "état « à reconnecter »", () => document.querySelectorAll('[data-state="reconnect"]').length >= 2);
  await shot(page, `${dev}-3-reconnect`);
  await ms.locator("[data-reconnect]").click();
  await provider(page, "microsoft");
  await back(page, "reconnexion");
  if (await page.locator('[data-state="reconnect"]').count()) throw new StepError("toujours « à reconnecter » après Reconnecter");

  // Ajouter un service : contacts.
  await page.locator("[data-oauth-account]").first().getByRole("button", { name: E ? "Add a service" : "Ajouter un service" }).click();
  const more = page.locator('[data-oauth-account] [data-connect-form="microsoft"]');
  const offered = await more.locator("input[name=service]").evaluateAll((l) => l.map((i) => i.value));
  if (offered.join(",") !== "contacts,files,tasks") throw new StepError(`services proposés : ${offered.join(",")}`);
  for (const k of ["files", "tasks"]) await more.locator(`input[value=${k}]`).uncheck();
  await more.locator("button[type=submit]").click();
  await provider(page, "microsoft");
  await back(page, "ajout de contacts");
  await until(page, "contacts Microsoft", () => !!document.querySelector('[data-cm-kind="contacts"] .cm-item'));

  // Google Drive : sélecteur simulé.
  await page.locator('[data-connect="google-drive"]').click();
  await provider(page, "google");
  await back(page, "Google Drive");
  const drive = page.locator('[data-cm-kind="files"] .cm-item').first();
  await drive.locator("[data-picked-files]").waitFor({ timeout: STEP_MS });
  await drive.locator("[data-pick-files]").click();
  const dlg = page.locator("dialog[data-mock-picker]");
  await dlg.waitFor({ timeout: STEP_MS });
  await dlg.locator("input[type=checkbox]").first().check();
  await shot(page, `${dev}-4-picker`);
  await dlg.getByRole("button", { name: E ? "Select" : "Sélectionner" }).click();
  await until(page, "fichier donné", () => !!document.querySelector("[data-picked]"));
  if (!/Facture-2026-10\.pdf/.test(await drive.innerText())) throw new StepError("le fichier choisi n'apparaît pas");
  await noOverflow(page, "Drive");
  await shot(page, `${dev}-5-drive`);
  await drive.locator("[data-picked]").getByRole("button").click();
  await until(page, "fichier retiré", () => !document.querySelector("[data-picked]"));

  // Refus chez Google.
  await page.locator('[data-cm-oauth] .cm-connect [data-connect="google"]').click();
  await page.locator('[data-connect-form="google"] button[type=submit]').click();
  await provider(page, "google", { deny: true });
  await back(page, "refus");
  const err = page.locator('[data-oauth-return="error"][data-oauth-code="denied"]');
  if (!(await err.count()) || !(E ? /refused on the Google page/ : /refusée sur la page de Google/).test(await err.innerText())) throw new StepError("pas de message de refus");

  // Déconnecter le compte Microsoft : ses trois services tombent.
  const msAcct = page.locator("[data-oauth-account]", { hasText: "alex@outlook.example" });
  await msAcct.getByRole("button", { name: E ? "Disconnect the account" : "Déconnecter le compte" }).click();
  await msAcct.getByRole("button", { name: E ? "Confirm disconnection" : "Confirmer la déconnexion" }).click();
  await until(page, "compte Microsoft retiré", () => ![...document.querySelectorAll("[data-oauth-account]")].some((e) => e.textContent.includes("alex@outlook.example")));
  if (await card(page, "alex@outlook.example").count()) throw new StepError("la boîte Outlook reste après la déconnexion");
  await noOverflow(page, "fin");
  await shot(page, `${dev}-6-end`);
}

/** features.connectors_oauth faux (OAuth éteint en prod tant que les applications Entra et Google n'existent pas) :
 * aucun « Comptes reliés » même si le noyau liste des fournisseurs (éteints), l'écran multi reste entier. Mock relancé
 * avec MOCK_CONNECTORS_OAUTH=presets (presets.oauth présent, capacité fausse). */
async function oauthOff(page, s, dev) {
  await page.addInitScript(() => localStorage.setItem("nokker.web.tab", JSON.stringify("connectors")));
  await login(page, s.base);
  await until(page, "écran Connecteurs multiples", () => !!document.querySelector("[data-connectors-multi] [data-cm-kind=mail]"));
  await page.waitForTimeout(500);
  if (await page.locator("[data-cm-oauth]").count()) throw new StepError("« Comptes reliés » affiché alors que connectors_oauth est faux");
  if (await page.locator("[data-cm-kind=contacts]").count()) throw new StepError("section contacts sans OAuth");
  await noOverflow(page, "OAuth éteint");
  void dev;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = [];
let failed = 0;
for (const [dev, opts, fn, oauth] of [...DEVICES.map(([d, o]) => [d, o, journey, true]), [`${DEVICES[0][0]}-off`, DEVICES[0][1], oauthOff, false]]) {
  const s = await servers(oauth);
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  const t0 = Date.now();
  try {
    await fn(page, s, dev);
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   connectors-oauth ${dev} ${Date.now() - t0} ms`);
  } catch (e) {
    failed++;
    report.push(`FAIL connectors-oauth ${dev}: ${e.message}`);
    await shot(page, `FAIL-connectors-oauth-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
console.log(`${report.length - failed}/${report.length}`);
process.exit(failed ? 1 : 0);
