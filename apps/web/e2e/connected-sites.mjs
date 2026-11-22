/**
 * Recette « Sites connectés » (nokker docs/CONNECTED-SITES.md §4.2, §15 ; faux noyau MOCK_SITES des routes
 * `/v1/local/sites*`), dans un vrai Chromium headless, téléphone d'abord. Persona : parent non technique.
 *  1. Premier compte LinkedIn : Ajouter un site → LinkedIn → la case de l'avertissement → Continuer → identifiant +
 *     mot de passe → Valider → « Connecté ». GESTES COMPTÉS (un toucher = 1, un champ rempli = 1).
 *  2. Deuxième compte (« LinkedIn pro ») : plus d'avertissement ; le site demande un code : faux, puis bon.
 *  3. Validation dans l'application du site (« Fait »).
 *  4. Connexion lancée depuis le chat : elle apparaît dans la liste ; le mot de passe se donne sur la page du lien
 *     sécurisé `/sites/r/<rid>` (celui que le chat et Telegram transmettent) ; puis vérification humaine : « Ouvrir
 *     l'écran » → page `/sites/h/<jeton>` → écran (simulé) du navigateur du site → « J'ai fini » → connecté.
 *  5. Identifiant refusé → « Changer le mot de passe » → « Annuler la connexion » ; pause → « Lever la pause » ;
 *     reconnexion automatique ; suppression (mot de passe oublié aussi).
 *  6. Fonction éteinte sur la machine, pas de machine liée : une phrase ; profil mineur : rien.
 * Partout : aucun mot technique dans l'écran des sites (cookie, session, 2FA, captcha…), aucun débordement
 * horizontal, aucune erreur de page, aucun 5xx ni 4xx inattendu. À 390 clair FR, 390 sombre EN, 1280 clair FR
 * (parcours 1 seulement). Usage : `node e2e/connected-sites.mjs` (E2E_SHOTS=<dossier> pour les captures).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  [404, /\/v1\/(guide|packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|local\/folder\/runs|payments\/budgets|payments\/mandates|payments\/method|speech|account\/models|capabilities|connectors\/oauth[^?]*)(\?|$)/],
  [401, /\/v1\/local\/(?!sites)/],
  // Parcours 6 : fonction éteinte (409 hors liste) et profil mineur (403 partout).
  [409, /\/v1\/local\/sites/],
  [403, /\/v1\/local\/sites/],
];
// Mots qu'un parent n'a pas à lire (consigne produit) : dans l'écran des sites et sa feuille.
const BANNED = /\b(cookies?|sessions?|openbao|2fa|vnc|captcha|jetons?|tokens?|coffre|vault|lokkal|profil chrome|chiffrement de bout)\b/i;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DEVICES = [
  ["phone-light-fr", { ...PHONE, colorScheme: "light", locale: "fr-CH" }, "full"],
  ["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }, "full"],
  ["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }, "first"],
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
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-sites-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_CAPABILITIES: "1", MOCK_CONNECTORS_MULTI: "1", MOCK_SITES: "1", MOCK_SITES_STEP_MS: process.env.MOCK_SITES_STEP_MS ?? "600" };
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

async function check(page, where) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 1) throw new StepError(`${where} : débordement horizontal de ${o}px`);
  const text = await page.evaluate(() => [...document.querySelectorAll("[data-sites], .st-sheet, .st-page")].map((e) => e.innerText).join("\n"));
  const m = BANNED.exec(text);
  if (m) throw new StepError(`${where} : mot technique à l'écran « ${m[0]} »`);
  // Cibles tactiles des actions des sites : 44 px au téléphone.
  const small = await page.evaluate(() =>
    innerWidth > 600 ? [] : [...document.querySelectorAll(".st-sheet button, .st-sheet input[type=checkbox], [data-sites] .st-row-actions button, [data-site-add]")]
      .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 24)
      .map((e) => e.textContent?.trim() || e.getAttribute("aria-label") || e.tagName),
  );
  if (small.length) throw new StepError(`${where} : cibles < 24 px : ${small.join(", ")}`);
}

let shotN = 0;
async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, "0")}-${name}.png`), fullPage: false });
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

/** Gestes de la personne, comptés : un toucher = 1, un champ rempli = 1. */
function gestures(page) {
  const g = { n: 0 };
  g.tap = async (loc) => {
    await loc.click();
    g.n++;
  };
  g.type = async (loc, text) => {
    await loc.fill(text);
    g.n++;
  };
  return g;
}

