/**
 * Recette des écrans de la zone onboarding, dans un vrai Chromium (sans tête) contre le mock, sur `localhost`
 * (contexte sécurisé : clés d'appareil WebCrypto, donc vraie acceptation d'invitation) :
 *  - invitation `/invite?t=…` → conditions → connecteurs : « Aller au chat » mène au chat, où le fil vide
 *    propose ses premières demandes (temps jusqu'à la première valeur, chronométré) ;
 *  - premier lancement Lokkal `/setup` → fin → « Tu viens d'un autre agent ? » : aperçu puis Importer ;
 *  - Apprentissage `/journey` : journal, À valider (Retenir), Skills (revenir à une version) ;
 *  - mémoire Codex importée comme données (Lokkal local) : datée, retenir une entrée, défaire tout l'import.
 * Chaque parcours tourne sur ordinateur clair (1280), téléphone sombre (390) et petit téléphone (320) en français.
 * Il échoue sur une étape non atteinte, une erreur de page, un 5xx, un 4xx inattendu ou un débordement horizontal.
 * Usage : `node e2e/onboarding.mjs` (E2E_SHOTS=<dossier> pour les captures, E2E_ONLY=<parcours>).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
// /v1/guide : le build de prod (E2E_PREVIEW=1) allume le guide, que le mock de cette recette ne sert pas (404).
const ALLOWED_4XX = [
  [404, /\/v1\/(guide|speech|account\/models|capabilities|packs|code\/sessions|household\/invitations\/received|sso\/connections|local\/import\/report|glance\/devices|house|presence|memory\/consolidation\/runs|payments\/budgets|payments\/mandates|payments\/method|local\/folder\/runs)(\?|$)/],
  [401, /\/v1\/local\//],
];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DEVICES = [
  ["desktop-light", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "en-US" }, "demo-en"],
  ["phone-dark", { ...PHONE, colorScheme: "dark", locale: "en-US" }, "demo-en"],
  ["small-phone-fr", { ...PHONE, viewport: { width: 320, height: 568 }, colorScheme: "light", locale: "fr-CH" }, "demo"],
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
  throw new Error(`${url} ne répond pas`);
}

/** Un mock neuf par parcours : les invitations de démo ne servent qu'une fois. */
async function servers() {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-onb-"));
  mkdirSync(join(cfg, "work", "proj"), { recursive: true });
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_LOCAL_ROOTS: join(cfg, "work") };
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
        /* déjà parti */
      }
    }
    rmSync(cfg, { recursive: true, force: true });
  };
  process.on("exit", stop);
  await waitHttp(`http://127.0.0.1:${mockPort}/`);
  const base = `http://localhost:${webPort}`;
  await waitHttp(base);
  return { base, stop, token: readFileSync(join(cfg, "local-token"), "utf8").trim() };
}

function watch(page, problems) {
  cspWatch(page, () => page.url().replace(/^https?:\/\/[^/]+/, ""));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
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
    throw new StepError(`timeout: ${what}`);
  }
}

async function noOverflow(page, where) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll("body *")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.right > vw + 1 && getComputedStyle(e).position !== "fixed" && !e.closest("pre, .imp-cmd, .lrn-rule, .lrn-tabs, [style*='overflow']");
      })
      .slice(0, 3)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
    return { scroll: document.documentElement.scrollWidth - vw, wide };
  });
  if (o.scroll > 1 || o.wide.length) throw new StepError(`${where}: débordement de ${o.scroll}px (${o.wide.join(", ")})`);
}

