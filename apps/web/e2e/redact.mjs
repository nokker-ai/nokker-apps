/**
 * Recette « masquage sur l'appareil » (LOKKAL-PHONE §4.3.2, lot P9b) dans une FAUSSE COQUE : NokkerText (OCR) et
 * NokkerVault (dictionnaire en mémoire de la page, comme le fichier protégé de l'app). On intercepte ce qui part vers le
 * noyau : il ne doit voir que des marqueurs ⟦CODE-n⟧ et des compteurs, jamais une valeur masquée.
 *  1. image → « Texte seul » : IBAN et téléphone masqués par défaut dans l'aperçu ; on laisse le téléphone visible ;
 *  2. la réponse cite ⟦IBAN-1⟧ (émis ici : affiché en clair) et ⟦IBAN-9⟧ (écrit par un tiers : reste masqué) ;
 *  3. message tapé : masquage PROPOSÉ → « Masquer » → le noyau reçoit ⟦PHONE-1⟧, la bulle montre le numéro ;
 *  4. « Laisser » : le message part tel quel ; aucune valeur dans un stockage web.
 * 390 sombre EN et 1280 clair FR. Usage : `node e2e/redact.mjs` (E2E_SHOTS=<dossier>).
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


// Fausse coque : OCR qui « lit » un relevé, et un Vault en mémoire.
function fakeShell(withVault) {
  window.__NOKKER_FAKE_SHELL__ = true;
  const vault = (window.__vault = {});
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: {
      NokkerText: {
        ocrImage: async () => ({ text: "Relevé : IBAN CH93 0076 2011 6238 5295 7\nContact 079 123 45 67" }),
        speechStatus: async () => ({ speech: "granted", microphone: "granted", on_device: true }),
      },
      ...(withVault ? {} : { __noVault: true }),
      NokkerVault: withVault ? {
        status: async () => ({ available: true, rules_version: null }),
        setRules: async ({ rules }) => ((window.__vaultRules = rules.version), { version: rules.version }),
        get: async ({ thread }) => ({ pairs: { ...(vault[thread] ?? {}) } }),
        put: async ({ thread, pairs }) => {
          const cur = (vault[thread] ??= {});
          for (const [k, v] of Object.entries(pairs)) if (!(k in cur)) cur[k] = v;
          return { count: Object.keys(cur).length };
        },
        forget: async ({ thread }) => void delete vault[thread],
        forgetAll: async () => void Object.keys(vault).forEach((k) => delete vault[k]),
      } : undefined,
    },
  };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const IBAN = "CH93 0076 2011 6238 5295 7";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [dev, opts] of [["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }], ["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }], ["phone-novault-fr", { ...PHONE, locale: "fr-CH" }]]) {
  const noVault = dev.includes("novault");
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.addInitScript(fakeShell, !noVault);
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  const bodies = [];
  page.on("request", (r) => /\/v1\/chat\/completions/.test(r.url()) && r.method() === "POST" && bodies.push(r.postData() ?? ""));
  try {
    await login(page, s.base);
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    if (noVault) {
      // FAIL-CLOSED : coque SANS NokkerVault → la pièce OCR est refusée, rien n'est envoyé.
      await page.setInputFiles('.composer input[type=file][accept^="image/"]', { name: "releve.png", mimeType: "image/png", buffer: PNG });
      await page.locator("[data-ocr]").click();
      await page.locator("[data-redact-unavailable]").waitFor({ timeout: STEP_MS }).catch(() => {
        throw new StepError("aperçu sans avertissement « masquage indisponible »");
      });
      if (!/La photo partira telle quelle\./.test((await page.locator("[data-redact-unavailable]").textContent()) ?? "")) throw new StepError("l'avertissement ne dit pas que la photo partira telle quelle");
      await page.locator("[data-text-preview] .btn-brass").click();
      await until(page, "refus de joindre", () => !document.querySelector("[data-text-preview]") && !document.querySelector("[data-text-source]"));
      await shot(page, `redact-novault-${dev}`);
      const n0 = bodies.length;
      await page.fill("#nk-composer", "Résume");
      await page.keyboard.press("Enter");
      const end = Date.now() + STEP_MS;
      while (bodies.length === n0 && Date.now() < end) await page.waitForTimeout(100);
      const sent = bodies.slice(n0).join("\n");
      if (sent.includes("CH93") || sent.includes("079 123") || sent.includes('"attachments"')) throw new StepError(`une pièce est partie sans Vault : ${sent.slice(0, 200)}`);
      if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
      report.push(`ok   redact ${dev} (fail-closed)`);
      continue;
    }
    await until(page, "règles remises au Vault", () => !!window.__vaultRules);

    // 1. OCR : masquage par défaut, une valeur laissée visible.
    await page.setInputFiles('.composer input[type=file][accept^="image/"]', { name: "releve.png", mimeType: "image/png", buffer: PNG });
    await page.locator("[data-ocr]").click();
    const chips = page.locator("[data-redact-preview] [data-redact-value]");
    await chips.first().waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("pas d'aperçu masqué sur la pièce OCR");
    });
    if ((await chips.count()) !== 2) throw new StepError(`aperçu : ${await chips.count()} valeurs au lieu de 2`);
    if ((await page.locator('[data-redact-value="masked"]').count()) !== 2) throw new StepError("les valeurs ne sont pas masquées par défaut");
    await page.locator("[data-redact-preview] [data-redact-value]", { hasText: "079 123 45 67" }).click();
    await shot(page, `redact-preview-${dev}`);
    await page.locator("[data-text-preview] .btn-brass").click();
    await page.fill("#nk-composer", dev.includes("-en") ? "Summarise" : "Résume");
    await page.keyboard.press("Enter");
    await until(page, "réponse", () => [...document.querySelectorAll(".msg.nina")].some((n) => /Noted/.test(n.textContent ?? "")));
    const b1 = JSON.parse(bodies.at(-1));
    const att = b1.attachments?.[0];
    if (!att || !att.text.includes("⟦IBAN-1⟧") || att.text.includes("CH93") || !att.text.includes("079 123 45 67")) throw new StepError(`pièce envoyée : ${att?.text}`);
    if (JSON.stringify(att.redaction?.counts) !== JSON.stringify({ IBAN: 1 })) throw new StepError(`compteurs : ${JSON.stringify(att.redaction)}`);

    // 2. Démasquage : seulement ce que cet appareil a émis dans ce fil.
    const mine = page.locator('.msg.nina .redact-unmasked[data-marker="⟦IBAN-1⟧"]').last();
    await mine.waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("⟦IBAN-1⟧ n'est pas démasqué dans la réponse");
    });
    if ((await mine.textContent())?.trim() !== IBAN) throw new StepError(`démasqué en ${await mine.textContent()}`);
    if (!(await page.locator('.msg.nina .redact-marker[data-marker="⟦IBAN-9⟧"]').count())) throw new StepError("le marqueur d'un tiers (⟦IBAN-9⟧) a été démasqué");
    await shot(page, `redact-reply-${dev}`);

    // 3. Message tapé : proposé, pas imposé.
    await page.fill("#nk-composer", "rappelle le 022 345 67 89 demain");
    await page.locator('[data-redact-typed="ask"]').waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("pas de proposition de masquage sur le message tapé");
    });
    await shot(page, `redact-typed-${dev}`);
    await page.locator("[data-redact-mask]").click();
    await page.locator('[data-redact-typed="mask"]').waitFor({ timeout: STEP_MS });
    const n0 = bodies.length;
    await page.locator("#nk-composer").press("Enter");
    const end = Date.now() + STEP_MS;
    while (bodies.length === n0 && Date.now() < end) await page.waitForTimeout(100);
    const b2 = JSON.parse(bodies.at(-1));
    const said = JSON.stringify(b2.messages);
    if (!said.includes("⟦PHONE-1⟧") || said.includes("022 345")) throw new StepError(`message tapé envoyé : ${said}`);
    if (b2.redaction?.counts?.PHONE !== 1) throw new StepError(`compteurs du message : ${JSON.stringify(b2.redaction)}`);
    await until(page, "bulle de la personne démasquée", () => [...document.querySelectorAll(".msg.user .redact-unmasked")].some((e) => e.textContent === "022 345 67 89"));

    // 4. « Laisser » : rien n'est masqué ; aucune valeur dans un stockage web.
    await page.fill("#nk-composer", "écris à jean@example.ch");
    await page.locator("[data-redact-leave]").click();
    if (await page.locator("[data-redact-typed]").count()) throw new StepError("la proposition reste affichée après « Laisser »");
    const n1 = bodies.length;
    await page.locator("#nk-composer").press("Enter");
    const end2 = Date.now() + STEP_MS;
    while (bodies.length === n1 && Date.now() < end2) await page.waitForTimeout(100);
    const b3 = JSON.parse(bodies.at(-1));
    if (!JSON.stringify(b3.messages).includes("jean@example.ch") || b3.redaction) throw new StepError("« Laisser » a quand même masqué");
    const stored = await page.evaluate(() => [localStorage, sessionStorage].flatMap((st) => Object.keys(st).map((k) => st.getItem(k) ?? "")).join(" "));
    if (stored.includes("CH93") || stored.includes("022 345")) throw new StepError("une valeur masquée est dans un stockage web");
    const ow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (ow > 1) throw new StepError(`débordement horizontal ${ow}px`);
    if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
    report.push(`ok   redact ${dev}`);
  } catch (e) {
    failed++;
    report.push(`FAIL redact ${dev}: ${e.message}`);
    await shot(page, `FAIL-redact-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