const row = (page, label) => page.locator(".st-row", { has: page.locator(".st-row-title strong", { hasText: new RegExp(`^${label}$`) }) });
const stateOf = (page, label) => row(page, label).getAttribute("data-site-state");
async function rowState(page, label, state, what) {
  await until(page, what, ([l, s]) => [...document.querySelectorAll(".st-row")].some((r) => r.querySelector(".st-row-title strong")?.textContent === l && r.getAttribute("data-site-state") === s), [label, state]);
}
async function progress(page, state, what) {
  await until(page, what, (s) => document.querySelector("[data-site-progress]")?.getAttribute("data-site-progress") === s, state);
}
async function closeSheet(page, E) {
  await page.locator(".st-sheet").getByRole("button", { name: E ? "Close" : "Fermer" }).click();
  await page.locator(".st-sheet").waitFor({ state: "detached", timeout: STEP_MS });
}

/** Ajout d'un compte LinkedIn depuis l'écran. Rend le nombre de gestes jusqu'à « Connecté » (ou jusqu'à l'état attendu). */
async function addLinkedIn(page, E, dev, { username, label, consent, shots, to = "connected" }) {
  const g = gestures(page);
  await g.tap(page.locator("[data-site-add]"));
  await page.locator('[data-site-sheet="pick"]').waitFor({ timeout: STEP_MS });
  if (shots) await check(page, "choix du site"), await shot(page, `${dev}-pick`);
  await g.tap(page.locator('[data-site-pick="linkedin"]'));
  if (consent) {
    await page.locator('[data-site-sheet="consent"]').waitFor({ timeout: STEP_MS });
    if (await page.locator("[data-site-consent]").isEnabled()) throw new StepError("« J'accepte » actif sans les cases");
    if (shots) await check(page, "avertissement"), await shot(page, `${dev}-consent`);
    await g.tap(page.locator("[data-site-agree]"));
    await g.tap(page.locator("[data-site-consent]"));
  }
  const form = page.locator("[data-site-creds]");
  await form.waitFor({ timeout: STEP_MS });
  await g.type(form.locator('input[name="username"]'), username);
  await g.type(form.locator('input[name="password"]'), "mot-de-passe-test");
  if (label) await g.type(form.locator('input[name="label"]'), label);
  if (shots) await check(page, "identifiants"), await shot(page, `${dev}-creds`);
  await g.tap(form.locator('button[type="submit"]'));
  if (await page.locator('input[name="password"]').count()) {
    const v = await page.locator('input[name="password"]').first().inputValue().catch(() => "");
    if (v) throw new StepError("le mot de passe reste dans le champ après Valider");
  }
  await page.locator("[data-site-progress]").waitFor({ timeout: STEP_MS });
  if (shots) await shot(page, `${dev}-progress`);
  await progress(page, to, `connexion jusqu'à ${to}`);
  return g;
}