/** Parcours sombre : les écrans hors de la coque suivent aussi le réglage mémorisé. */
async function themeOk(page, dev, where) {
  if (!dev.includes("dark")) return;
  const th = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (th !== "dark") throw new StepError(`${where} : thème sombre mémorisé non appliqué (data-theme=${th})`);
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

const clickText = (page, re) => page.getByRole("button", { name: re }).first().click();

// ── parcours ──

async function invite(page, s, t, dev, token) {
  const t0 = Date.now();
  await page.goto(`${s.base}/invite?t=${token}`);
  await until(page, "conditions affichées", () => document.querySelectorAll('.ob-card input[type="checkbox"]').length >= 1 && !document.querySelector('.ob-card input[type="checkbox"]').disabled);
  await themeOk(page, dev, "invitation");
  await shot(page, `${dev}-invite-terms`);
  await noOverflow(page, "conditions");
  await page.locator('.ob-card input[type="checkbox"]').first().check();
  await page.locator(".ob-card .ob-actions .ob-btn.primary").first().click();
  await until(page, "étape connecteurs", () => /Aller au chat|Go to the chat/.test(document.body.innerText));
  t.toConnectorsMs = Date.now() - t0;
  const cut = await page.evaluate(() => [...document.querySelectorAll(".ob-steplabel")].filter((e) => e.clientWidth > 1 && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  if (cut.length) throw new StepError(`étapes coupées : ${cut.join(", ")}`);
  await shot(page, `${dev}-invite-connectors`);
  await noOverflow(page, "connecteurs");
  await clickText(page, /Aller au chat|Go to the chat/);
  await until(page, "chat ouvert", () => !!document.querySelector("#nk-composer"));
  t.inviteToChatMs = Date.now() - t0;
  // Le mock remplit d'avance des fils de démo ; un vrai premier fil est vide : nouvelle session pour voir le fil vide.
  if (!(await page.locator(".first-steps").count())) {
    if (await page.locator(".drawer-fab").count()) await page.locator(".drawer-fab").click();
    await page.getByRole("button", { name: /New session|Nouvelle session/ }).first().click();
    const input = page.locator("#nk-drawer input, .drawer input").first();
    await input.fill("Recette");
    await input.press("Enter");
  }
  await until(page, "premières demandes sur un fil vide", () => !!document.querySelector(".first-steps"));
  await shot(page, `${dev}-first-steps`);
  await noOverflow(page, "premières demandes");
  await page.locator(".first-idea").first().click();
  await until(page, "la saisie est remplie", () => (document.querySelector("#nk-composer")?.value ?? "").length > 10);
}

async function setup(page, s, t, dev) {
  const t0 = Date.now();
  await page.goto(`${s.base}/setup#token=${s.token}`);
  await until(page, "étape modèles", () => [...document.querySelectorAll(".ob-actions button")].some((b) => /^(Continue|Continuer)$/.test(b.textContent.trim()) && !b.disabled));
  await noOverflow(page, "setup modèles");
  await themeOk(page, dev, "premier lancement");
  await clickText(page, /^(Continue|Continuer)$/);
  for (const i of [1, 2]) {
    await until(page, `étape ${i + 1}`, () => [...document.querySelectorAll(".ob-actions button")].some((b) => /^(Skip|Passer)$/.test(b.textContent.trim())));
    await clickText(page, /^(Skip|Passer)$/);
  }
  await until(page, "carte d'import", () => !!document.querySelector(".imp-card"));
  t.setupToImportMs = Date.now() - t0;
  await page.locator(".imp-sources .ob-btn", { hasText: "Claude Code" }).click();
  await until(page, "aperçu de l'import", () => document.querySelectorAll(".imp-report h4").length >= 1);
  await shot(page, `${dev}-import-preview`);
  await noOverflow(page, "aperçu import");
  await page.locator(".imp-card .ob-actions .ob-btn").click();
  await until(page, "import fait", () => /Import done|Import fait/.test(document.querySelector(".imp-card")?.innerText ?? ""));
  await shot(page, `${dev}-import-done`);
  await noOverflow(page, "import fait");
}

async function learning(page, s, t, dev) {
  // Session de démo du mock (contexte sécurisé : connexion par code, comme un testeur).
  await page.goto(s.base);
  await page.waitForSelector("#wl-email", { timeout: STEP_MS });
  await page.fill("#wl-email", "alice@example.com");
  await page.click("form button[type=submit]");
  await page.waitForSelector("#wl-code", { timeout: STEP_MS });
  await page.fill("#wl-code", "123456");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.goto(`${s.base}/journey`);
  await until(page, "journal affiché", () => document.querySelectorAll(".lrn-entry").length >= 3);
  await shot(page, `${dev}-journey`);
  await noOverflow(page, "journal");
  await page.locator(".lrn-tab").nth(0).click();
  await until(page, "notes à valider", () => document.querySelectorAll(".lrn-card").length >= 2);
  await noOverflow(page, "à valider");
  await shot(page, `${dev}-to-approve`);
  const before = await page.locator(".lrn-card").count();
  await page.locator(".lrn-card .btn-brass").first().click();
  await until(page, "une note de moins", (n) => document.querySelectorAll(".lrn-card").length === n - 1, before);
  await page.locator(".lrn-tab").nth(2).click();
  await until(page, "skills listés", () => !!document.querySelector(".lrn-skill-row"));
  await page.locator(".lrn-skill-row").first().click();
  await until(page, "diff affiché", () => !!document.querySelector(".lrn-diff"));
  await noOverflow(page, "skill (diff)");
  await shot(page, `${dev}-skill`);
  await page.locator(".lrn-versions .lrn-link", { hasText: "v1" }).click();
  await until(page, "bouton revenir", () => [...document.querySelectorAll(".lrn-detail .btn-brass")].some((b) => /v1/.test(b.textContent)));
  await page.locator(".lrn-detail .btn-brass").first().click();
  await until(page, "v3 après le retour", () => /v3/.test(document.querySelector(".lrn-skill-row")?.textContent ?? ""));
}

async function imported(page, s, t, dev) {
  // Lokkal en local (jeton du fragment) : la mémoire Codex importée comme données apparaît dans Apprentissage.
  await page.goto(`${s.base}/journey#token=${s.token}`);
  await until(page, "onglets d'Apprentissage", () => document.querySelectorAll(".lrn-tab").length === 3);
  await page.locator(".lrn-tab").nth(0).click();
  await until(page, "section importée de Codex", () => document.querySelectorAll(".lrn-imported .lrn-card").length === 3);
  const dated = await page.evaluate(() => [...document.querySelectorAll(".lrn-imported .lrn-origin")].every((e) => /Codex, .*\d{4}/.test(e.textContent)));
  if (!dated) throw new StepError("une entrée importée sans sa date d'origine");
  await noOverflow(page, "mémoire importée");
  await page.evaluate(() => document.querySelector(".lrn-imported").scrollIntoView({ block: "start" }));
  await shot(page, `${dev}-imported`);
  await page.locator(".lrn-imported .lrn-card .btn-brass").first().click();
  await until(page, "une entrée retenue", () => document.querySelectorAll(".lrn-imported .lrn-card").length === 2);
  await page.locator(".lrn-imported > .lrn-actions .btn-ghost").click();
  await page.locator(".lrn-imported .btn-danger").click();
  await until(page, "import défait", () => !document.querySelector(".lrn-imported"));
}

async function main() {
  const only = process.env.E2E_ONLY;
  const browser = await chromium.launch({ headless: true });
  const report = [];
  for (const [dev, device, token] of DEVICES) {
    for (const [name, fn] of [["invite", invite], ["setup", setup], ["learning", learning], ["imported", imported]]) {
      if (only && only !== name && only !== dev) continue;
      const s = await servers();
      const ctx = await browser.newContext(device);
      // Clair par défaut (choix produit) : le sombre est un réglage mémorisé, posé ici pour le parcours sombre.
      if (device.colorScheme === "dark") await ctx.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
      const page = await ctx.newPage();
      const problems = [];
      const t = {};
      watch(page, problems);
      const t0 = Date.now();
      let error = null;
      try {
        await fn(page, s, t, dev, token);
      } catch (e) {
        error = e instanceof StepError ? e.message : String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ");
        await shot(page, `${dev}-${name}-FAILED`).catch(() => {});
      }
      report.push({ j: `${name}/${dev}`, ok: !error && !problems.length, ms: Date.now() - t0, t, error, problems: [...new Set(problems)] });
      await ctx.close();
      s.stop();
    }
  }
  await browser.close();
  for (const r of report) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.j} (${r.ms} ms) ${JSON.stringify(r.t)}`);
    if (r.error) console.log(`  étape : ${r.error}`);
    for (const p of r.problems) console.log(`  ${p}`);
  }
  process.exit(report.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
