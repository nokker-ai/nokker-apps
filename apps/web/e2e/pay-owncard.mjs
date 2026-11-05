/**
 * Recette of « ta carte » (own_card, Lokkal, core PAY-AGENT §11), in a real headless Chromium against the mock
 * (MOCK_PAYMENTS=1, MOCK_PAY_AGENT=own_card), on `localhost` (secure context, rpId localhost):
 *  - My account: a REAL passkey of this machine (Chromium virtual authenticator, ES256, UV), the card typed in a
 *    password field (brand and last four only come back), the CVV mode, the advice;
 *  - « simule ta carte » in a chat: the banner asks the security code, then « Enter the code from your bank » with its
 *    countdown, then « paid »; « simule ta carte appli »: « Confirm in your bank's app ».
 * Each journey runs at 1280 light EN, 390 dark EN, 390 light FR and 1280 dark FR. It fails on a step not reached, a page
 * error, a 5xx, an unexpected 4xx or a horizontal overflow.
 * Usage: `node e2e/pay-owncard.mjs` (E2E_SHOTS=<dir> for screenshots, E2E_ONLY=<journey>).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const CODE = "123456"; // MOCK_EMAIL_CODE
// /v1/guide : le build de prod (E2E_PREVIEW=1) allume le guide, que le mock de cette recette ne sert pas (404).
const ALLOWED_4XX = [
  [404, /\/v1\/(guide|speech|account\/models|capabilities|packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|local\/folder\/runs|payments\/method\/balance)(\?|$)/],
  [401, /\/v1\/local\//], // as in the other journeys: a cloud session asks no local route
];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DEVICES = [
  ["desktop-light-en", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "en-US" }],
  ["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }],
  ["phone-light-fr", { ...PHONE, colorScheme: "light", locale: "fr-CH" }],
  ["desktop-dark-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "dark", locale: "fr-CH" }],
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
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} not reachable`);
}

/** A fresh mock per journey (the Wise account state is the mock's). */
async function servers() {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-owncard-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_PAYMENTS: "1", MOCK_PAY_AGENT: "own_card" };
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
        /* gone */
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
        return r.width > 0 && r.right > vw + 1 && !e.closest("pre, [style*='overflow']");
      })
      .slice(0, 3)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`);
    return { scroll: document.documentElement.scrollWidth - vw, wide };
  });
  if (o.scroll > 1 || o.wide.length) throw new StepError(`${where}: overflow of ${o.scroll}px (${o.wide.join(", ")})`);
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
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
}

async function openAccount(page) {
  const fab = page.locator(".drawer-fab");
  if (await fab.isVisible()) {
    // the account menu sits in the top bar on the phone too
  }
  await page.locator(".acct-btn").click();
  await page.locator('.menu-pop [data-view="account"]').click();
  await until(page, "account view", () => !!document.querySelector(".view.view-account"));
}

const fr = (dev) => dev.endsWith("-fr");

// ── journeys ──

async function themeOk(page, dev) {
  const th = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (dev.includes("dark") !== (th === "dark")) throw new StepError(`theme not applied (data-theme=${th})`);
}

async function virtualPasskey(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

async function account(page, s, dev) {
  await login(page, s.base);
  await themeOk(page, dev);
  await virtualPasskey(page);
  await openAccount(page);
  const card = page.locator("[data-owncard]");
  await card.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « your card » section in My account (mock MOCK_PAY_AGENT=own_card?)");
  });
  await card.scrollIntoViewIfNeeded();
  if (!/virtual card|carte virtuelle/i.test(await card.innerText())) throw new StepError("the « virtual card, low limit » advice is missing");
  await shot(page, `${dev}-own-empty`);
  await card.getByRole("button", { name: fr(dev) ? /Créer une passkey sur cette machine/ : /Create a passkey on this machine/ }).click();
  await until(page, "passkey created", () => document.querySelectorAll(".pay-passkeys li").length === 1);
  if ((await card.locator("#own-number").getAttribute("type")) !== "password") throw new StepError("the card number field is not a password field");
  await card.locator("#own-number").fill("4242 4242 4242 4241");
  await card.locator("#own-expiry").fill("12/31");
  await card.locator("#own-holder").fill("Alice Example");
  await card.getByRole("button", { name: fr(dev) ? /Enregistrer la carte sur cette machine/ : /Save the card on this machine/ }).click();
  await until(page, "wrong number refused before sending", () => /valid|valide/.test(document.querySelector("[data-owncard] .error")?.textContent ?? ""));
  await card.locator("#own-number").fill("4242 4242 4242 4242");
  await noOverflow(page, "card form");
  await shot(page, `${dev}-own-form`);
  await card.getByRole("button", { name: fr(dev) ? /Enregistrer la carte sur cette machine/ : /Save the card on this machine/ }).click();
  await until(page, "card saved, last four only", () => document.querySelector("[data-owncard]")?.getAttribute("data-owncard") === "saved" && /4242/.test(document.querySelector(".pay-method")?.textContent ?? ""));
  const html = await page.content();
  if (html.includes("4242424242424242") || html.includes("4242 4242 4242 4242")) throw new StepError("the full card number stays in the page");
  await noOverflow(page, "card saved");
  await shot(page, `${dev}-own-saved`);
}

async function prompts(page, s, dev) {
  await login(page, s.base);
  await themeOk(page, dev);
  await openAccount(page);
  const card = page.locator("[data-owncard]");
  await card.waitFor({ timeout: STEP_MS });
  await card.locator("#own-number").fill("4242 4242 4242 4242");
  await card.locator("#own-expiry").fill("12/31");
  await card.locator("#own-holder").fill("Alice Example");
  await card.getByRole("button", { name: fr(dev) ? /Enregistrer la carte sur cette machine/ : /Save the card on this machine/ }).click();
  await until(page, "card saved", () => document.querySelector("[data-owncard]")?.getAttribute("data-owncard") === "saved");
  await page.evaluate(() => localStorage.setItem("nokker.web.tab", JSON.stringify("chat")));  // back to the chat
  await page.goto(s.base);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.fill("#nk-composer", "simule ta carte");
  await page.click("button.send");
  const dock = page.locator(".pay-prompt-dock");
  await until(page, "the security code is asked", () => document.querySelector(".pay-prompt")?.getAttribute("data-prompt") === "cvv");
  await noOverflow(page, "cvv banner");
  await shot(page, `${dev}-prompt-cvv`);
  await dock.locator("input").fill("123");
  await dock.getByRole("button", { name: fr(dev) ? /Le donner à mon agent de paiement/ : /Give it to my payment agent/ }).click();
  await until(page, "the bank's code is asked", () => document.querySelector(".pay-prompt")?.getAttribute("data-prompt") === "otp", undefined);
  // One line per payment: the security code given, its toast is gone (replaced by the bank's code one).
  const toasts = await page.locator(".toast").allInnerTexts();
  if (toasts.some((x) => /security code|code de sécurité/i.test(x))) throw new StepError(`a request already answered stays on screen: « ${toasts.join(" | ")} »`);
  const t = await dock.innerText();
  if (!(fr(dev) ? /Entre le code reçu de ta banque/ : /Enter the code from your bank/).test(t) || !/\d:\d\d/.test(t)) throw new StepError(`otp banner: « ${t.slice(0, 120)} »`);
  if ((await dock.locator("input").getAttribute("autocomplete")) !== "one-time-code") throw new StepError("the bank code field is not one-time-code");
  await noOverflow(page, "otp banner");
  await shot(page, `${dev}-prompt-otp`);
  await dock.locator("input").fill("123456");
  await dock.getByRole("button", { name: fr(dev) ? /Le donner à mon agent de paiement/ : /Give it to my payment agent/ }).click();
  await until(page, "paid", () => [...document.querySelectorAll(".toast")].some((x) => /paid with your card|payé avec ta carte/i.test(x.textContent ?? "")));
  await until(page, "the banner leaves", () => !document.querySelector(".pay-prompt-dock"));
  if ((await page.locator(".toast").allInnerTexts()).some((x) => /code reçu|code from your bank/i.test(x))) throw new StepError("the bank's code request stays on screen after the payment");
  const chat = await page.locator("main, .chat, body").first().innerText();
  if (/123456/.test(chat)) throw new StepError("the bank's code appears on the page after the payment");
  await page.fill("#nk-composer", "simule ta carte appli");
  await page.click("button.send");
  await until(page, "confirm in the bank's app", () => document.querySelector(".pay-prompt")?.getAttribute("data-prompt") === "bank_app");
  if (await dock.locator("input").count()) throw new StepError("a field on the « confirm in your bank's app » banner");
  await shot(page, `${dev}-prompt-app`);
}

const JOURNEYS = [
  ["account", account],
  ["prompts", prompts],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const report = [];
let failed = 0;
for (const [name, fn] of JOURNEYS) {
  if (process.env.E2E_ONLY && process.env.E2E_ONLY !== name) continue;
  for (const [dev, opts] of DEVICES) {
    const s = await servers();
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    // The app follows its own theme setting (stored), not the system's: set it like the other journeys do.
    if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
    const problems = [];
    watch(page, problems);
    const t0 = Date.now();
    try {
      await fn(page, s, dev);
      if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
      report.push(`ok   ${name} ${dev} ${Date.now() - t0} ms`);
    } catch (e) {
      failed++;
      report.push(`FAIL ${name} ${dev}: ${e.message}`);
      await shot(page, `FAIL-${name}-${dev}`).catch(() => {});
    } finally {
      await ctx.close();
      s.stop();
    }
  }
}
await browser.close();
console.log(report.join("\n"));
console.log(`${report.length - failed}/${report.length}`);
process.exit(failed ? 1 : 0);