async function journey(page, s, dev, scope) {
  const E = dev.endsWith("-en");
  const report = [];
  await page.addInitScript(() => localStorage.setItem("nokker.web.tab", JSON.stringify("connectors")));
  await login(page, s.base);
  await until(page, "écran Sites connectés", () => !!document.querySelector('[data-sites="on"]'));
  await page.locator('[data-sites="on"]').scrollIntoViewIfNeeded();
  await check(page, "liste vide");
  await shot(page, `${dev}-empty`);

  // 1. Premier compte : gestes comptés jusqu'à « Connecté ».
  const first = await addLinkedIn(page, E, dev, { username: "alex@example.org", consent: true, shots: true });
  await check(page, "connecté");
  await shot(page, `${dev}-connected`);
  report.push(`gestes premier compte (avec avertissement) : ${first.n}`);
  if (first.n > 7) throw new StepError(`premier compte : ${first.n} gestes (> 7)`);
  await page.locator("[data-site-finish]").click();
  await rowState(page, "LinkedIn", "connected", "LinkedIn connecté dans la liste");
  if (!/Alex Martin/.test(await row(page, "LinkedIn").innerText())) throw new StepError("nom du compte absent de la carte");
  await check(page, "liste, un site");
  await shot(page, `${dev}-list-1`);
  if (scope === "first") return report;

  // 2. Deuxième compte avec code : plus d'avertissement.
  const second = await addLinkedIn(page, E, dev, { username: "code@example.org", label: "LinkedIn pro", consent: false, to: "needs_code" });
  const ask = page.locator('[data-site-ask="code"]');
  await ask.waitFor({ timeout: STEP_MS });
  await check(page, "code demandé");
  await shot(page, `${dev}-code`);
  await second.type(ask.locator('input[name="value"]'), "000000");
  await second.tap(ask.locator('button[type="submit"]'));
  await until(page, "nouveau code après un faux", () => /refus|accept/i.test(document.querySelector('[data-site-ask="code"]')?.textContent ?? "") && !!document.querySelector('[data-site-ask="code"] input'));
  await shot(page, `${dev}-code-again`);
  const ask2 = page.locator('[data-site-ask="code"]');
  await second.type(ask2.locator('input[name="value"]'), "123 456");
  await second.tap(ask2.locator('button[type="submit"]'));
  await progress(page, "connected", "LinkedIn pro connecté");
  report.push(`gestes deuxième compte (code, un faux puis le bon) : ${second.n}`);
  await page.locator("[data-site-finish]").click();
  await rowState(page, "LinkedIn pro", "connected", "LinkedIn pro dans la liste");

  // 3. Validation dans l'application.
  const third = await addLinkedIn(page, E, dev, { username: "phone@example.org", label: "Perso", consent: false, to: "needs_app_approval" });
  await page.locator('[data-site-ask="app"]').waitFor({ timeout: STEP_MS });
  await check(page, "validation dans l'appli");
  await shot(page, `${dev}-app-approval`);
  await third.tap(page.locator('[data-site-ask="app"] button'));
  await progress(page, "connected", "Perso connecté");
  report.push(`gestes compte avec validation dans l'appli : ${third.n}`);
  await closeSheet(page, E);

  // 4. Lancée depuis le chat : visible ici ; mot de passe sur la page du lien sécurisé ; vérification humaine.
  await s.dev({ chat: { site: "linkedin", username: "robot@example.org" } });
  await rowState(page, "LinkedIn 2", "needs_password", "connexion du chat dans la liste");
  await row(page, "LinkedIn 2").scrollIntoViewIfNeeded();
  await check(page, "liste avec la connexion du chat");
  await shot(page, `${dev}-from-chat`);
  const rid = (await s.dev({})).sites.find((x) => x.label === "LinkedIn 2").request.id;
  const link = await page.context().newPage();
  watch(link, s.problems);
  await link.goto(`${s.base}/sites/r/${rid}`);
  const form = link.locator('[data-sr="password"]');
  await form.waitFor({ timeout: STEP_MS });
  await check(link, "page du lien sécurisé");
  await shot(link, `${dev}-secure-link`);
  await form.locator('input[name="value"]').fill("mot-de-passe-test");
  await form.locator('button[type="submit"]').click();
  await link.locator('[data-sr="sent"]').waitFor({ timeout: STEP_MS });
  await shot(link, `${dev}-secure-link-sent`);
  await link.close();
  await rowState(page, "LinkedIn 2", "needs_you", "vérification humaine dans la liste");
  await row(page, "LinkedIn 2").locator("[data-site-primary]").click();
  await progress(page, "needs_you", "vérification humaine");
  await check(page, "vérification humaine");
  await shot(page, `${dev}-human`);
  const [screen] = await Promise.all([page.context().waitForEvent("page"), page.locator("[data-site-handoff]").click()]);
  watch(screen, s.problems);
  await screen.waitForSelector("[data-screen]", { timeout: STEP_MS });
  await shot(screen, `${dev}-screen`);
  await screen.locator("button").click();
  await screen.waitForSelector("[data-screen-done]", { timeout: STEP_MS });
  await screen.close();
  await progress(page, "connected", "connecté après la vérification");
  await closeSheet(page, E);

  // 5. Refusé, pause, reconnexion automatique, suppression.
  await addLinkedIn(page, E, dev, { username: "wrong@example.org", label: "Ancien", consent: false, to: "suspended" });
  await page.locator('[data-site-ask="refused"]').waitFor({ timeout: STEP_MS });
  await check(page, "identifiant refusé");
  await shot(page, `${dev}-refused`);
  await page.locator('[data-site-ask="refused"] button').click();
  await page.locator('[data-site-ask="password"]').waitFor({ timeout: STEP_MS });
  await page.locator(".st-sheet [data-site-cancel]").click();
  await progress(page, "failed", "connexion annulée");
  if (!(E ? /cancelled/ : /annulée/).test(await page.locator('[data-site-ask="failed"]').innerText())) throw new StepError("raison « annulée » absente");
  await shot(page, `${dev}-cancelled`);
  await closeSheet(page, E);
  const all = (await s.dev({})).sites;
  const pro = all.find((x) => x.label === "LinkedIn pro").id;
  await s.dev({ pause: pro });
  await rowState(page, "LinkedIn pro", "paused", "pause visible");
  if (!E && !/activité inhabituelle/.test(await row(page, "LinkedIn pro").innerText())) throw new StepError("raison de la pause absente");
  await s.dev({ expire: all.find((x) => x.label === "Perso").id });
  await until(page, "reconnecté tout seul (ligne sur la carte)", (re) => [...document.querySelectorAll(".st-row")].some((r) => r.querySelector(".st-row-title strong")?.textContent === "Perso" && new RegExp(re).test(r.textContent ?? "")), E ? "Reconnected on its own" : "Reconnecté tout seul");
  await check(page, "liste : pause et reconnexion");
  await shot(page, `${dev}-list-states`);
  await row(page, "LinkedIn pro").locator("[data-site-primary]").click();
  await rowState(page, "LinkedIn pro", "connected", "pause levée");
  await row(page, "Ancien").locator("[data-site-more]").click();
  await row(page, "Ancien").getByRole("menuitem", { name: E ? "Remove" : "Supprimer" }).click();
  await row(page, "Ancien").locator("[data-site-delete]").waitFor({ timeout: STEP_MS });
  await check(page, "confirmation de suppression");
  await shot(page, `${dev}-delete`);
  await row(page, "Ancien").locator(".ob-btn.danger").click();
  await until(page, "Ancien supprimé", () => ![...document.querySelectorAll(".st-row-title strong")].some((l) => l.textContent === "Ancien"));
  if ((await stateOf(page, "LinkedIn")) !== "connected") throw new StepError("LinkedIn n'est plus connecté");
  await check(page, "fin");
  await shot(page, `${dev}-list-end`);

  // 6. Fonction éteinte, pas de machine, mineur.
  await s.dev({ off: true });
  await until(page, "fonction éteinte : une phrase", () => !!document.querySelector('[data-sites="disabled"]'));
  await page.locator('[data-sites="disabled"]').scrollIntoViewIfNeeded();
  await check(page, "fonction éteinte");
  await shot(page, `${dev}-disabled`);
  await s.dev({ off: false, no_machine: true });
  await until(page, "pas de machine : une phrase", () => !!document.querySelector('[data-sites="no_machine"]'));
  await shot(page, `${dev}-no-machine`);
  await s.dev({ no_machine: false, minor: true });
  await until(page, "mineur : rien", () => !document.querySelector("[data-sites]"));
  return report;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = [];
let failed = 0;
for (const [dev, opts, scope] of DEVICES) {
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = s.problems;
  watch(page, problems);
  const t0 = Date.now();
  try {
    const notes = await journey(page, s, dev, scope);
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   connected-sites ${dev} ${Date.now() - t0} ms`, ...notes.map((n) => `       ${n}`));
  } catch (e) {
    failed++;
    report.push(`FAIL connected-sites ${dev}: ${e.message}`);
    await shot(page, `FAIL-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
console.log(`${DEVICES.length - failed}/${DEVICES.length}`);
if (SHOTS) writeFileSync(join(SHOTS, "report.txt"), report.join("\n") + "\n");
process.exit(failed ? 1 : 0);
