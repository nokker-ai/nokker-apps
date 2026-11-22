/**
 * Recette de l'étape « Ton Nokker » (V6) dans un vrai Chromium (WebGL logiciel) contre le mock : invitation →
 * conditions → connecteurs → « Ton Nokker » (avatar 3D rendu, nom, voix, aperçu qui parle) → étape suivante. Puis
 * l'annonce du matin d'un MUR : appairage d'un mur, brief montré, `GET /v1/glance/brief/speech` en jeton nkg_.
 *
 * Usage : `VITE_NOKKER_ONBOARDING_AVATAR=1 E2E_PREVIEW=1 node e2e/persona.mjs` (E2E_SHOTS=<dossier> pour les captures).
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
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-persona-"));
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

async function personaStep(page, s, problems, wallSpeech) {
  await page.goto(`${s.base}/invite?t=demo`);
  await until(page, "conditions", () => document.querySelectorAll('.ob-card input[type="checkbox"]').length >= 1 && !document.querySelector('.ob-card input[type="checkbox"]').disabled);
  await page.locator('.ob-card input[type="checkbox"]').first().check();
  await page.locator(".ob-card .ob-actions .ob-btn.primary").first().click();
  await until(page, "connecteurs", () => /Étape suivante : ton Nokker/.test(document.body.innerText));
  await shot(page, "1-connecteurs");
  await page.getByRole("button", { name: /Étape suivante : ton Nokker/ }).click();
  await until(page, "étape Ton Nokker", () => /Ton Nokker/.test(document.querySelector("#ob-title")?.textContent ?? "") && document.querySelectorAll(".ob-persona-thumb").length >= 1);
  await until(page, "Nina affichée (calques chargés)", () => [...document.querySelectorAll(".ob-persona-stage .nk-nina img")].length === 6 && [...document.querySelectorAll(".ob-persona-stage .nk-nina img")].every((i) => i.complete && i.naturalWidth > 0));
  await page.waitForTimeout(800);
  await shot(page, "2-ton-nokker");
  const name = page.locator(".ob-field input").first();
  await name.fill("Ada");
  await shot(page, "3-ton-nokker-ada");
  await page.getByRole("button", { name: /Écouter/ }).click();
  // Pendant l'aperçu : la bouche change (calque « fermée » visible puis masqué) — échantillonnage sur 2,5 s.
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(100);
    seen.add(await page.evaluate(() => {
      const imgs = [...document.querySelectorAll(".ob-persona-stage .nk-nina-head img")];
      const half = imgs.find((x) => x.src.endsWith("mouth-half.webp"));
      const closed = imgs.find((x) => x.src.endsWith("mouth-closed.webp"));
      return closed?.style.opacity === "1" ? "closed" : half?.style.opacity === "1" ? "half" : "open";
    }));
    if (i === 8) await shot(page, "4-apercu-parle");
  }
  const mouth = seen.has("open") && seen.size >= 2;
  await page.waitForTimeout(1500);
  if (wallSpeech) {
    // Même composant, parole de la route du mur (GET /v1/glance/brief/speech, nkg_) : l'annonce du matin par Nina.
    await page.route("**/v1/persona/preview", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wallSpeech) }));
    await page.getByRole("button", { name: /Écouter/ }).click();
    await page.waitForTimeout(900);
    await shot(page, "6-annonce-du-mur");
    await page.waitForTimeout(2600);
    await page.unroute("**/v1/persona/preview");
  }
  await page.getByRole("button", { name: /^Continuer$/ }).click();
  await until(page, "étape suivante (Telegram)", () => !/Ton Nokker/.test(document.querySelector("#ob-title")?.textContent ?? ""));
  await shot(page, "5-apres");
  if (!mouth) problems.push(`la bouche n'a pas bougé pendant l'aperçu (${[...seen].join(",")})`);
}

async function wallBrief(s) {
  const h = { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" };
  await fetch(`${s.mock}/v1/plan/brief`, { method: "POST", headers: h, body: "{}" }); // le brief du matin existe
  const offer = await (await fetch(`${s.mock}/v1/glance/pair`, { method: "POST", headers: h, body: JSON.stringify({ name: "Cuisine", surface: "wall" }) })).json();
  const claim = await (await fetch(`${s.mock}/v1/glance/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: offer.code }) })).json();
  const nkg = { Authorization: `Bearer ${claim.token}` };
  const hidden = await fetch(`${s.mock}/v1/glance/brief/speech`, { headers: nkg });
  await fetch(`${s.mock}/v1/glance/devices/${claim.device.id}`, { method: "PATCH", headers: h, body: JSON.stringify({ show_brief: true }) });
  const view = await (await fetch(`${s.mock}/v1/glance`, { headers: nkg })).json();
  const sp = await fetch(`${s.mock}/v1/glance/brief/speech`, { headers: nkg });
  const body = await sp.json();
  if (SHOTS && sp.status === 200) {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "wall-speech.json"), JSON.stringify(body));
  }
  return {
    speech: sp.status === 200 ? body : null, hidden: hidden.status, avatar: view.avatar, lang: view.lang, status: sp.status, words: body.words?.length ?? 0, text: (body.words ?? []).join(" "), code: body.error?.code };
}

async function main() {
  const s = await servers();
  const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "light", locale: "fr-CH" });
  const page = await ctx.newPage();
  const problems = [];
  cspWatch(page, () => page.url());
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    const st = r.status();
    if (st < 400) return;
    const url = r.url();
    if (st < 500 && ALLOWED_4XX.some(([c, re]) => c === st && re.test(url))) return;
    problems.push(`HTTP ${st} ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  });
  let error = null;
  let wall = null;
  try {
    wall = await wallBrief(s);
    await personaStep(page, s, problems, wall.speech);
    delete wall.speech;
  } catch (e) {
    error = String(e?.message ?? e);
    await shot(page, "FAILED").catch(() => {});
  }
  await browser.close();
  s.stop();
  console.log(`${!error && !problems.length ? "PASS" : "FAIL"} ton-nokker`);
  if (error) console.log(`  étape : ${error}`);
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
  console.log(`mur : ${JSON.stringify(wall)}`);
  process.exit(!error && !problems.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
