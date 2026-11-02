/**
 * Recette du Guide (core docs/GUIDE.md), dans un vrai Chromium (sans tête) contre le mock :
 *  - drapeaux ALLUMÉS (mock MOCK_GUIDE=1 MOCK_SHOW_ME=1, web VITE_NOKKER_GUIDE=1 VITE_NOKKER_SHOW_ME=1) : « Découvrir »
 *    (menu du compte puis palette) → tour d'accueil de trois cartes → « Compris » → une question → la carte avec
 *    « Ouvrir » (bascule sur l'écran) et « Montre-moi » (flèche sur l'élément) ; `/guide <question>` dans le composeur
 *    ouvre le Guide sans rien envoyer au modèle ; sur ordinateur (en) et téléphone (fr), sans débordement ;
 *  - drapeaux ÉTEINTS (défaut) : « Découvrir » absent (menu, palette) et AUCUNE requête /v1/guide, `/guide` est un
 *    message ordinaire.
 * Usage : `node e2e/guide.mjs` (E2E_SHOTS=<dossier> pour les captures, E2E_ONLY=on|off).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const MOCK = resolve(WEB, "../../packages/mock-server");
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 15000);
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : null;
const EMAIL = "alice@example.com";
const CODE = "123456"; // MOCK_EMAIL_CODE
const ALLOWED_4XX = [
  [404, /\/v1\/(packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|payments\/budgets|payments\/mandates|local\/folder\/runs)(\?|$)/],
  [401, /\/v1\/local\//],
  [429, /\/v1\/guide\/ask$/], // le parcours provoque le quota (mot « quota » du mock)
];
const DESKTOP = { viewport: { width: 1280, height: 800 }, locale: "en-US" };
const PHONE_FR = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "fr-CH" };

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

/** Un mock et un web neufs ; `on` allume les drapeaux du Guide et du « montre-moi », de part et d'autre. */
async function servers(on) {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-guide-"));
  mkdirSync(join(cfg, "work", "proj"), { recursive: true });
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_LOCAL_ROOTS: join(cfg, "work"), MOCK_WHO_DOES_WHAT: "1", ...(on ? { MOCK_GUIDE: "1", MOCK_SHOW_ME: "1" } : {}) };
  const webEnv = { ...process.env, NOKKER_SERVER_URL: `http://127.0.0.1:${mockPort}` };
  delete webEnv.VITE_NOKKER_GUIDE;
  delete webEnv.VITE_NOKKER_SHOW_ME;
  if (on) Object.assign(webEnv, { VITE_NOKKER_GUIDE: "1", VITE_NOKKER_SHOW_ME: "1" });
  const procs = [
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("npx", ["vite", "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB, env: webEnv, stdio: ["ignore", "ignore", "inherit"], detached: true }),
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
  return { base, stop };
}

function watch(page, problems, seen) {
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("request", (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
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

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function noOverflow(page, where) {
  const o = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const p = document.querySelector(".guide-panel");
    const r = p?.getBoundingClientRect();
    const wide = [...document.querySelectorAll(".guide-panel *")].filter((e) => e.getBoundingClientRect().right > vw + 1).length;
    return { scroll: document.documentElement.scrollWidth - vw, wide, panelOut: r ? r.left < -1 || r.right > vw + 1 : false };
  });
  if (o.scroll > 1 || o.wide || o.panelOut) throw new StepError(`${where} : débordement (${JSON.stringify(o)})`);
}

async function login(page, base) {
  await page.goto(base);
  await page.waitForSelector("#wl-email", { timeout: STEP_MS });
  await page.fill("#wl-email", EMAIL);
  await page.click("form button[type=submit]");
  await page.waitForSelector("#wl-code", { timeout: STEP_MS });
  await page.fill("#wl-code", CODE);
  await page.keyboard.press("Enter");
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
}

const WORDS = {
  en: { discover: /^Discover$/, gotIt: /^Got it$/, open: /^Open$/, showMe: /Show me/, tryNext: /Try next/, can: /What I can do/ },
  fr: { discover: /^Découvrir$/, gotIt: /^Compris$/, open: /^Ouvrir$/, showMe: /Montre-moi/, tryNext: /Essaie ensuite/, can: /Ce que je sais faire/ },
};

async function openFromMenu(page, w) {
  await page.locator(".acct-btn").click();
  await page.locator("[data-guide-open]").filter({ hasText: w.discover }).click();
  await page.waitForSelector(".guide-panel", { timeout: STEP_MS });
}

async function on(page, base, _seen, lang) {
  const w = WORDS[lang];
  await login(page, base);
  const guideReqs = () => _seen.filter((r) => r.includes("/v1/guide")).length;
  for (let i = 0; i < 50 && !_seen.includes("GET /v1/guide"); i++) await page.waitForTimeout(100);
  if (!_seen.includes("GET /v1/guide")) throw new StepError("la sonde GET /v1/guide n'a pas eu lieu drapeau allumé");
  // 1. Menu → Découvrir → tour d'accueil (3 cartes), pas encore de champ de question.
  await openFromMenu(page, w);
  await until(page, "tour d'accueil", () => document.querySelectorAll('.guide-panel [data-part="tour"] .guide-card').length === 3);
  if (await page.locator("#nk-guide-q").count()) throw new StepError("le champ de question ne doit venir qu'après le tour");
  await shot(page, `guide-${lang}-tour`);
  await noOverflow(page, "tour");
  // 2. Compris → POST /v1/guide/intro, puis « Essaie ensuite » et la liste par statut.
  await page.getByRole("button", { name: w.gotIt }).click();
  await until(page, "après le tour : essaie ensuite + liste", () => !!document.querySelector('.guide-panel [data-part="next"]') && document.querySelectorAll(".guide-panel [data-group]").length === 3);
  if (!_seen.includes("POST /v1/guide/intro")) throw new StepError("« Compris » n'a pas posté /v1/guide/intro");
  const groups = await page.locator(".guide-panel [data-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-group")));
  if (groups.join() !== "on,setup,off") throw new StepError(`groupes ${groups.join()}`);
  // Une fonction « pas encore disponible » n'a ni bouton ni commande.
  const offButtons = await page.locator('.guide-panel [data-status="off"] button, .guide-panel [data-status="not_for_you"] button').count();
  if (offButtons) throw new StepError("une fonction non disponible porte un bouton");
  await shot(page, `guide-${lang}-list`);
  await noOverflow(page, "liste");
  // 3. Une question → réponse + cartes citées, « Ouvrir » ouvre le Crew et ferme le Guide.
  await page.fill("#nk-guide-q", "que sais-tu faire ?");
  await page.keyboard.press("Enter");
  await until(page, "réponse du Guide", () => !!document.querySelector(".guide-msg.assistant [data-feature=crew]"));
  const body = await page.locator(".guide-msg.assistant").first().innerText();
  if (!/Crew/.test(body)) throw new StepError("la carte Crew n'est pas dans la réponse");
  await shot(page, `guide-${lang}-answer`);
  await noOverflow(page, "réponse");
  await page.locator(".guide-msg.assistant [data-feature=crew]").getByRole("button", { name: w.open }).click();
  await until(page, "écran Crew ouvert, Guide fermé", () => !!document.querySelector(".view-crew") && !document.querySelector(".guide-panel"));
  // 4. Palette (Ctrl K) → Découvrir → Montre-moi : la flèche vient sur le trombone.
  await page.locator(".back-chat").click();
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.keyboard.press("Control+k");
  await page.keyboard.type(lang === "fr" ? "Découvrir" : "Discover");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".guide-panel", { timeout: STEP_MS });
  if (await page.locator('.guide-panel [data-part="tour"]').count()) throw new StepError("le tour revient alors qu'il est vu");
  await page.fill("#nk-guide-q", "comment joindre une photo ?");
  await page.keyboard.press("Enter");
  await until(page, "carte Images", () => !!document.querySelector(".guide-msg.assistant [data-feature=images]"));
  await page.locator(".guide-msg.assistant [data-feature=images]").getByRole("button", { name: w.showMe }).click();
  await until(page, "flèche sur le trombone", () => {
    const ring = document.querySelector(".showme-overlay .showme-ring")?.getBoundingClientRect();
    const el = document.querySelector('[data-show-me="attach"]')?.getBoundingClientRect();
    return !!ring && !!el && Math.abs(ring.left + ring.width / 2 - (el.left + el.width / 2)) < 4 && !document.querySelector(".guide-panel");
  });
  await shot(page, `guide-${lang}-show-me`);
  // 5. /guide <question> dans le composeur : le Guide s'ouvre, rien ne part au modèle.
  const before = _seen.length;
  await page.fill("#nk-composer", "/guide que sais-tu faire ?");
  await page.keyboard.press("Enter");
  await until(page, "Guide ouvert par /guide avec la réponse", () => !!document.querySelector(".guide-panel .guide-msg.assistant"));
  const sent = _seen.slice(before).filter((r) => /chat\/completions|\/messages/.test(r));
  if (sent.length) throw new StepError(`/guide est parti au modèle : ${sent.join(", ")}`);
  if ((await page.locator("#nk-composer").inputValue()) !== "") throw new StepError("le composeur n'a pas été vidé");
  // 6. Erreurs traduites (429).
  await page.fill("#nk-guide-q", "quota");
  await page.keyboard.press("Enter");
  await until(page, "message de quota traduit", () => /(asked a lot|beaucoup demandé)/.test(document.querySelector(".guide-ask .error")?.textContent ?? ""));
  if (guideReqs() < 4) throw new StepError("trop peu de requêtes /v1/guide");
}

