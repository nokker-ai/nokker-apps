/**
 * Recette « Connecteurs : plusieurs boîtes et agendas par profil » (core docs/CONNECTORS-MULTI.md, features.connectors_multi),
 * dans un vrai Chromium headless contre le mock (MOCK_CAPABILITIES=1 MOCK_CONNECTORS_MULTI=1) :
 *  - la boîte partagée par Camille apparaît sous « Partagées avec moi » ;
 *  - ajout de deux boîtes (aide d'une ligne bluewin, Outlook « bientôt » non choisissable, région Zoho) ; la première est
 *    le défaut ; définir par défaut, renommer ;
 *  - partage à Sam (mineur) en lecture et envoi → carte forte, partage « en attente » ; approuvé, il devient actif ;
 *  - retirer la boîte partagée avec moi ; supprimer une boîte (le défaut passe à la restante).
 * À 1280 clair FR et 390 sombre EN. Échoue sur une étape non atteinte, une erreur de page, un 5xx, un 4xx inattendu ou un
 * débordement horizontal. Usage : `node e2e/connectors-multi.mjs` (E2E_SHOTS=<dossier> pour les captures).
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

async function servers() {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-conn-"));
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
    const r = await fetch(`http://127.0.0.1:${mockPort}/v1/dev/connectors-mock`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new StepError(`connectors-mock: HTTP ${r.status}`);
  };
  return { base, stop, dev };
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
const item = (page, label) => page.locator(".cm-item", { has: page.locator(".cm-label", { hasText: new RegExp(`^${label}$`) }) });

async function addMail(page, E, { label, preset, address }) {
  const sec = page.locator('[data-cm-kind="mail"]');
  await sec.getByRole("button", { name: E ? "Add a mailbox" : "Ajouter une boîte" }).click();
  const form = page.locator('[data-cm-add="mail"]');
  await form.waitFor({ timeout: STEP_MS });
  await form.locator('select[name="preset"]').selectOption(preset);
  if (label) await form.locator('input[name="label"]').fill(label);
  await form.locator('input[name="address"]').fill(address);
  await form.locator('input[name="secret"]').fill("app-password");
  return form;
}

async function journey(page, s, dev) {
  const E = en(dev);
  await page.addInitScript(() => localStorage.setItem("nokker.web.tab", JSON.stringify("connectors")));
  await login(page, s.base);
  await until(page, "écran Connecteurs multiples", () => !!document.querySelector("[data-connectors-multi] [data-cm-kind=mail]"));
  // Partagée avec moi.
  const shared = page.locator("[data-cm-shared] .cm-item");
  if ((await shared.count()) !== 1) throw new StepError("« Partagées avec moi » ne montre pas la boîte de Camille");
  if (!(E ? /shared by camille/ : /partagée par camille/).test(await shared.innerText())) throw new StepError(`partagée : « ${await shared.innerText()} »`);
  await noOverflow(page, "liste vide + partagée");
  await shot(page, `${dev}-0-start`);

  // Ajout : bluewin (aide), Outlook bientôt.
  let form = await addMail(page, E, { label: "pro", preset: "bluewin", address: "alex@example.org" });
  const help = form.locator("[data-cm-help=bluewin]");
  if (!(await help.count()) || !/Swisscom/.test(await help.innerText())) throw new StepError("pas d'aide d'une ligne pour bluewin");
  const pw = await form.locator('label[for$="-secret"]').innerText();
  if (pw !== (E ? "Password" : "Mot de passe")) throw new StepError(`libellé du mot de passe bluewin : « ${pw} »`);
  const outlook = form.locator('select[name="preset"] option[value="outlook"]');
  if (!(await outlook.isDisabled())) throw new StepError("Outlook est choisissable");
  if (!(E ? /coming soon/ : /bientôt/).test(await outlook.innerText())) throw new StepError(`Outlook : « ${await outlook.innerText()} »`);
  await noOverflow(page, "formulaire d'ajout");
  await shot(page, `${dev}-1-add-form`);
  await form.locator("button[type=submit]").click();
  await item(page, "pro").waitFor({ timeout: STEP_MS });
  if (!(await item(page, "pro").locator("[data-default]").count())) throw new StepError("la première boîte n'est pas le défaut");
  if ((await page.locator('input[name="secret"]').count()) !== 0) throw new StepError("le formulaire reste ouvert après l'ajout");

  // Deuxième : Zoho (région).
  form = await addMail(page, E, { label: "perso", preset: "zoho", address: "alex@zoho.example" });
  if (!(await form.locator('select[name="region"]').count())) throw new StepError("pas de choix de région pour Zoho");
  await form.locator('select[name="region"]').selectOption("com");
  await form.locator("button[type=submit]").click();
  await item(page, "perso").waitFor({ timeout: STEP_MS });
  if (await item(page, "perso").locator("[data-default]").count()) throw new StepError("la deuxième boîte est aussi le défaut");

  // Définir par défaut, renommer.
  await item(page, "perso").getByRole("button", { name: E ? "Make default" : "Définir par défaut" }).click();
  await until(page, "défaut sur perso", () => [...document.querySelectorAll(".cm-item")].some((li) => li.querySelector(".cm-label")?.textContent === "perso" && li.querySelector("[data-default]")));
  if (await item(page, "pro").locator("[data-default]").count()) throw new StepError("deux boîtes par défaut");
  await item(page, "perso").getByRole("button", { name: E ? "Rename" : "Renommer" }).click();
  await item(page, "perso").locator('input[name="label"]').fill("privé");
  await item(page, "perso").getByRole("button", { name: E ? "Save name" : "Enregistrer le nom" }).click();
  await item(page, "privé").waitFor({ timeout: STEP_MS });

  // Partager pro avec Sam (mineur), lecture et envoi → en attente.
  await item(page, "pro").getByRole("button", { name: E ? "Share" : "Partager" }).click();
  // Un nom refusé d'avance (séparateur).
  await item(page, "privé").getByRole("button", { name: E ? "Rename" : "Renommer" }).click();
  await item(page, "privé").locator('input[name="label"]').fill("a/b");
  await item(page, "privé").getByRole("button", { name: E ? "Save name" : "Enregistrer le nom" }).click();
  await until(page, "nom refusé", () => /«\s*\/\s*»|“\/”/.test(document.querySelector('.cm-item [role=alert]')?.textContent ?? ""));
  await item(page, "privé").getByRole("button", { name: E ? "Cancel" : "Annuler" }).click();
  const share = item(page, "pro").locator("[data-cm-share]");
  const opts = await share.locator('select[name="member"] option').allInnerTexts();
  if (!opts.some((o) => (E ? /sam \(minor\)/ : /sam \(mineur/).test(o))) throw new StepError(`membres : ${opts.join(" | ")}`);
  await share.locator('select[name="member"]').selectOption("ac_sam");
  await share.locator('select[name="level"]').selectOption("send");
  await noOverflow(page, "partage");
  await shot(page, `${dev}-2-share`);
  await share.locator("button[type=submit]").click();
  await until(page, "partage en attente", () => !!document.querySelector('[data-grant="ac_sam"][data-grant-status="pending"]'));
  const pending = await item(page, "pro").locator('[data-grant="ac_sam"]').innerText();
  if (!(E ? /sam \(minor\) · read and send.*waiting for approval/ : /sam \(mineur·e\) · lecture et envoi.*en attente d.approbation/).test(pending)) throw new StepError(`ligne du partage : « ${pending} »`);
  if (!(E ? /Approval card sent/ : /Carte d.approbation envoyée/).test(await item(page, "pro").innerText())) throw new StepError("pas de message « carte envoyée »");
  await shot(page, `${dev}-3-pending`);

  // Approuvé (geste du noyau simulé) : actif après rechargement.
  await s.dev({ approve: "all" });
  await page.reload();
  await until(page, "partage actif", () => !!document.querySelector('[data-grant="ac_sam"][data-grant-status="active"]'));

  // Retirer la boîte partagée avec moi.
  await shared.getByRole("button", { name: E ? "Remove from my mailboxes" : "Retirer de mes boîtes" }).click();
  await shared.getByRole("button", { name: E ? "Confirm: I will lose access" : "Confirmer : je n'y aurai plus accès" }).click();
  await until(page, "partagée retirée", () => !document.querySelector("[data-cm-shared]"));

  // Supprimer privé (le défaut) : pro redevient le défaut.
  await item(page, "privé").getByRole("button", { name: E ? "Delete" : "Supprimer" }).click();
  await item(page, "privé").getByRole("button", { name: E ? "Confirm deletion" : "Confirmer la suppression" }).click();
  await until(page, "privé supprimée", () => ![...document.querySelectorAll(".cm-label")].some((l) => l.textContent === "privé"));
  if (!(await item(page, "pro").locator("[data-default]").count())) throw new StepError("pro n'est pas redevenue le défaut");
  await noOverflow(page, "fin");
  await shot(page, `${dev}-4-end`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = [];
let failed = 0;
for (const [dev, opts] of DEVICES) {
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  const t0 = Date.now();
  try {
    await journey(page, s, dev);
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   connectors-multi ${dev} ${Date.now() - t0} ms`);
  } catch (e) {
    failed++;
    report.push(`FAIL connectors-multi ${dev}: ${e.message}`);
    await shot(page, `FAIL-connectors-multi-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
console.log(`${report.length - failed}/${report.length}`);
process.exit(failed ? 1 : 0);
