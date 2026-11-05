/**
 * Recette of the payment agent, issuer wise (core PAY-AGENT §10), in a real headless Chromium against the mock
 * (MOCK_PAYMENTS=1, MOCK_PAY_AGENT=wise), on `localhost`:
 *  - My account → « Link my Wise account »: the form is checked before sending, the account opens, « Continue the
 *    verification at Wise » comes back (Wise's page is not mocked), Wise says PASSED, the balance shows, « Activate
 *    with my passkey » waits for a passkey (a device signed in by mail code has none: said, button disabled);
 *  - « simule 3ds » in a chat: the « Confirm this payment » card shows on top with the BANK's details, the countdown,
 *    « Confirm with my passkey » (disabled without a passkey) and « Refuse »; refusing settles it.
 * Each journey runs at 1280 light EN, 390 dark EN, 390 light FR and 1280 dark FR. It fails on a step not reached, a page
 * error, a 5xx, an unexpected 4xx or a horizontal overflow.
 * Usage: `node e2e/pay-wise.mjs` (E2E_SHOTS=<dir> for screenshots, E2E_ONLY=<journey>).
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
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-wise-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_PAYMENTS: "1", MOCK_PAY_AGENT: "wise" };
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

async function link(page, s, dev) {
  await login(page, s.base);
  await themeOk(page, dev);
  await openAccount(page);
  const card = page.locator("[data-wise]"); // pas le squelette de chargement (data-pay-method seul)
  await card.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no Wise card in My account (mock MOCK_PAY_AGENT=wise?)");
  });
  if ((await card.getAttribute("data-wise")) !== "none") throw new StepError("a fresh account already has a Wise link");
  await card.scrollIntoViewIfNeeded();
  await shot(page, `${dev}-wise-none`);
  await card.getByRole("button", { name: fr(dev) ? /Lier mon compte Wise/ : /Link my Wise account/ }).click();
  await card.locator("#wise-first").fill("Alice");
  await card.locator("#wise-last").fill("Example");
  await card.locator("#wise-dob").fill("1990-01-31");
  await card.locator("#wise-email").fill("alice@example.com");
  await card.locator("#wise-phone").fill("079 000 00 00"); // national format: refused before sending
  await card.locator("#wise-line").fill("Rue Exemple 1");
  await card.locator("#wise-pc").fill("1200");
  await card.locator("#wise-city").fill("Genève");
  await noOverflow(page, "Wise form");
  await shot(page, `${dev}-wise-form`);
  await card.getByRole("button", { name: fr(dev) ? /Ouvrir mon compte Wise/ : /Open my Wise account/ }).click();
  await until(page, "phone refused before sending", () => /\+41/.test(document.querySelector("[data-wise] .error")?.textContent ?? ""));
  await card.locator("#wise-phone").fill("+41 79 000 00 00");
  await card.getByRole("button", { name: fr(dev) ? /Ouvrir mon compte Wise/ : /Open my Wise account/ }).click();
  await until(page, "account opened, Wise waits for the person", () => document.querySelector("[data-wise]")?.getAttribute("data-wise") === "WAITING_CUSTOMER_INPUT");
  await noOverflow(page, "Wise waiting");
  await shot(page, `${dev}-wise-waiting`);
  await card.getByRole("button", { name: fr(dev) ? /Continuer la vérification chez Wise/ : /Continue the verification at Wise/ }).click();
  // Back from Wise (mock: at once): the account view again, the note, then PASSED after Wise's check.
  await page.waitForURL(/wise=kyc/, { timeout: STEP_MS });
  await until(page, "back on the account view", () => !!document.querySelector("[data-wise]"));
  await until(page, "Wise says PASSED", () => document.querySelector("[data-wise]")?.getAttribute("data-wise") === "PASSED", undefined);
  await until(page, "balance shown", () => /(?:184\.50\s?CHF|CHF\s?184\.50)/.test(document.querySelector(".pay-balances")?.textContent ?? ""));
  const activate = page.locator("[data-wise]").getByRole("button", { name: fr(dev) ? /Activer avec ma passkey/ : /Activate with my passkey/ });
  if (!(await activate.isDisabled())) throw new StepError("activation possible without a passkey on this device");
  await page.locator("[data-wise]").scrollIntoViewIfNeeded();
  await noOverflow(page, "Wise verified");
  if (/Back from Wise|Retour de Wise/.test(await page.locator("[data-wise]").innerText())) throw new StepError("the « back from Wise » note stays after Wise said PASSED");
  await shot(page, `${dev}-wise-verified`);
}

async function threeds(page, s, dev) {
  await login(page, s.base);
  await themeOk(page, dev);
  await page.fill("#nk-composer", "simule 3ds");
  await page.click("button.send");
  const dock = page.locator(".pay-3ds-dock .pay-3ds");
  await dock.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « Confirm this payment » card");
  });
  await until(page, "the bank's details and countdown", () => {
    const t = document.querySelector(".pay-3ds-dock")?.textContent ?? "";
    return /(?:42\.90\s?CHF|CHF\s?42\.90)/.test(t) && /BOUTIQUE DU LAC/.test(t) && /shop\.example\.com/.test(t) && /\d:\d\d/.test(t);
  });
  const title = await page.locator(".pay-3ds-title").first().innerText();
  if (!(fr(dev) ? /Confirme ce paiement/ : /Confirm this payment/).test(title)) throw new StepError(`title « ${title} »`);
  const confirm = page.locator(".pay-3ds-dock").getByRole("button", { name: fr(dev) ? /Confirmer avec ma passkey/ : /Confirm with my passkey/ });
  if (!(await confirm.isDisabled())) throw new StepError("confirming possible without a passkey on this device");
  await noOverflow(page, "3DS card");
  await shot(page, `${dev}-3ds-card`);
  await page.locator(".pay-3ds-dock").getByRole("button", { name: fr(dev) ? /^Refuser$/ : /^Refuse$/ }).click();
  await until(page, "refused", () => document.querySelector(".pay-3ds")?.getAttribute("data-3ds") === "declined");
  await shot(page, `${dev}-3ds-refused`);
  await until(page, "the card leaves", () => !document.querySelector(".pay-3ds-dock"), undefined);
}

const JOURNEYS = [
  ["link", link],
  ["threeds", threeds],
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