async function off(page, base, seen) {
  await login(page, base);
  await page.waitForTimeout(1500);
  await page.locator(".acct-btn").click();
  await page.locator(".menu-pop").waitFor({ timeout: STEP_MS });
  if (await page.locator("[data-guide-open]").count()) throw new StepError("« Discover » présent drapeau éteint (menu)");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Discover");
  await page.waitForTimeout(300);
  if ((await page.locator(".palette").innerText()).includes("Discover") && (await page.locator(".palette [role=option]").filter({ hasText: /^Discover/ }).count())) throw new StepError("« Discover » présent drapeau éteint (palette)");
  await page.keyboard.press("Escape");
  // `/guide` n'est qu'un message ordinaire : il part au modèle, aucun Guide.
  await page.fill("#nk-composer", "/guide");
  await page.keyboard.press("Enter");
  await until(page, "le message part comme un message ordinaire", () => /\/guide/.test(document.querySelector(".chat-inner")?.innerText ?? ""));
  if (await page.locator(".guide-panel").count()) throw new StepError("panneau Guide ouvert drapeau éteint");
  const g = seen.filter((r) => r.includes("/v1/guide"));
  if (g.length) throw new StepError(`requêtes /v1/guide drapeau éteint : ${g.join(", ")}`);
}

async function main() {
  const only = process.env.E2E_ONLY;
  const browser = await chromium.launch({ headless: !process.env.E2E_HEADED });
  const runs = [
    ["on-desktop-en", true, DESKTOP, (p, b, s) => on(p, b, s, "en")],
    ["on-phone-fr", true, PHONE_FR, (p, b, s) => on(p, b, s, "fr")],
    ["off-desktop-en", false, DESKTOP, off],
  ].filter(([n]) => !only || n.startsWith(only));
  const report = [];
  for (const [name, flagOn, device, fn] of runs) {
    const s = await servers(flagOn);
    const ctx = await browser.newContext(device);
    const page = await ctx.newPage();
    const problems = [];
    const seen = [];
    watch(page, problems, seen);
    const t0 = Date.now();
    let error = null;
    try {
      await fn(page, s.base, seen);
    } catch (e) {
      error = e instanceof StepError ? e.message : String(e?.stack ?? e);
      await shot(page, `${name}-FAILED`);
    }
    report.push({ name, ok: !error && problems.length === 0, ms: Date.now() - t0, error, problems: [...new Set(problems)] });
    await ctx.close();
    s.stop();
  }
  await browser.close();
  for (const r of report) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} (${r.ms} ms)`);
    if (r.error) console.log(`  step: ${r.error}`);
    for (const p of r.problems) console.log(`  ${p}`);
  }
  process.exit(report.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
