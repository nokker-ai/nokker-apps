/**
 * Recette du kiosque HDMI d'un Lokkal dans un vrai Chromium, build de prod sous sa CSP, en 1920×1080 :
 * `/kiosk#token=<clé locale>` → la clé disparaît de l'adresse et ne devient pas celle de l'app ; horloge, tuiles locales
 * (météo, départs, aides de test de la maison), Nina (6 calques) ; aucun appel hors `/v1/local/kiosk` en 4xx ;
 * « Mode perso » → l'app, qui redemande sa clé.
 *
 * Usage : `VITE_NOKKER_KIOSK=1 E2E_PREVIEW=1 node e2e/kiosk.mjs` (E2E_SHOTS=<dossier>).
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
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 30000);
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : null;
const ALLOWED_4XX = [
  [404, /\/v1\/(guide|speech|account\/models|capabilities|packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|payments\/\w+)(\?|$)/],
  [401, /\/v1\/local\//],
];

const freePort = () =>
  new Promise((ok, ko) => {
    const s = createServer();
    s.once("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function waitHttp(url, ms = 60000) {
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

async function servers() {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-kiosk-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort) };
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
  return { base, mock: `http://127.0.0.1:${mockPort}`, stop, token: readFileSync(join(cfg, "local-token"), "utf8").trim() };
}

async function until(page, what, fn, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout: STEP_MS, polling: 100 });
  } catch {
    throw new Error(`timeout: ${what}`);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}


async function main() {
  const s = await servers();
  const browser = await chromium.launch({ headless: true });
  const problems = [];
  let error = null;
  try {
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: scheme, locale: "fr-CH" });
      const page = await ctx.newPage();
      cspWatch(page, () => page.url());
      const posts = [];
      page.on("request", (r) => { if (r.method() !== "GET") posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
      page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
      page.on("response", (r) => { if (r.status() >= 400 && !ALLOWED_4XX.some(([st, re]) => r.status() === st && re.test(r.url()))) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(/\?.*$/, "")}`); });
      page.on("console", (m) => { if (m.type() === "error" && !/404|401|net::ERR/.test(m.text())) problems.push(`console: ${m.text().slice(0, 160)}`); });
      await page.goto(`${s.base}/kiosk#token=${encodeURIComponent(s.token)}`);
      await until(page, "kiosque prêt", () => document.querySelector("[data-kiosk]")?.getAttribute("data-kiosk") === "ready");
      await until(page, "aides de test", () => /Lampe \(test\)/.test(document.body.innerText));
      await until(page, "Nina", () => document.querySelectorAll("[data-kiosk-nina] .nk-nina img").length === 6);
      // Tuile « écran publié » : présente (iframe sandbox strict, page chargée) seulement avec MOCK_KIOSK_SCREEN=1, sinon absente.
      const tileCount = await page.locator("[data-kiosk-screen]").count();
      if (process.env.MOCK_KIOSK_SCREEN === "1") {
        if (tileCount !== 1) problems.push("la tuile de l'écran publié manque");
        else {
          const f = page.locator("[data-kiosk-screen] iframe");
          if ((await f.getAttribute("sandbox")) !== "") problems.push("l'iframe de la tuile n'est pas en sandbox strict");
          const inner = await (await f.elementHandle())?.contentFrame();
          await inner?.waitForSelector("h1", { timeout: STEP_MS }).catch(() => problems.push("la page de la tuile ne s'affiche pas"));
        }
      } else if (tileCount) problems.push("une tuile d'écran sans écran publié");
      // Foyer démo (MOCK_KIOSK_HOUSEHOLD=1) : marqueur « Démo », prénoms fictifs, coches inertes, aucun POST ; sinon rien de tout cela.
      const demoOn = process.env.MOCK_KIOSK_HOUSEHOLD === "1";
      if ((await page.locator("[data-kiosk-demo]").count()) !== (demoOn ? 1 : 0)) problems.push(demoOn ? "le marqueur « Démo » manque" : "un marqueur « Démo » sans foyer démo");
      if (demoOn) {
        await until(page, "tâche du foyer démo", () => /Sortir les poubelles/.test(document.body.innerText));
        if (!(await page.evaluate(() => document.querySelector(".kk-home")?.hasAttribute("inert")))) problems.push("la section du foyer n'est pas inerte");
        await page.locator(".kk-home .fy-check").first().click({ force: true, timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        if (posts.length) problems.push(`écriture depuis le kiosque : ${posts.join(", ")}`);
      }
      if (page.url().includes("token=")) problems.push("la clé reste dans l'adresse");
      const app = await page.evaluate(() => localStorage.getItem("nokker.local-token") ?? sessionStorage.getItem("nokker.local-token"));
      if (app) problems.push("la clé du kiosque est devenue celle de l'app");
      const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight);
      if (over) problems.push("barre de défilement sur l'écran du kiosque");
      await page.waitForTimeout(800);
      await shot(page, `kiosque-${scheme}`);
      if (scheme === "light") {
        await page.locator("[data-kiosk-personal]").click();
        await page.waitForURL((u) => u.pathname === "/", { timeout: STEP_MS });
        await page.waitForTimeout(1500);
        await shot(page, "mode-perso");
        const kept = await page.evaluate(() => localStorage.getItem("nokker.local-token"));
        if (kept) problems.push("le mode perso a une clé sans qu'on l'ait retapée");
      }
      await ctx.close();
    }
  } catch (e) {
    error = e;
  } finally {
    await browser.close();
    s.stop();
  }
  if (error) throw error;
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("kiosque : OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
