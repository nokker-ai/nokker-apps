/**
 * Recette de Nina en direct (V6 live) dans un vrai Chromium, build de prod sous sa CSP : invitation (session du
 * titulaire) → `/nina-live`. Sans salle : repli sur le rig 2D en moins de 9 s. Avec `MOCK_NINA_LIVE_CREDS` (salle
 * LiveKit d'une vraie session Runway ouverte juste avant par l'outil de recette) : la vidéo de Nina arrive, ses
 * sous-titres aussi ; captures pendant qu'elle parle. Le micro n'est jamais ouvert.
 *
 * Usage : `VITE_NOKKER_NINA_LIVE=1 E2E_PREVIEW=1 [MOCK_NINA_LIVE_CREDS=…] node e2e/nina-live.mjs` (E2E_SHOTS=<dossier>).
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
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-ninalive-"));
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
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "light", locale: "fr-CH" });
  const page = await ctx.newPage();
  const problems = [];
  const live = !!process.env.MOCK_NINA_LIVE_CREDS;
  cspWatch(page, () => page.url());
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  // En repli (sans salle), le 404 de POST /v1/nina-live/session est ATTENDU : c'est lui qui déclenche le rig 2D.
  const fallback404 = (r) => !live && r.status() === 404 && r.request().method() === "POST" && /\/v1\/nina-live\/session(\?|$)/.test(r.url());
  page.on("response", (r) => { if (r.status() >= 400 && !/\/v1\/(guide|speech|capabilities)/.test(r.url()) && !fallback404(r)) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(/\?.*$/, "")}`); });
  await page.addInitScript(() => { window.__nkLiveDebug = true; });
  const data = [];
  page.on("console", (m) => { if (m.text().startsWith("NKNL")) data.push(m.text()); });
  process.on("exit", () => console.log(`données reçues : ${data.length ? data.join(" | ") : "aucune"}`));
  page.on("console", (m) => { if (m.type() === "error" && !/404|net::ERR/.test(m.text())) problems.push(`console: ${m.text().slice(0, 160)}`); });
  let error = null;
  const t = {};
  try {
    await page.goto(`${s.base}/invite?t=demo`);
    await until(page, "conditions", () => document.querySelectorAll('.ob-card input[type="checkbox"]').length >= 1 && !document.querySelector('.ob-card input[type="checkbox"]').disabled);
    await page.locator('.ob-card input[type="checkbox"]').first().check();
    await page.locator(".ob-card .ob-actions .ob-btn.primary").first().click();
    await until(page, "connecteurs", () => /Aller au chat|Go to the chat/.test(document.body.innerText));
    const t0 = Date.now();
    await page.goto(`${s.base}/nina-live`);
    await until(page, "cadre de Nina", () => !!document.querySelector(".nk-nina-live"));
    await shot(page, "1-connexion");
    if (live) {
      await until(page, "vidéo de Nina en direct", () => document.querySelector(".nk-nina-live")?.getAttribute("data-mode") === "live");
      t.videoMs = Date.now() - t0;
      await page.waitForTimeout(1500);
      await shot(page, "2-nina-en-direct");
      await until(page, "sous-titre", () => (document.querySelector(".nl-caption")?.textContent ?? "").length > 5);
      t.captionMs = Date.now() - t0;
      await shot(page, "3-sous-titre");
      await page.waitForTimeout(4000);
      await shot(page, "4-nina-parle");
      const mic = await page.evaluate(() => document.querySelector(".nl-actions .ob-btn.primary")?.textContent ?? "");
      if (!/Parler/.test(mic)) problems.push("le micro semble ouvert sans geste");
    } else {
      await until(page, "repli sur le rig 2D", () => document.querySelector(".nk-nina-live")?.getAttribute("data-mode") === "fallback" && document.querySelectorAll(".nk-nina img").length === 6);
      t.fallbackMs = Date.now() - t0;
      await shot(page, "2-repli");
    }
  } catch (e) {
    error = String(e?.message ?? e);
    await shot(page, "FAILED").catch(() => {});
  }
  await browser.close();
  s.stop();
  console.log(`${!error && !problems.length ? "PASS" : "FAIL"} nina-live (${live ? "salle réelle" : "repli"}) ${JSON.stringify(t)}`);
  if (error) console.log(`  étape : ${error}`);
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
  process.exit(!error && !problems.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
