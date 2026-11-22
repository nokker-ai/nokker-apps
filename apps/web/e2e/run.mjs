#!/usr/bin/env node
/**
 * End-to-end journeys of the web app, in a real (headless) Chromium, against the mock server.
 *
 *   pnpm --filter @nokker-apps/web e2e                 # starts its own mock + vite on free ports
 *   E2E_BASE_URL=http://localhost:5173 pnpm … e2e      # reuses a running vite (proxying a running mock)
 *   E2E_PREVIEW=1                                      # production build served by `vite preview` (load timings that mean something)
 *   E2E_ONLY=desktop|mobile  E2E_HEADED=1  E2E_SHOTS=<dir>
 *
 * Each journey runs in a fresh browser context (empty storage), on a desktop viewport and on a phone viewport
 * (touch, 390 px). A journey fails on: a step that does not reach its expected state, an uncaught page error,
 * a 5xx response, an unexpected 4xx, or an element wider than the viewport (horizontal overflow).
 * Feature probes that answer 404 by design (flags off) and the local-only routes (401 outside Lokkal) are allowed.
 *
 * Browsers: `playwright-core` downloads none; run `npx playwright-core install chromium` once if needed.
 */
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { chromium } from "playwright-core";
import { cspWatch, webCommand } from "./web-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const MOCK = resolve(WEB, "../../packages/mock-server");
const EMAIL = "alice@example.com";
const CODE = "123456"; // MOCK_EMAIL_CODE
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 15000);
const PREVIEW = process.env.E2E_PREVIEW === "1";
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : null;

/** 4xx that are part of the contract: feature probes off by default, local-only routes outside Lokkal. */
const ALLOWED_4XX = [
  [404, /\/v1\/(speech|billing\/voucher|account\/models|capabilities|local\/sites|packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|memory\/long|payments\/budgets|payments\/mandates|payments\/method|local\/folder\/runs)(\?|$)/],
  [401, /\/v1\/local\//],
  // « Ta carte » journey: approving before the machine has a passkey (the card says to create one).
  [412, /\/v1\/local\/approvals\/[^/]+\/challenge$/],
  // Models journey: a private address refused by the server (blocked_address).
  [400, /\/v1\/account\/models\/test$/],
  // ACCORD journey: a wrong code (400), a closed window (409) and a blocked pairing (423) are the states to show.
  [400, /\/v1\/local\/accord\/pair$/],
  [409, /\/v1\/local\/accord\/pair$/],
  [423, /\/v1\/local\/accord\/pair(\/open)?$/],
  // Session-code journey: reusing a one-time link is the state to show (410 code_used).
  [410, /\/v1\/local\/session-code\/exchange$/],
];

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};
const SMALL_PHONE = { ...PHONE, viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
/** Display glasses: a small square see-through screen, no touch from the page's point of view. */
const GLASSES = { viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 };

// ---------- servers ----------

function freePort() {
  return new Promise((ok, ko) => {
    const s = createServer();
    s.once("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`not reachable: ${url}`);
}

async function startServers() {
  const mockPort = Number(process.env.E2E_MOCK_PORT) || (await freePort());
  const webPort = Number(process.env.E2E_WEB_PORT) || (await freePort());
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-"));
  const work = join(cfg, "work");
  mkdirSync(join(work, "proj"), { recursive: true });
  // Folder mode: a folder of files to sort (the mock only lists it, never writes).
  mkdirSync(join(work, "photos"), { recursive: true });
  for (const f of ["a.jpg", "b.jpg", "notes.txt"]) writeFileSync(join(work, "photos", f), "x");
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_LOCAL_ROOTS: work, MOCK_CAST: "1", MOCK_HOUSE_ROOM: "1", MOCK_WHO_DOES_WHAT: "1", MOCK_CONSOLIDATION: "1", MOCK_PAYMENTS: "1", MOCK_APPROVAL_BUBBLES: "1", MOCK_TTS: "1", MOCK_FOLDER: "1", MOCK_SHOW_ME: "1", MOCK_GUIDE: "1", MOCK_CLOUD_BYOK: "open", MOCK_ACCORD: "1" };
  // E2E_PREVIEW=1 : build (VITE_NOKKER_SHOW_ME / VITE_NOKKER_GUIDE allumés) puis `vite preview`, voir web-server.mjs.
  const procs = [
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("npx", [...webCommand(), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], {
      cwd: WEB,
      // « Show me » is a build flag (VITE_NOKKER_SHOW_ME), off by default: on here so its journey runs.
      env: { ...process.env, NOKKER_SERVER_URL: `http://127.0.0.1:${mockPort}`, VITE_NOKKER_SHOW_ME: process.env.VITE_NOKKER_SHOW_ME ?? "1", VITE_NOKKER_GUIDE: process.env.VITE_NOKKER_GUIDE ?? "1", VITE_NOKKER_KIOSK: process.env.VITE_NOKKER_KIOSK ?? "1" },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    }),
  ];
  const stop = () => {
    for (const p of procs) {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    rmSync(cfg, { recursive: true, force: true });
  };
  process.on("exit", stop);
  await waitHttp(`http://127.0.0.1:${mockPort}/v1/health`).catch(() => waitHttp(`http://127.0.0.1:${mockPort}/`));
  // `localhost` (not 127.0.0.1): a secure context, so WebCrypto device keys work.
  const base = `http://localhost:${webPort}`;
  await waitHttp(base);
  const local = { token: readFileSync(join(cfg, "local-token"), "utf8").trim(), cwd: join(work, "proj"), folder: join(work, "photos"), api: `http://127.0.0.1:${mockPort}` };
  return { base, stop, local };
}

// ---------- harness ----------

class StepError extends Error {}

function watch(page, problems) {
  cspWatch(page, () => page.url().replace(/^https?:\/\/[^/]+/, ""));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    const s = r.status();
    if (s < 400) return;
    const url = r.url();
    if (s < 500 && ALLOWED_4XX.some(([code, re]) => code === s && re.test(url))) return;
    if (s === 401 && /\/v1\/auth\/email\/verify$/.test(url)) return; // wrong-code journeys
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

const SIDE_SCROLLERS = ".lrn-tabs, .chip-row, pre, .md-table, .log, .run-list, .artifact-code, .hh-attest-text, [data-scroll-x]";

/** Elements that stick out of the viewport or scroll sideways (ignores intentionally scrollable code blocks/tables). */
async function overflow(page) {
  return page.evaluate((SIDE_SCROLLERS) => {
    const W = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > W + 1) out.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
      if (el.closest(".drawer, [inert]")) continue; // the off-screen session drawer
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Intentional sideways scrollers (tab strip, chip row, code, tables, logs): the scroller itself is what is checked.
      // A generic “any clipping ancestor” rule would hide real bugs, since layout containers clip too.
      if (el.parentElement?.closest(SIDE_SCROLLERS)) continue;
      const scrollsX = el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(cs.overflowX);
      if (r.right > W + 1 && !scrollsX) {
        const id = el.id ? `#${el.id}` : "";
        const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
        out.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(r.right)} > ${W}`);
      }
    }
    return out.slice(0, 8);
  }, SIDE_SCROLLERS);
}

/** Phone (≤ 430 px wide): Safari iOS zooms the page on focus of any field whose computed font-size is under 16 px. */
async function smallFields(page) {
  return page.evaluate(() => {
    const skip = /^(hidden|checkbox|radio|range|file|color|button|submit|reset|image)$/;
    const out = [];
    for (const el of document.querySelectorAll("input,textarea,select,[contenteditable]:not([contenteditable=false])")) {
      if (el.tagName === "INPUT" && skip.test(el.type)) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
      const px = parseFloat(cs.fontSize);
      if (px < 16) out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : "." + String(el.className).trim().split(/\s+/)[0]} ${px}px`);
    }
    return [...new Set(out)].slice(0, 6);
  });
}

async function noOverflow(page, where) {
  const o = await overflow(page);
  if (o.length) throw new StepError(`horizontal overflow on ${where}: ${o.join(" | ")}`);
  if ((page.viewportSize()?.width ?? 9999) <= 430) {
    const small = await smallFields(page);
    if (small.length) throw new StepError(`field under 16px on ${where} (iOS zooms on focus): ${small.join(" | ")}`);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// ---------- steps ----------

async function login(page, base, timings) {
  const t0 = Date.now();
  await page.goto(base);
  await page.waitForSelector("#wl-email", { timeout: STEP_MS });
  timings.loginScreenMs = Date.now() - t0;
  Object.assign(
    timings,
    await page.evaluate(() => {
      const res = performance.getEntriesByType("resource");
      const kb = (f) => Math.round(res.filter(f).reduce((n, r) => n + (r.encodedBodySize || 0), 0) / 1024);
      return { jsKB: kb((r) => r.initiatorType === "script" || /\.m?[jt]sx?(\?|$)/.test(r.name)), cssKB: kb((r) => /\.css(\?|$)/.test(r.name)), requests: res.length };
    }),
  );
  await page.fill("#wl-email", EMAIL);
  await page.click("form button[type=submit]");
  await page.waitForSelector("#wl-code", { timeout: STEP_MS });
  await page.fill("#wl-code", "000000");
  await page.keyboard.press("Enter");
  // Wait for the refusal itself (alert shown, form free again): typing the right code while the wrong one is still being
  // checked was ignored by the busy form — the intermittent « composer after the code » stall.
  await until(page, "wrong code is refused with a visible message", () => !!document.querySelector("#wl-code") && /code/i.test(document.querySelector(".ob-error[role=alert]")?.textContent ?? "") && !document.querySelector("form button[type=submit][disabled]") && !document.querySelector("#nk-composer"));
  await page.fill("#wl-code", CODE);
  const t1 = Date.now();
  await page.keyboard.press("Enter");
  // Requests still open when the chat does not come: an intermittent 15 s stall here was seen only in full runs.
  const open = new Map();
  const onReq = (r) => open.set(r, `${r.method()} ${new URL(r.url()).pathname}`);
  const onDone = (r) => open.delete(r.request ? r.request() : r);
  page.on("request", onReq);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  try {
    await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  } catch {
    const screen = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 160)).catch(() => "?");
    const pending = [...new Set(open.values())].filter((u) => !/\/v1\/events/.test(u)).slice(0, 6);
    throw new StepError(`timeout: composer after the code — screen: « ${screen} » — still open: ${pending.join(", ") || "none"}`);
  } finally {
    page.off("request", onReq);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
  timings.codeToChatMs = Date.now() - t1;
  const lang = await page.evaluate(() => document.documentElement.lang);
  const want = (await page.evaluate(() => navigator.language)).slice(0, 2);
  if (lang !== want) throw new StepError(`<html lang="${lang}"> on a “${want}” interface`);
}

/** Sends `text` in the current thread and waits for the turn to end: the reply is rendered and a new draft can be sent. */
async function send(page, text, expectInReply) {
  const before = await page.$$eval(".msg.user", (els) => els.length);
  const repliesBefore = await page.$$eval(".msg.nina .msg-body", (els) => els.length);
  await page.fill("#nk-composer", text);
  await page.click("button.send");
  await until(page, "own message shown", (n) => document.querySelectorAll(".msg.user").length > n, before);
  await until(
    page,
    `reply contains “${expectInReply}”`,
    ([n, want]) => {
      const all = document.querySelectorAll(".msg.nina .msg-body");
      return all.length > n && all[all.length - 1].innerText.includes(want);
    },
    [repliesBefore, expectInReply],
  );
  await page.fill("#nk-composer", "next");
  await until(page, "send button free again after the turn", () => !document.querySelector("button.send")?.disabled);
  await page.fill("#nk-composer", "");
}

/** Every journey talks in sessions of its own: journeys share the mock account, and a turn still running in a
 * shared thread (a scripted demo turn) would hold the next journey's send. Also covers session creation. */
async function newSession(page, name) {
  const fab = page.locator(".drawer-fab");
  if (await fab.isVisible()) {
    await fab.click();
    await until(page, "drawer opens", () => document.querySelector(".app")?.classList.contains("drawer-open"));
  }
  await page.locator(".drawer-head button.icon-btn").click();
  const choose = page.locator(".drawer-choose button").first();
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.fill("#nk-new-session", name);
  await page.keyboard.press("Enter");
  await until(page, `session “${name}” is current`, (n) => document.querySelector("button.session-row.current")?.textContent?.includes(n), name);
  // On the phone, creating a session closes the drawer (like picking one); Escape is a no-op otherwise.
  if (await fab.isVisible()) await page.keyboard.press("Escape");
}

const tag = () => Math.random().toString(36).slice(2, 7);
const row = (page, name) => page.locator("button.session-row", { hasText: name });

/** Opens a view the way a user does: work views from the drawer (opened by its button on the phone), account and
 * settings from the account menu. */
async function openView(page, id) {
  const fab = page.locator(".drawer-fab");
  const phone = await fab.isVisible();
  if (phone) {
    await fab.click();
    await until(page, "drawer opens", () => document.querySelector(".app")?.classList.contains("drawer-open"));
  }
  const place = page.locator(`.drawer-places [data-view="${id}"]`);
  if (await place.count()) {
    await place.click();
  } else {
    if (phone) {
      await page.keyboard.press("Escape");
      await until(page, "drawer closes", () => !document.querySelector(".app")?.classList.contains("drawer-open"));
    }
    await page.locator(".acct-btn").click();
    await page.locator(`.menu-pop [data-view="${id}"]`).click();
  }
  await until(page, `view ${id} shown`, (v) => !!document.querySelector(`.view.view-${v}`), id);
  if (phone) await until(page, "drawer closed after picking a view", () => !document.querySelector(".app")?.classList.contains("drawer-open"));
}

/** Every view reachable from the drawer and the account menu, without horizontal overflow; then back to the chat. */
/** Phone: at the end of the scroll nothing (text or control) may sit under the round menu button (☰). */
async function fabClear(page, where) {
  const bad = await page.evaluate(() => {
    const fab = document.querySelector(".drawer-fab");
    if (!fab || !fab.getBoundingClientRect().width) return [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
    }
    const f = fab.getBoundingClientRect();
    const hit = (r) => r.width > 0 && r.height > 0 && r.left < f.right && r.right > f.left && r.top < f.bottom && r.bottom > f.top;
    const shown = (el) => {
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden" && !el.closest("[inert],.toasts,.drawer-fab");
    };
    const out = [];
    for (const el of document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab]")) {
      if (el === fab || !shown(el)) continue;
      if (hit(el.getBoundingClientRect())) out.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0]} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`);
    }
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = (n.textContent ?? "").trim();
      if (!t || !n.parentElement || !shown(n.parentElement) || n.parentElement.closest("script,style")) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      if ([...rg.getClientRects()].some(hit)) out.push(`text "${t.slice(0, 24)}"`);
    }
    return [...new Set(out)].slice(0, 6);
  });
  if (bad.length) throw new StepError(`${where}: under the menu button at the end of the scroll: ${bad.join(" | ")}`);
}

async function views(page, where) {
  const ids = await page.evaluate(async () => {
    const work = [...document.querySelectorAll(".drawer-places .place")].map((e) => e.dataset.view);
    document.querySelector(".acct-btn").click();
    await new Promise((r) => setTimeout(r, 50));
    const settings = [...document.querySelectorAll(".menu-pop .menu-item[data-view]")].map((e) => e.dataset.view);
    document.querySelector(".acct-btn").click();
    return [...work, ...settings];
  });
  if (ids.length < 3) throw new StepError(`only ${ids.length} views`);
  for (const id of ids) {
    await openView(page, id);
    await page.waitForTimeout(400);
    await noOverflow(page, `${where} / view ${id}`);
    await shot(page, `${where}-view-${id}`);
    await fabClear(page, `${where} / view ${id}`);
    await shot(page, `${where}-view-${id}-end`);
  }
  await page.locator(".back-chat").click();
  await until(page, "back to the chat", () => !!document.querySelector(".view.view-chat #nk-composer"));
  return ids;
}

async function signOut(page) {
  await openView(page, "account").catch(() => {
    throw new StepError("no account view");
  });
  const btn = page.locator("#acc-signout ~ button");
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: STEP_MS }).catch(() => {
    throw new StepError("sign-out button not reachable");
  });
  await page.waitForSelector("#wl-email", { timeout: STEP_MS }).catch(() => {
    throw new StepError("not back on the sign-in screen after sign-out");
  });
  await page.reload();
  await page.waitForSelector("#wl-email", { timeout: STEP_MS }).catch(() => {
    throw new StepError("signed in again after reload: the device was not forgotten");
  });
}

// ---------- journeys ----------

const LONG_WORD = "x".repeat(320);
const MULTILINE = "| a | b |\n|---|---|\n| 1 | 2 |";

async function desktop(page, base, t) {
  await login(page, base, t);
  const a = `e2e A ${tag()}`;
  const b = `e2e B ${tag()}`;
  await newSession(page, b);
  await newSession(page, a);
  await noOverflow(page, "desktop chat");
  const t0 = Date.now();
  await send(page, "hello from the journey", "hello from the journey");
  t.firstTurnMs = Date.now() - t0;
  await send(page, `long ${LONG_WORD}`, ""); // the mock may answer with a scripted demo line: any new reply ends the turn
  await noOverflow(page, "desktop chat after a long word");

  // A turn keeps running in its own thread while another thread is used.
  await page.fill("#nk-composer", "switch while sending");
  await page.click("button.send");
  await row(page, b).click();
  await page.fill("#nk-composer", "draft in another thread");
  await until(page, "other thread can send while the first one is busy", () => !document.querySelector("button.send")?.disabled);
  await page.fill("#nk-composer", "");
  await row(page, a).click();
  await until(page, "reply landed in the first thread", () => document.body.innerText.includes("switch while sending") && document.querySelectorAll(".msg.nina").length > 0);

  // A send that fails gives the message back to the composer and says why without a route or a status line.
  await page.route("**/v1/chat/completions", (r) => r.abort("internetdisconnected"));
  await page.fill("#nk-composer", "lost in the network");
  await page.click("button.send");
  await until(page, "failed message is back in the composer", () => document.querySelector("#nk-composer")?.value === "lost in the network");
  await until(page, "the failure is explained", () => [...document.querySelectorAll(".toasts > *")].some((t) => /connection/i.test(t.textContent ?? "") && !/\/v1\//.test(t.textContent ?? "")));
  await page.unroute("**/v1/chat/completions");
  await page.fill("#nk-composer", "");

  await views(page, "desktop");
  await shot(page, "desktop-chat");
  await signOut(page);
}

async function phone(page, base, t) {
  await login(page, base, t);
  const a = `e2e A ${tag()}`;
  const b = `e2e B ${tag()}`;
  await newSession(page, b);
  await newSession(page, a);
  await noOverflow(page, "phone chat");

  // Session drawer: off-screen, opened by the bottom-left button, closed by Escape and by the scrim.
  const fab = page.locator(".drawer-fab");
  await fab.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no drawer button on the phone");
  });
  await fab.click();
  await until(page, "drawer opens", () => document.querySelector(".app")?.classList.contains("drawer-open"));
  await shot(page, "phone-drawer");
  await page.keyboard.press("Escape");
  await until(page, "Escape closes the drawer", () => !document.querySelector(".app")?.classList.contains("drawer-open"));
  await fab.click();
  await page.mouse.click(page.viewportSize().width - 12, 400); // on the scrim, right of the drawer
  await until(page, "scrim closes the drawer", () => !document.querySelector(".app")?.classList.contains("drawer-open"));
  await fab.click();
  await row(page, b).click();
  await until(page, "picking a session closes the drawer", () => !document.querySelector(".app")?.classList.contains("drawer-open"));

  await send(page, `long ${LONG_WORD}`, ""); // the mock may answer with a scripted demo line: any new reply ends the turn
  await send(page, MULTILINE, "");
  await noOverflow(page, "phone chat after long content");

  // Bubble strip: folds while reading, unfolds on tap.
  // “disk” is a scripted demo turn that keeps measuring for a while: wait for its bubble, not for the end of the turn.
  await page.fill("#nk-composer", "disk");
  await page.click("button.send");
  await until(page, "a bubble shows up", () => !!document.querySelector(".bubble-inline, .bubble-fold"));
  const scroller = page.locator(".chat-scroll");
  await scroller.hover().catch(() => {});
  // A bubble arriving meanwhile unfolds the strip on its own (the account is shared by the journeys): fold again, retry.
  for (let i = 0; ; i++) {
    await page.mouse.wheel(0, -400);
    await until(page, "bubble strip folds when the chat scrolls", () => !!document.querySelector(".bubble-fold"));
    if (i === 0) await shot(page, "phone-bubbles-folded");
    const tapped = await page
      .locator(".bubble-fold")
      .click({ timeout: 3000 })
      .then(() => true, () => false);
    if (tapped) break;
    if (i === 2) throw new StepError("the folded bubble strip never stays long enough to be tapped");
  }
  await until(page, "bubble strip unfolds on tap", () => !document.querySelector(".bubble-fold"));

  await views(page, "phone");
  await signOut(page);
}

async function phoneFr(page, base, t) {
  await login(page, base, t);
  await until(page, "French interface", () => /Envoyer|Dis quelque chose/.test(document.body.innerHTML));
  await noOverflow(page, "phone fr chat");
  await views(page, "phone-fr");
}

/** Lokkal (local token): a local session in plan mode refuses the write, then “Apply the plan” lifts plan mode and asks
 * for the work. Needs the mock's local token (self-started servers, or E2E_LOCAL_TOKEN + E2E_LOCAL_CWD + E2E_API_URL). */
async function modes(page, base, t, local) {
  if (!local) return void (t.skipped = "no local token");
  const r = await fetch(`${local.api}/v1/local/sessions`, { method: "POST", headers: { Authorization: `Bearer ${local.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ cwd: local.cwd }) });
  if (r.status !== 201) throw new StepError(`local session: HTTP ${r.status}`);
  const { thread_id } = await r.json();
  await page.goto(`${base}/#token=${local.token}`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.locator(`button.session-row`, { hasText: "proj" }).last().click();
  await page.waitForSelector("#nk-session-mode", { timeout: STEP_MS }).catch(() => {
    throw new StepError("no mode bar on a local session");
  });
  await page.selectOption("#nk-session-mode", "plan");
  await until(page, "mode is plan", () => document.querySelector(".mode-bar")?.classList.contains("is-plan"));
  const m = await (await fetch(`${local.api}/v1/local/sessions/${thread_id}/mode`, { headers: { Authorization: `Bearer ${local.token}` } })).json();
  if (m.mode !== "plan") throw new StepError(`core still in ${m.mode}`);
  await page.waitForSelector(".mode-plan li", { timeout: STEP_MS }).catch(() => {
    throw new StepError("plan not shown");
  });
  await page.fill("#nk-composer", "fix the add test");
  await page.click("button.send");
  await page.waitForSelector(".mode-refused", { timeout: STEP_MS }).catch(() => {
    throw new StepError("plan-mode refusal not shown");
  });
  await noOverflow(page, "modes");
  await shot(page, "modes-plan");
  // The refusal shows while the first turn is still streaming: a click now would start the next turn (and the page's
  // own tools/call) on a busy thread, which the mock rightly answers with 409. Wait for the turn to be over first.
  await until(page, "the first turn is over", () => !!document.querySelector(".topbar") && !document.querySelector(".topbar.working"));
  const users = await page.$$eval(".msg.user", (els) => els.length);
  await page.click(".mode-apply");
  await until(page, "plan mode lifted", () => !document.querySelector(".mode-bar")?.classList.contains("is-plan"));
  await until(page, "the plan is asked for", (n) => document.querySelectorAll(".msg.user").length > n, users);
  // Leave the local session at rest: the next journey opens the latest local thread, and a turn still running there
  // answers its first calls with 409 (turn_running).
  await until(page, "the turn is over", () => !!document.querySelector(".topbar") && !document.querySelector(".topbar.working"));
}

/** « Apply the plan » clicked WHILE the turn still streams must not start a second turn (the core answers 409): the
 * button waits for the end of the turn. Needs a turn that stays open after the refusal shows: run with
 * MOCK_CHAT_TAIL_MS=2000 (E2E_ONLY=modes-busy); skipped otherwise. */
async function modesBusy(page, base, t, local) {
  if (!local) return void (t.skipped = "no local token");
  if (!Number(process.env.MOCK_CHAT_TAIL_MS)) return void (t.skipped = "needs MOCK_CHAT_TAIL_MS (a turn that stays open)");
  const r = await fetch(`${local.api}/v1/local/sessions`, { method: "POST", headers: { Authorization: `Bearer ${local.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ cwd: local.cwd }) });
  if (r.status !== 201) throw new StepError(`local session: HTTP ${r.status}`);
  await page.goto(`${base}/#token=${local.token}`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.locator(`button.session-row`, { hasText: "proj" }).last().click();
  await page.waitForSelector("#nk-session-mode", { timeout: STEP_MS });
  await page.selectOption("#nk-session-mode", "plan");
  await until(page, "mode is plan", () => document.querySelector(".mode-bar")?.classList.contains("is-plan"));
  await page.fill("#nk-composer", "fix the add test");
  await page.click("button.send");
  await page.waitForSelector(".mode-refused", { timeout: STEP_MS });
  if (!(await page.$(".topbar.working"))) throw new StepError("the turn was already over: nothing to test (raise MOCK_CHAT_TAIL_MS)");
  const users = await page.$$eval(".msg.user", (els) => els.length);
  if (!(await page.locator(".mode-apply").isDisabled())) throw new StepError("« Apply the plan » is clickable while the turn runs");
  await page.locator(".mode-apply").click({ force: true, timeout: 1000 }).catch(() => undefined);
  if ((await page.$$eval(".msg.user", (els) => els.length)) !== users) throw new StepError("a second turn started during the first");
  await shot(page, "modes-busy");
  await until(page, "the turn is over", () => !!document.querySelector(".topbar") && !document.querySelector(".topbar.working"));
  await until(page, "the button is enabled again", () => !document.querySelector(".mode-apply")?.disabled);
  await page.click(".mode-apply");
  await until(page, "plan mode lifted", () => !document.querySelector(".mode-bar")?.classList.contains("is-plan"));
  await until(page, "the plan is asked for", (n) => document.querySelectorAll(".msg.user").length > n, users);
  await until(page, "the second turn is over", () => !!document.querySelector(".topbar") && !document.querySelector(".topbar.working"));
}

/** The palette leads to the settings: « régl » proposes My account, and a sub-section (« régl appar ») opens the account
 * view scrolled to it. */
async function paletteSettings(page, base, t) {
  await login(page, base, t);
  await page.focus("#nk-composer");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette input", { timeout: STEP_MS });
  await page.keyboard.type("régl");
  await until(page, "« régl » proposes My account", () => [...document.querySelectorAll(".palette-item")].some((e) => /Mon compte|My account/i.test(e.textContent ?? "")));
  const labels = await page.$$eval(".palette-item", (els) => els.map((e) => e.textContent ?? ""));
  if (labels.some((l) => /Nouvelle session|New session/i.test(l) && labels.length === 1)) throw new StepError("« régl » only offers a new session");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("régl devices");
  await until(page, "« régl devices » proposes the Devices section", () => [...document.querySelectorAll(".palette-item")].some((e) => /›\s*(Appareils|Devices)/i.test(e.textContent ?? "")));
  await page.keyboard.press("Enter");
  await until(page, "the account view opens on Devices", () => {
    const el = document.getElementById("acc-devices");
    if (!el || !document.querySelector("[data-account-tab]")) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  });
  await shot(page, "palette-settings");
}

/** Chat-first shell: no tab strip, a short top bar, the command palette and the account menu work from the keyboard,
 * the focus comes back where it was, and the view chosen survives a reload. */
async function navigation(page, base, t) {
  await login(page, base, t);
  const bar = await page.evaluate(() => {
    const tb = document.querySelector(".topbar");
    const shown = [...tb.querySelectorAll("button, a, select, input")].filter((e) => e.getBoundingClientRect().width > 0);
    return { h: Math.round(tb.getBoundingClientRect().height), controls: shown.length, names: shown.map((e) => e.className.split(" ")[0] || e.tagName), tabs: document.querySelectorAll("[role=tab], .tab-main").length };
  });
  t.topbar = bar;
  if (bar.tabs) throw new StepError(`${bar.tabs} tab(s) still in the shell`);
  if (bar.controls > 3) throw new StepError(`${bar.controls} controls in the top bar on the chat (max 3): ${bar.names.join(", ")}`);
  if (bar.h > 72) throw new StepError(`top bar ${bar.h}px high`);

  // Palette: Ctrl+K from the message field, type, Enter → the view; Escape closes and gives the focus back.
  await page.focus("#nk-composer");
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette input", { timeout: STEP_MS });
  await until(page, "palette field focused", () => document.activeElement?.matches(".palette input"));
  await page.keyboard.press("Escape");
  await until(page, "Escape closes the palette, focus back in the message field", () => !document.querySelector(".palette") && document.activeElement?.id === "nk-composer");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("crew");
  await until(page, "Crew is the first result", () => /crew/i.test(document.querySelector(".palette-item.on")?.textContent ?? ""));
  await shot(page, "navigation-palette");
  await page.keyboard.press("Enter");
  await until(page, "palette opens Crew", () => !!document.querySelector(".view.view-crew") && !document.querySelector(".palette"));
  await page.reload();
  await until(page, "the view survives a reload", () => !!document.querySelector(".view.view-crew"));

  // Palette creates a session from what was typed.
  const name = `e2e nav ${tag()}`;
  await page.keyboard.press("Control+k");
  await page.keyboard.type(name);
  await page.keyboard.press("ArrowUp"); // wraps to the last line: “New session …”
  await until(page, "new-session action selected", (n) => (document.querySelector(".palette-item.on")?.textContent ?? "").includes(n), name);
  await page.keyboard.press("Enter");
  await until(page, "palette created and opened the session", (n) => !!document.querySelector(".view.view-chat") && (document.querySelector(".topbar-title")?.textContent ?? "").includes(n), name);

  // Account menu from the keyboard: Enter opens on the first item, arrows move, Escape closes back on the button.
  await page.focus(".acct-btn");
  await page.keyboard.press("Enter");
  await until(page, "menu open on its first item", () => document.activeElement?.classList.contains("menu-item"));
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await until(page, "Home goes to the first item", () => document.activeElement === document.querySelector(".menu-pop .menu-item"));
  await page.keyboard.press("Escape");
  await until(page, "Escape closes the menu, focus on its button", () => !document.querySelector(".menu-pop") && document.activeElement?.classList.contains("acct-btn"));
  // Theme switch from the menu.
  await page.locator(".acct-btn").click();
  await page.locator(".menu-pop .menu-item[aria-pressed]").first().click();
  await until(page, "dark theme on", () => document.documentElement.getAttribute("data-theme") === "dark");
  await noOverflow(page, "navigation menu");
  await shot(page, "navigation-menu-dark");
  await page.keyboard.press("Escape");

  // Every view reachable, then back to the chat.
  t.views = (await views(page, "navigation")).length;
}

/** Dev server only: import every source module once in a throwaway page, so that Vite has transformed them and
 * optimised every dependency BEFORE the first journey (otherwise the first lazy tab can trigger a dependency
 * re-optimisation and a reload mid-journey: « Failed to fetch dynamically imported module »). Not a retry: the
 * journeys then run against a server that has nothing left to discover. */
async function warmUp(browser, base) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push("/" + relative(WEB, f).split(sep).join("/"));
    }
  };
  walk(join(WEB, "src"));
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  const failed = await page.evaluate(async (urls) => {
    const bad = [];
    for (const u of urls) await import(/* @vite-ignore */ u).catch((e) => bad.push(`${u}: ${String(e).slice(0, 80)}`));
    return bad;
  }, files);
  // A dependency found late makes Vite reload this page: wait until it is quiet again, then check every module loads.
  await page.waitForLoadState("networkidle").catch(() => {});
  const again = failed.length ? await page.evaluate(async (urls) => {
    const bad = [];
    for (const u of urls) await import(/* @vite-ignore */ u).catch((e) => bad.push(`${u}: ${String(e).slice(0, 80)}`));
    return bad;
  }, failed.map((f) => f.split(":")[0])) : [];
  await ctx.close();
  if (again.length) throw new Error(`warm-up: modules still failing after Vite settled: ${again.join(" | ")}`);
}

/** /glance (display glasses): summary, brief and waiting cards, one page at a time, large type, keys to move. */
async function glance(page, base, t) {
  await login(page, base, t);
  // A brief that has run, and a strong card that waits (the demo disk bubble proposes a purge).
  await page.click(".drawer-fab");
  await page.locator('.drawer-places [data-view="plan"]').click();
  const brief = page.locator(".plan-brief-toggle input");
  if (!(await brief.isChecked())) {
    await brief.click();
    await until(page, "brief armed", () => !!document.querySelector(".plan-brief-toggle input")?.checked);
  }
  await page.click(".drawer-fab");
  await row(page, "Infra").first().click();
  await page.waitForSelector("#nk-composer");
  await page.fill("#nk-composer", "disk");
  await page.click("button.send");
  // The action answers 202 (it becomes a turn) and the card comes after: wait for the card itself in the chat before
  // leaving the page, otherwise /glance can read the waiting cards too early (2 pages instead of 3).
  await page.locator("button", { hasText: "Propose a purge" }).first().click({ timeout: STEP_MS });
  await until(page, "the purge card is posted", () => /Purge proposed/.test(document.body.textContent ?? ""));
  const t0 = Date.now();
  await page.goto(`${base}/glance`);
  await until(page, "glance summary", () => /waits? for you/.test(document.querySelector(".glance-page")?.textContent ?? ""));
  t.glanceMs = Date.now() - t0;
  const pages = await page.locator(".glance-dot").count();
  if (pages < 3) throw new StepError(`glance: ${pages} pages, expected summary + brief + card — ${await page.evaluate(() => document.querySelector(".glance-page")?.textContent)}`);
  const seen = [];
  for (let i = 0; i < pages; i++) {
    const v = await page.evaluate(() => {
      const small = [];
      for (const el of document.querySelectorAll(".glance *")) {
        const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
        if (own && el.getBoundingClientRect().width && parseFloat(getComputedStyle(el).fontSize) < 22) small.push(el.className);
      }
      return { text: document.querySelector(".glance-page")?.textContent ?? "", small, tall: document.documentElement.scrollHeight > innerHeight + 1 };
    });
    if (v.small.length) throw new StepError(`glance page ${i + 1}: text under 22 px (${v.small.join(", ")})`);
    if (v.tall) throw new StepError(`glance page ${i + 1}: taller than the screen`);
    seen.push(v.text);
    await noOverflow(page, `glance page ${i + 1}`);
    await shot(page, `glance-${i + 1}`);
    await page.keyboard.press("ArrowRight");
  }
  if (!seen.some((x) => /Morning brief/.test(x))) throw new StepError("glance: no brief page");
  if (!seen.some((x) => /phone/.test(x))) throw new StepError("glance: no card page");
  await until(page, "ArrowRight loops back to the summary", () => /waits? for you/.test(document.querySelector(".glance-page")?.textContent ?? ""));
  // The glasses' activation gesture is Enter: it moves on as well.
  await page.keyboard.press("Enter");
  await until(page, "Enter moves to the next page", () => /Morning brief/.test(document.querySelector(".glance-page")?.textContent ?? ""));
}

/** Pair glasses from the phone (My account → Glasses), claim the code on the glasses (no session there), read the view
 * with the read-only token only, then revoke from the phone: the glasses fall back to the pairing screen. */
async function glancePair(page, base, t) {
  await login(page, base, t);
  await page.locator(".acct-btn").click();
  await page.locator('.menu-pop [data-view="account"]').click();
  const card = page.locator(".glasses-card");
  await card.scrollIntoViewIfNeeded({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no Glasses card in My account");
  });
  await card.locator("button", { hasText: /Pair glasses/ }).click();
  await until(page, "pairing code shown", () => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector(".glasses-code")?.textContent ?? ""));
  if (!(await card.locator(".glasses-qr rect").count())) throw new StepError("no QR drawn");
  await noOverflow(page, "glasses card");
  await shot(page, "glance-pair-phone");
  const code = await page.locator(".glasses-code").innerText();

  const glassesCtx = await page.context().browser().newContext({ ...GLASSES, locale: "en-US" });
  const g = await glassesCtx.newPage();
  // Controlled clock: minutes pass in milliseconds (read cadence, Retry-After).
  await g.clock.install();
  await g.clock.resume();
  const calls = [];
  g.on("request", (r) => /\/v1\//.test(r.url()) && calls.push(`${r.method()} ${new URL(r.url()).pathname}`));
  try {
    await g.goto(`${base}/glance`);
    await g.waitForSelector("#glance-code", { timeout: STEP_MS });
    await shot(g, "glance-pair-glasses");
    await g.keyboard.type(code.toLowerCase().replace("-", "")); // typed loosely: no dash, lower case
    await g.keyboard.press("Enter");
    await until(g, "glance view after pairing", () => /waits? for you/.test(document.querySelector(".glance-page")?.textContent ?? ""));
    const token = await g.evaluate(() => localStorage.getItem("nokker.glance.token"));
    if (!token?.startsWith("nkg_")) throw new StepError("no glance token stored");
    const after = calls.slice(calls.indexOf("POST /v1/glance/claim") + 1).filter((c) => !c.startsWith("GET /v1/health"));
    const other = after.filter((c) => c !== "GET /v1/glance");
    if (other.length) throw new StepError(`the glasses called more than GET /v1/glance: ${[...new Set(other)].join(", ")}`);
    await g.keyboard.press("ArrowRight");

    // Rate: never two reads closer than 30 s, coming back to the front included (core: 2 reads per minute per token).
    const reads = () => calls.filter((c) => c === "GET /v1/glance").length;
    const n0 = reads();
    await g.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await g.waitForTimeout(500);
    if (reads() !== n0) throw new StepError("a second read within 30 s (visibility change)");
    // 429 glance_rate with Retry-After: the last view stays, « offline » shows, no read before Retry-After.
    await g.route("**/v1/glance", (r) => r.fulfill({ status: 429, headers: { "Retry-After": "40", "Content-Type": "application/json" }, body: '{"error":{"code":"glance_rate"}}' }));
    await g.clock.fastForward("01:01");
    await until(g, "offline after a 429", () => /offline/i.test(document.querySelector(".glance-conn")?.textContent ?? ""));
    if (!(await g.locator(".glance-page").innerText()).trim()) throw new StepError("the last view was lost on a 429");
    const n1 = reads();
    await g.clock.fastForward("00:31");
    await g.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await g.waitForTimeout(500);
    if (reads() !== n1) throw new StepError("a read before Retry-After");
    await g.unroute("**/v1/glance");

    await page.reload();
    await page.locator(".acct-btn").click();
    await page.locator('.menu-pop [data-view="account"]').click();
    await page.locator(".glasses-card li").first().locator("button", { hasText: "Revoke" }).click();
    await page.locator(".glasses-card li").first().locator("button", { hasText: "Revoke these glasses" }).click();
    await until(page, "glasses revoked", () => !document.querySelector(".glasses-card li"));
    await g.reload();
    await until(g, "revoked glasses fall back to pairing", () => !!document.querySelector("#glance-code"));
  } finally {
    await glassesCtx.close();
  }
}

/** Cast (SCREEN-CAST §7, mock started with MOCK_CAST=1): the bubble asks for a go on a new screen, previews the page in
 * a sandbox WITHOUT allow-same-origin, approve shows, stop ends. */
async function cast(page, base, t) {
  await login(page, base, t);
  const name = `e2e cast ${tag()}`;
  await newSession(page, name);
  await page.fill("#nk-composer", "show it on the TV");
  await page.click("button.send");
  const body = page.locator(".bubble-body.cast").first();
  await body.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no cast bubble (is the mock started with MOCK_CAST=1?)");
  });
  const frame = body.locator("iframe.cast-frame");
  await frame.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no cast preview frame");
  });
  // Cadre signé du noyau (p2/cast-frame) : src, jamais srcdoc (une page srcdoc hériterait de la CSP de l'app).
  const src = await frame.getAttribute("src");
  if (!src || !/\/v1\/cast\/[^/]+\/frame\?exp=\d+&sig=/.test(src) || (await frame.getAttribute("srcdoc")) !== null) throw new StepError(`cast preview is not the signed frame: src=${src}`);
  const sandbox = await frame.getAttribute("sandbox");
  if (sandbox !== "allow-scripts") throw new StepError(`cast preview sandbox is « ${sandbox} », expected « allow-scripts » only`);
  if (!/nothing is shown before you approve/i.test(await body.innerText())) throw new StepError("no « nothing is shown before you approve »");
  await noOverflow(page, "cast bubble");
  await shot(page, "cast-pending");
  await body.locator("button", { hasText: "Approve" }).click();
  await until(page, "cast shown (Stop offered)", () => [...document.querySelectorAll(".bubble-body.cast button")].some((x) => x.textContent?.trim() === "Stop"));
  await body.locator("button", { hasText: "Stop" }).click();
  await until(page, "cast stopped", () => !document.querySelector(".bubble-body.cast button"));
  await shot(page, "cast-stopped");
}

/** Page de l'agent (BUBBLES §10) : la bulle artifact montre la page signée dans son iframe (frame-src 'self' de la CSP),
 * et le contenu de la page s'y affiche. */
async function artifact(page, base, t) {
  await login(page, base, t);
  await newSession(page, `e2e page ${tag()}`);
  await page.fill("#nk-composer", "create a page Budget review");
  await page.click("button.send");
  const frame = page.locator("iframe.artifact-iframe").first();
  await frame.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no page preview in the artifact bubble");
  });
  const src = await frame.getAttribute("src");
  if (!src) throw new StepError("artifact iframe without src");
  const inner = page.frameLocator("iframe.artifact-iframe").first().locator("body");
  await inner.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError(`the page did not load in its frame (src ${src.replace(/\?.*/, "")})`);
  });
  if (!(await inner.innerText()).trim()) throw new StepError("the page frame is empty");
  await noOverflow(page, "artifact bubble");
  await shot(page, "artifact");
}

/** A 320×200 PNG that looks like a screen: a bar, text lines, and a coral « button » around (72 %, 18 %). */
function fakeScreen() {
  const w = 320;
  const h = 200;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      let c = [238, 240, 244];
      if (y < 24) c = [52, 58, 70];
      else if (x > 200 && x < 262 && y > 26 && y < 46) c = [226, 71, 79];
      else if (x > 20 && x < 180 && y > 60 && (y - 60) % 22 < 8 && y < 170) c = [196, 200, 208];
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** « Show me » (core docs/SHOW-ME.md, mock with MOCK_SHOW_ME=1, web built with VITE_NOKKER_SHOW_ME=1): Nina points at
 * the paperclip, the person answers « Done », the arrow moves to « Send » in the same bubble, « Done » on the last step
 * closes it. Then on a screenshot of the thread: the image with the arrow on the point. */
async function showMe(page, base, t, label) {
  const fr = label.includes("fr");
  if (label.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  await login(page, base, t);
  const name = `e2e show me ${tag()}`;
  await newSession(page, name);
  await shot(page, `showme-${label}-before`);
  await page.fill("#nk-composer", fr ? "montre-moi comment joindre un PDF" : "show me how to attach a PDF");
  await page.click("button.send");
  const body = page.locator(".bubble-body.pointer").first();
  await body.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no pointer bubble (mock with MOCK_SHOW_ME=1, web with VITE_NOKKER_SHOW_ME=1?)");
  });
  const ringAround = (sel) =>
    until(page, `arrow ring around ${sel}`, (s) => {
      const ring = document.querySelector(".showme-overlay .showme-ring")?.getBoundingClientRect();
      const el = document.querySelector(s)?.getBoundingClientRect();
      return !!ring && !!el && ring.left <= el.left && ring.top <= el.top && ring.right >= el.right && ring.bottom >= el.bottom;
    }, sel);
  await ringAround('[data-show-me="attach"]');
  if (!(await page.locator(".showme-overlay .showme-arrow").isVisible())) throw new StepError("no big arrow over the app");
  // One language: the bubble's title is written by the web, in the interface language (the core's title is French data).
  const step1 = fr ? "Étape 1 sur 2" : "Step 1 of 2";
  const title = (await page.locator(".bubble:has(.bubble-body.pointer) .bubble-title").first().textContent())?.trim();
  if (title !== step1) throw new StepError(`bubble title « ${title} », expected « ${step1} »`);
  const doneLabel = (await body.locator(".btn-brass").textContent())?.trim();
  if (doneLabel !== (fr ? "Fait" : "Done")) throw new StepError(`answer button « ${doneLabel} »`);
  const check = await page.evaluate(() => {
    const inside = (a, b) => a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1;
    const out = [];
    // The answers are fully visible, without scrolling, in their bubble strip (phone) or window.
    const strip = document.querySelector(".bubble-inline")?.getBoundingClientRect() ?? { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    for (const b of document.querySelectorAll(".bubble-body.pointer .bubble-actions button")) if (!inside(b.getBoundingClientRect(), strip)) out.push(`answer « ${b.textContent} » cut`);
    // Nothing of the overlay covers Nina's last message.
    const msgs = document.querySelectorAll(".msg.nina");
    const last = msgs[msgs.length - 1]?.getBoundingClientRect();
    if (last)
      for (const o of document.querySelectorAll(".showme-overlay .showme-float, .showme-overlay .showme-pill, .showme-overlay .showme-sign-float")) {
        const r = o.getBoundingClientRect();
        if (r.left < last.right && r.right > last.left && r.top < last.bottom && r.bottom > last.top) out.push(`${o.className} covers Nina's last message`);
      }
    return out;
  });
  if (check.length) throw new StepError(check.join("; "));
  await noOverflow(page, "show me, step 1");
  await shot(page, `showme-${label}-step1`);
  // The overlay never blocks the app: the paperclip under the arrow is still clickable.
  const hit = await page.evaluate(() => {
    const r = document.querySelector('[data-show-me="attach"]').getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-show-me="attach"]') !== null;
  });
  if (!hit) throw new StepError("the overlay covers the paperclip");
  await body.locator(".btn-brass").click();
  await until(page, "step 2 in the same bubble", (t2) => document.querySelector(".bubble:has(.bubble-body.pointer) .bubble-title")?.textContent?.trim() === t2, fr ? "Étape 2 sur 2" : "Step 2 of 2");
  await ringAround('[data-show-me="send"]');
  await shot(page, `showme-${label}-step2`);
  await page.locator(".bubble-body.pointer .btn-brass").click();
  await until(page, "pointer closed after the last step", () => !document.querySelector(".bubble-body.pointer") && !document.querySelector(".showme-overlay"));
  // On a screenshot of the thread.
  const png = fakeScreen();
  await page.setInputFiles('input[type="file"]', { name: "screen.png", mimeType: "image/png", buffer: png });
  await page.fill("#nk-composer", fr ? "la voici" : "here it is");
  await page.click("button.send");
  await until(page, "image sent", () => !!document.querySelector(".msg-image img"));
  await page.fill("#nk-composer", fr ? "montre-moi où sur la capture" : "show me where on the screenshot");
  await page.click("button.send");
  await until(page, "arrow on the screenshot", () => !!document.querySelector(".bubble-body.pointer .showme-shot img") && !!document.querySelector(".showme-shot .showme-at .showme-arrow"));
  // Phone: the bubble strip scrolls inside itself; never scroll the page (desktop bubbles float).
  await page.evaluate(() => {
    const shotEl = document.querySelector(".bubble-inline .bubble-body.pointer .showme-shot");
    const strip = shotEl?.closest(".bubble-inline");
    if (shotEl && strip) strip.scrollTop += shotEl.getBoundingClientRect().top - strip.getBoundingClientRect().top;
  });
  // The whole bubble (answers and picture) is inside the window.
  const cut = await page.evaluate(() => {
    const r = document.querySelector(".bubble:has(.bubble-body.pointer)")?.getBoundingClientRect();
    return !document.querySelector(".bubble-inline") && r && (r.bottom > innerHeight + 1 || r.top < -1);
  });
  if (cut) throw new StepError("the pointer bubble with its picture goes past the window");
  await noOverflow(page, "show me on a screenshot");
  await shot(page, `showme-${label}-image`);
}

/** « Maison » (HOUSE-ROOM §6, mock with MOCK_HOUSE_ROOM=1): avatars, a tap on an avatar mentions it, the reply comes
 * from that agent; members are anonymised labels, nothing sideways on a phone. */
async function house(page, base, t) {
  await login(page, base, t);
  await page.click(".drawer-fab");
  const place = page.locator('.drawer-places [data-view="house"]');
  await place.click({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « Home » view in the drawer (is the mock started with MOCK_HOUSE_ROOM=1?)");
  });
  await until(page, "six avatars", () => document.querySelectorAll(".house-avatar").length === 6);
  await noOverflow(page, "house");
  await shot(page, "house");
  await page.locator(".house-avatar", { hasText: "Agenda" }).click();
  if (!(await page.inputValue("#nk-house")).startsWith("@agenda")) throw new StepError("tapping an avatar does not mention it");
  await page.locator("#nk-house").pressSequentially("what about Friday?");
  await until(page, "the composer says who it goes to", () => /Agenda/.test(document.querySelector(".house-to")?.textContent ?? ""));
  const before = await page.locator(".house-msg").count();
  await page.locator(".house-composer button.send").click();
  await until(page, "my message shows", (n) => document.querySelectorAll(".house-msg.mine").length > 0 && document.querySelectorAll(".house-msg").length > n, before);
  await until(page, "Agenda answers", () => [...document.querySelectorAll(".house-msg.agent .house-who")].some((x) => x.textContent === "Agenda" && /Friday/.test(x.closest(".house-msg")?.textContent ?? "")));
  const text = await page.locator(".house").innerText();
  if (/@example\./.test(text)) throw new StepError("a member address shows in the house room");
  const atBottom = await page.evaluate(() => { const l = document.querySelector(".house-log"); return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 4; });
  if (!atBottom) throw new StepError("the house log does not show its last message");
  await noOverflow(page, "house after a reply");
  await shot(page, "house-reply");
}

/** « Who does what » (WHO-DOES-WHAT, mock with MOCK_WHO_DOES_WHAT=1): the top-bar button shows how many wait for me, the
 * panel lists the agents by status (needs me first), a click on a thread row opens that thread, a house row the house
 * room; nothing sideways on a phone, light and dark. */
async function presence(page, base, t) {
  await login(page, base, t);
  const btn = page.locator(".presence-btn");
  await btn.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « Who does what » button in the top bar (is the mock started with MOCK_WHO_DOES_WHAT=1?)");
  });
  await until(page, "the badge counts what waits for me", () => Number(document.querySelector(".presence-count")?.textContent) >= 2);
  await btn.click();
  await until(page, "the panel lists rows", () => document.querySelectorAll(".presence-row").length >= 4);
  const fr = await page.evaluate(() => navigator.language.startsWith("fr"));
  const first = await page.locator(".presence-group h3").first().innerText();
  if (!(fr ? /^t.attendent/i : /^needs you/i).test(first)) throw new StepError(`the first group is wrong for the language: ${first}`);
  const panel = await page.locator(".presence-pop").innerText();
  const want = fr ? /attend ton approbation : mail_envoyer/ : /waiting for your approval: mail_envoyer/;
  if (!want.test(panel)) throw new StepError(`the activity line is not worded in the interface language: ${panel.slice(0, 300)}`);
  const stray = fr ? /Needs you|Working|waiting for your|agent paused|the last run failed|uses the/ : /attend ton|T.attendent|bloqué|agent en pause|dernier passage|utilise l/;
  // Only the interface's own words: names and conversation snippets are the people's content, in their own language.
  const ui = await page.evaluate(() => {
    const pop = document.querySelector(".presence-pop").cloneNode(true);
    pop.querySelectorAll('.presence-name, .presence-act[data-act="snippet"], .presence-act[data-act="run_summary"]').forEach((n) => n.remove());
    return pop.innerText ?? pop.textContent;
  });
  const mixed = ui.match(stray);
  if (mixed) throw new StepError(`the panel mixes languages: « ${mixed[0]} » in ${ui.replace(/\s+/g, " ").slice(0, 400)}`);
  const statuses = await page.$$eval(".presence-pop li", (l) => l.map((x) => x.getAttribute("data-status")));
  const rank = ["awaiting_approval", "blocked", "working", "paused", "idle"];
  if (statuses.some((s, i) => i && rank.indexOf(s) < rank.indexOf(statuses[i - 1]))) throw new StepError(`rows not ordered by status: ${statuses}`);
  if (await page.locator(".presence-ro").count()) throw new StepError("a payer/solo account shows « Read only »");
  await noOverflow(page, "presence panel");
  await shot(page, `presence-${page.viewportSize().width}-${fr ? "fr" : "en"}-light`);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await shot(page, `presence-${page.viewportSize().width}-${fr ? "fr" : "en"}-dark`);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const thread = page.locator('.presence-pop li[data-kind="thread"] .presence-row').first();
  if (await thread.count()) {
    const name = (await thread.locator(".presence-name").innerText()).trim();
    await thread.click();
    await until(page, "the thread opens", (n) => (document.querySelector(".topbar-title")?.textContent ?? "").trim() === n, name);
    await until(page, "the panel closes", () => !document.querySelector(".presence-pop"));
  }
  await btn.click();
  await page.locator('.presence-pop li[data-kind="house"] .presence-row').first().click();
  await until(page, "the house room opens", () => !!document.querySelector(".house"));
  await noOverflow(page, "house after presence");
}

/** Learning → Consolidations (CONSOLIDATION §6, mock with MOCK_CONSOLIDATION=1): last night's operations, undo one
 * (with a confirmation), undo the night: the op on a note edited since stays and is said. */
async function consolidation(page, base, t) {
  await login(page, base, t);
  await page.locator(".acct-btn").click();
  await page.locator('.menu-pop [data-view="learning"]').click();
  const tab = page.locator(".lrn-tab", { hasText: "Consolidations" });
  await tab.click({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no Consolidations tab (is the mock started with MOCK_CONSOLIDATION=1?)");
  });
  await until(page, "last night's four operations", () => document.querySelectorAll(".cx-op").length === 4);
  if (!/1 merge, 1 correction, 1 archived note, 1 lesson/.test(await page.locator(".lrn-skill-row").first().innerText())) throw new StepError("the night's summary is not in the interface language");
  await noOverflow(page, "consolidations");
  await shot(page, "consolidation-night");
  const archive = page.locator(".cx-op", { hasText: "Wi-Fi" }); // the archive op (the merge archives a note too)
  await archive.locator("button", { hasText: "Undo" }).click();
  await archive.locator("button", { hasText: "Yes, undo it" }).click();
  await until(page, "the archive is undone", () => [...document.querySelectorAll(".cx-op.undone")].some((x) => /Wi-Fi/.test(x.textContent ?? "")));
  await page.locator("button", { hasText: /Undo the night of/ }).click();
  await page.locator("button", { hasText: "Yes, undo the whole night" }).click();
  await until(page, "the conflict is said", () => /except 1 operation on a note you changed since/.test(document.querySelector(".cx-report")?.textContent ?? ""));
  // The report is said before the list is read again: wait for the list, not a count taken at once.
  await until(page, "after undoing the night, exactly the conflicting op stays", () => document.querySelectorAll(".cx-op").length === 4 && document.querySelectorAll(".cx-op:not(.undone)").length === 1);
  await shot(page, "consolidation-undone");
}

/** Learning → Memory (cloud long memory, mock): add a note, see « Noted », add it again → « Already noted », delete with a
 * confirmation; the pending « Nina suggests keeping » card is approved and the note's name is said. */
async function longMemory(page, base, t) {
  await login(page, base, t);
  await page.locator(".acct-btn").click();
  await page.locator('.menu-pop [data-view="learning"]').click();
  await page.locator(".lrn-tab", { hasText: "To approve" }).click();
  await until(page, "Nina's proposal is shown", () => /Nina suggests keeping/.test(document.querySelector(".lrn")?.textContent ?? ""));
  await page.locator(".lrn-card", { hasText: "Tutoiement" }).locator("button", { hasText: "Remember" }).click();
  await until(page, "the note is said as noted, with its name", () => /Noted: /.test(document.querySelector(".lrn-noted")?.textContent ?? ""));
  await page.locator(".lrn-tab", { hasText: "Memory" }).click({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no Memory tab (long memory off in the mock?)");
  });
  await until(page, "the seeded note", () => document.querySelectorAll(".lrn-card[data-note]").length === 1);
  const add = async () => {
    await page.fill('.lrn-form input', "Café");
    await page.fill(".lrn-form textarea", "Je bois mon café sans sucre.");
    await page.locator(".lrn-form button[type=submit]").click();
  };
  await add();
  await until(page, "noted", () => /^Noted$/.test(document.querySelector(".lrn-noted")?.textContent?.trim() ?? "") && document.querySelectorAll(".lrn-card[data-note]").length === 2);
  await add();
  await until(page, "already noted", () => /Already noted/.test(document.querySelector(".lrn-noted")?.textContent ?? "") && document.querySelectorAll(".lrn-card[data-note]").length === 2);
  await noOverflow(page, "memory");
  await shot(page, "long-memory");
  const card = page.locator(".lrn-card[data-note]", { hasText: "Café" });
  await card.locator("button", { hasText: "Delete" }).click();
  await card.locator("button", { hasText: "Yes, delete" }).click();
  await until(page, "the note is gone", () => document.querySelectorAll(".lrn-card[data-note]").length === 1);
}

/** « To pay » card (PAYMENTS §5, mock with MOCK_PAYMENTS=1): « achète … » prepares a cart; the approval card shows the
 * purchase (merchant, amount, items), says only a passkey approves it, offers no TOTP; My account → Spending shows the
 * budgets and the waiting card. (A device signed in by mail code decides nothing, so no decision here: see the mock tests.) */
async function payments(page, base, t) {
  await login(page, base, t);
  await newSession(page, `e2e pay ${tag()}`);
  await page.fill("#nk-composer", "achète des cartouches d'encre");
  await page.click("button.send");
  const block = page.locator(".pay-block[data-pay=pending]").first();
  await block.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « to pay » block (is the mock started with MOCK_PAYMENTS=1?)");
  });
  const text = await block.innerText();
  if (!/Papeterie Centrale/.test(text) || !/(?:59\.80\s?CHF|CHF\s?59\.80)/.test(text)) throw new StepError(`the purchase is not shown: « ${text.slice(0, 80)} »`);
  if (!/Only a passkey approves/.test(text)) throw new StepError("no « only a passkey approves »");
  const card = block.locator("xpath=ancestor::div[contains(@class,'bubble-body')][1]");
  if (await card.locator("form.totp").count()) throw new StepError("a TOTP form on a « to pay » card");
  await noOverflow(page, "to pay card");
  await shot(page, "pay-card");
  await openView(page, "account");
  // The Spending card, not the payment method's (same look, `data-pay-method`, present when the payment agent is on).
  const spending = page.locator(".pay-card:not([data-pay-method])");
  await spending.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no Spending card in My account");
  });
  await until(page, "the budget line", () => document.querySelectorAll(".pay-lines > li").length === 1);
  await until(page, "the waiting card is in the history", () => [...document.querySelectorAll(".pay-history li")].some((x) => /Papeterie Centrale/.test(x.textContent ?? "") && /to pay/.test(x.textContent ?? "")));
  await spending.scrollIntoViewIfNeeded();
  await noOverflow(page, "spending");
  await shot(page, "spending");
}

/** Spending on a phone (no household: the account alone, payer of itself): the order of the caps is checked before
 * saving; a saved budget replaces the default one; back to the default. */
/** Formules (SubscriptionCard) : chaque bouton « Choisir … » tient sur une ligne, sans débordement, puis capture. */
async function planButtonsOneLine(page) {
  const plans = page.locator("li[data-plan] > button");
  await plans.first().waitFor({ timeout: STEP_MS });
  // Lignes du libellé : les rectangles d'une plage sur son texte, groupés par ligne (deux hauteurs égales ne prouvent rien).
  const wrapped = await plans.evaluateAll((bs) =>
    bs
      .map((b) => {
        const r = document.createRange();
        r.selectNodeContents(b);
        return { text: b.textContent?.trim() ?? "", lines: new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size };
      })
      .filter((x) => x.lines > 1),
  );
  if (wrapped.length) throw new StepError(`plan buttons on two lines: ${wrapped.map((x) => `« ${x.text} »`).join(", ")}`);
  await page.locator("#acc-sub").scrollIntoViewIfNeeded();
  await noOverflow(page, "subscription plans");
  await shot(page, "account-plans");
}

/** Code d'essai (voucher, core docs/VOUCHERS.md ; mock ESSAI2026 / PERIME) : un lien `?code=` ouvre Mon compte avec le
 * code vérifié d'emblée, les formules passent en « Commencer l'essai … » sur une ligne, puis un code périmé est refusé
 * sous le champ. Le Checkout lui-même n'est pas suivi (page Stripe). */
async function voucher(page, base, t) {
  await login(page, base, t);
  await page.goto(`${base}/account?code=essai2026`);
  await page.locator("[data-voucher=ok]").waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("a ?code= link did not give a checked trial code in My account");
  });
  const fr = (await page.evaluate(() => document.documentElement.lang)) === "fr";
  const labels = await page.locator("li[data-plan] > button").allInnerTexts();
  if (!labels.length || !labels.every((l) => (fr ? /Commencer l.essai/ : /Start the .* trial/).test(l)))
    throw new StepError(`plan buttons are not trial buttons: ${labels.join(" | ")}`);
  if (new URL(page.url()).searchParams.has("code")) throw new StepError("the code stays in the address bar");
  await planButtonsOneLine(page);
  await shot(page, "account-trial");
  const input = page.locator("#acc-code-in");
  await input.fill("perime");
  await page.locator(".acc-code button[type=submit]").click();
  await page.locator("[data-voucher=code_expired]").waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("an expired code is not refused under the field");
  });
  await noOverflow(page, "trial code refused");
}

/** Noyau d'avant les codes d'essai (`GET /v1/billing/voucher` en 404) : un lien `?code=` ouvre Mon compte sans essai,
 * sans champ ni « J'ai un code », sans message d'erreur ; les formules restent « Choisir … ». */
async function voucherOff(page, base, t, local) {
  if (!local?.api) return void (t.skipped = "no local token");
  await login(page, base, t);
  const mock = async (body) =>
    (await fetch(`${local.api}/v1/dev/account-mock`, { method: "POST", headers: { Authorization: `Bearer ${local.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
  if ((await mock({ vouchers: false })) !== 200) throw new StepError("account mock refused vouchers:false");
  try {
    await page.goto(`${base}/account?code=essai2026`);
    await page.locator("li[data-plan] > button").first().waitFor({ timeout: STEP_MS });
    await page.waitForResponse((r) => /\/v1\/billing\/voucher\?/.test(r.url()), { timeout: STEP_MS }).catch(() => undefined);
    await page.waitForTimeout(300);
    if (await page.locator("#acc-code-in").count()) throw new StepError("the code field stays when the core has no vouchers");
    if (await page.locator(".acc-code-open").count()) throw new StepError("« I have a code » stays when the core has no vouchers");
    if (await page.locator("#acc-sub ~ * [role=alert], section[aria-labelledby=acc-sub] [role=alert]").count()) throw new StepError("an error is shown for a core without vouchers");
    const labels = await page.locator("li[data-plan] > button").allInnerTexts();
    if (labels.some((l) => /trial|essai/i.test(l))) throw new StepError(`trial buttons without vouchers: ${labels.join(" | ")}`);
    if (new URL(page.url()).searchParams.has("code")) throw new StepError("the code stays in the address bar");
    await planButtonsOneLine(page);
  } finally {
    await mock({ vouchers: true });
  }
}

/** Essai résilié (cancel_at_period_end pendant l'essai) : Mon compte dit qu'il s'arrête à la fin de l'essai sans débit,
 * jamais « premier débit ce jour-là ». */
async function trialCancelled(page, base, t, local) {
  if (!local?.api) return void (t.skipped = "no local token");
  await login(page, base, t);
  const mock = async (body) =>
    (await fetch(`${local.api}/v1/dev/account-mock`, { method: "POST", headers: { Authorization: `Bearer ${local.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
  if ((await mock({ plan: "solo", status: "trialing", cancelling: true })) !== 200) throw new StepError("account mock refused a cancelled trial");
  try {
    await openView(page, "account");
    const note = page.locator("[data-trial-end][data-cancelling]");
    await note.waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("a cancelled trial is not shown as cancelled");
    });
    const text = await note.innerText();
    if (/premier débit|first charge/i.test(text)) throw new StepError(`a cancelled trial still announces a charge: ${text}`);
    if (!/rien ne sera débité|nothing will be charged/.test(text)) throw new StepError(`no « nothing will be charged »: ${text}`);
    await noOverflow(page, "cancelled trial");
  } finally {
    await mock({ plan: null, status: null, cancelling: false });
  }
}

async function budgets(page, base, t) {
  await login(page, base, t);
  await openView(page, "account");
  await planButtonsOneLine(page);
  const me = page.locator(".pay-lines > li").first();
  await me.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no budget line (is the mock started with MOCK_PAYMENTS=1?)");
  });
  if ((await page.locator(".pay-lines > li").count()) !== 1) throw new StepError("an account alone shows more than its own line");
  if (!/default budget/.test(await me.innerText())) throw new StepError("the payer's default budget is not said");
  await me.locator("button", { hasText: "Change" }).click();
  await me.locator('input[id$="-per_purchase"]').fill("120");
  await me.locator('input[id$="-per_day"]').fill("100");
  await me.locator('input[id$="-per_month"]').fill("600");
  if (!(await me.locator("button", { hasText: "Save" }).isDisabled())) throw new StepError("per purchase above per day is not stopped before saving");
  await me.locator('input[id$="-per_purchase"]').fill("80");
  await noOverflow(page, "budget editor");
  await shot(page, "budget-editor");
  await me.locator("button", { hasText: "Save" }).click();
  await until(page, "own budget saved", () => /own budget/.test(document.querySelector(".pay-lines > li")?.textContent ?? "") && /(?:80\.00\s?CHF|CHF\s?80\.00) per purchase/.test(document.querySelector(".pay-lines > li")?.textContent ?? ""));
  await shot(page, "budget-saved");
  await me.locator("button", { hasText: "Change" }).click();
  await me.locator("button", { hasText: "Back to the default budget" }).click();
  await until(page, "back to the default budget", () => /default budget/.test(document.querySelector(".pay-lines > li")?.textContent ?? ""));
}

/** On a phone, typing folds the thread's bubbles into one bar: open it again. */
async function unfoldBubbles(page) {
  if (await page.locator(".bubble-fold").count()) await page.click(".bubble-fold");
}

/** Automatic review (APPROVALS.md §8): a file write approved by the reviewer is revoked from its card, the restore
 * point lists the files, « Restore files » puts back the one unchanged since and says the other was modified since;
 * after a reload the card says it was already restored; a calendar write has no restore point (a line, no button).
 * Same journey in English and French. */
async function autoReview(page, base, t) {
  await login(page, base, t);
  const fr = (await page.evaluate(() => document.documentElement.lang)) === "fr";
  await newSession(page, `e2e review ${tag()}`);
  await send(page, "auto-review", "restore the files");
  await unfoldBubbles(page);
  // Decided by the reviewer: a compact card, nothing that reads as waiting for a decision.
  const compact = page.locator(".ar-compact[data-auto-review=approve]").last();
  await compact.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no compact card for the automatic approval");
  });
  if (!(fr ? /Approuvé automatiquement/ : /Approved automatically/).test(await compact.innerText())) throw new StepError("« Approved automatically » is not said");
  // The bubble (stable), not the card body: the compact card is replaced by the full one after revoking.
  const body = page.locator(`article[data-bubble-id="${await compact.locator("xpath=ancestor::article[@data-bubble-id][1]").getAttribute("data-bubble-id")}"]`);
  if (await body.locator(".btn-brass, form.totp, .kv").count()) throw new StepError("the automatic approval reads like a card waiting for a decision");
  await noOverflow(page, "compact card");
  await shot(page, "auto-review-card");
  await compact.locator("[data-ar=revoke]").click();
  const block = body.locator(".ar-block[data-auto-review=approve]");
  await block.locator("[data-ar=restore]").waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « Restore files » after revoking");
  });
  const listed = await block.locator(".ar-files li").allInnerTexts();
  if (listed.join("|") !== "notes/plan.md|src/settings.json") throw new StepError(`files of the restore point: ${listed.join(", ")}`);
  if (await body.locator("[data-ar=revoke]").count()) throw new StepError("« Revoke » still offered after revoking");
  await noOverflow(page, "restore point");
  await shot(page, "auto-review-revoked");
  await block.locator("[data-ar=restore]").click();
  const done = block.locator("[data-ar=restored]");
  await done.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no result after « Restore files »");
  });
  const conflict = fr ? /src\/settings\.json\s+modifié depuis, non restauré/ : /src\/settings\.json\s+modified since, not restored/;
  const text = await done.innerText();
  if (!/notes\/plan\.md/.test(text)) throw new StepError("the restored file is not listed");
  if (!conflict.test(text)) throw new StepError(`the conflict is not said: « ${text.slice(0, 120)} »`);
  if (await block.locator("[data-ar=restore]").count()) throw new StepError("« Restore files » still offered after restoring");
  await noOverflow(page, "restored");
  await shot(page, "auto-review-restored");
  // After a reload the card reads its restore point from GET: already restored, with what was put back.
  await page.reload();
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await unfoldBubbles(page);
  const again = page.locator(".ar-block[data-auto-review=approve]").last();
  await again.locator("[data-ar=already]").waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("« Already restored » is not said after a reload");
  });
  const after = await again.innerText();
  if (!/notes\/plan\.md/.test(after) || !conflict.test(after)) throw new StepError(`what was restored is lost after a reload: « ${after.slice(0, 160)} »`);
  if (await again.locator("[data-ar=restore], [data-ar=revoke]").count()) throw new StepError("an action is offered on a card already restored");
  await shot(page, "auto-review-reloaded");
  // A session of its own: on a phone the bubbles of a thread stack, one shown at a time.
  await newSession(page, `e2e review cal ${tag()}`);
  await send(page, "auto-review agenda", "calendar entry");
  await unfoldBubbles(page);
  const cal = page.locator(".ar-compact[data-auto-review=approve]").last();
  await cal.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no calendar card from the automatic review");
  });
  await cal.locator("[data-ar=revoke]").click();
  await until(page, "no restore point said", (want) => [...document.querySelectorAll(".ar-block .ar-none")].some((x) => x.textContent?.includes(want)), fr ? "Pas de point de retour" : "No restore point");
  if (await page.locator(".ar-block [data-ar=restore]").count()) throw new StepError("« Restore files » offered without a restore point");
}

/** Folder mode on the Lokkal machine (FOLDER-MODE §6, mock with MOCK_FOLDER=1): ask a plan on a folder, approve it,
 * the run is read again until done (every 2 s), the report says what was touched, undo it. Then an in-place run: its
 * approval waits for the confirmation that shows the path. */
async function folder(page, base, t, local) {
  if (!local?.folder) return void (t.skipped = "no local token");
  await page.goto(`${base}/#token=${local.token}`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await openView(page, "folder").catch(() => {
    throw new StepError("no Folder view on the machine (is the mock started with MOCK_FOLDER=1?)");
  });
  await page.fill("#fm-path", local.folder);
  await page.fill("#fm-task", "sort by type");
  await page.locator("button", { hasText: "Ask for a plan" }).click();
  await until(page, "the plan to approve", () => document.querySelectorAll(".fm-steps li").length === 4 && /plan to approve/.test(document.querySelector(".fm-head")?.textContent ?? ""));
  const plan = await page.locator(".fm-detail").innerText();
  if (!/copy/.test(plan) || !/output › jpg\/a\.jpg/.test(plan)) throw new StepError("the plan is not said in the interface's words");
  await noOverflow(page, "folder plan");
  await shot(page, "folder-plan");
  await page.locator("button", { hasText: "Approve the plan" }).click();
  await until(page, "the run is done", () => document.querySelector(".fm-detail")?.getAttribute("data-run") === "done", undefined);
  if (!/4 file\(s\) touched/.test(await page.locator(".fm-report").innerText())) throw new StepError("the report does not count the files touched");
  await shot(page, "folder-done");
  await page.locator("button", { hasText: "Undo this run" }).click();
  await page.locator("button", { hasText: "Yes, undo this run" }).click();
  await until(page, "undone", () => /back as it was/.test(document.querySelector(".fm-undo")?.textContent ?? ""));
  await page.check(".fm-new .fm-check input");
  await page.fill("#fm-task", "sort in place");
  await page.locator("button", { hasText: "Ask for a plan" }).click();
  await until(page, "the in-place plan", () => !!document.querySelector(".fm-card.strong"));
  const approve = page.locator("button", { hasText: "Approve the plan" });
  if (!(await approve.isDisabled())) throw new StepError("an in-place plan can be approved without the confirmation");
  if (!(await page.locator(".fm-card").innerText()).includes(local.folder)) throw new StepError("the confirmation does not show the path");
  await page.check(".fm-card .fm-check input");
  await noOverflow(page, "folder in place");
  await shot(page, "folder-in-place");
  await approve.click();
  await until(page, "the in-place run is done", () => document.querySelector(".fm-detail")?.getAttribute("data-run") === "done");
  if ((await page.locator(".fm-runs li").count()) !== 2) throw new StepError("the runs list does not show both runs");
}

/** ACCORD, Settings → Devices (nokker docs/ACCORD-DEVICE.md §2): the screen exists only when the machine serves
 * GET /v1/local/accord. Pairing window with its countdown, the 8 characters of the machine and of the device side by
 * side and BIG, the 6-digit code, the error states, the list, the revocation with its confirmation. The device is
 * played by the mock (POST /v1/dev/accord/request): a real one sends `pair` over a WebSocket. */
/** Quota atteint : la phrase du noyau reste la réponse, un lien « Mon compte » est dessous et ouvre le compte. */
async function quota(page, base, t, local) {
  if (!local) return void (t.skipped = "no local token");
  await page.goto(`${base}/#token=${local.token}`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  // An ordinary turn never carries the link.
  await send(page, "hello", "");
  if (await page.locator(".msg.nina .msg-body").last().locator("[data-quota-account]").count()) throw new StepError("an ordinary reply carries the quota link");
  await send(page, "simulate a quota", "Usage quota reached");
  await until(page, "the account link sits under the quota sentence", () => {
    const last = [...document.querySelectorAll(".msg.nina .msg-body")].pop();
    return !!last?.querySelector("[data-quota-account]");
  });
  await noOverflow(page, "quota sentence");
  await shot(page, "quota-link");
  await page.locator("[data-quota-account]").last().click();
  await until(page, "the account view opens", () => !!document.querySelector(".acc-usage, [data-usage-household], #acc-consent"));
  await shot(page, "quota-account");
}

/** Lokkal : le propriétaire local n'est pas un compte nokker.ai (`capabilities.account` faux, 403 sur /v1/account*, /v1/connectors).
 * Mon compte n'appelle pas ces routes, montre une carte vers nokker.ai (sans bandeau d'erreur), et le bouton du quota ouvre
 * la page de compte nokker.ai. */
async function lokkalAccount(page, base, t, local) {
  if (!local) return void (t.skipped = "no local token");
  const dev = (on) => page.request.post(`${local.api}/v1/dev/capabilities`, { data: { on } });
  await dev(true);
  try {
    const calls = [];
    page.on("request", (r) => /\/v1\/(account|connectors)(\/|$|\?)/.test(r.url()) && calls.push(`${r.method()} ${new URL(r.url()).pathname}`));
    await page.goto("about:blank");
    await page.goto(`${base}/#token=${local.token}`);
    await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
    // The quota button says where it goes and opens the nokker.ai account page.
    await send(page, "simulate a quota", "Usage quota reached");
    const btn = page.locator("[data-quota-account]").last();
    await btn.waitFor({ timeout: STEP_MS });
    if (!/nokker\.ai/.test(await btn.innerText())) throw new StepError(`the quota button does not say nokker.ai: ${await btn.innerText()}`);
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: STEP_MS }), btn.click()]);
    if (!/^https:\/\/app\.nokker\.ai\/account/.test(popup.url())) throw new StepError(`the quota button opened ${popup.url()}`);
    await popup.close().catch(() => {});
    // Mon compte: a card to nokker.ai, no error banner, and the account routes are never called.
    await openView(page, "account");
    await page.locator("[data-account-remote]").waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("no nokker.ai account card on a Lokkal");
    });
    const href = await page.locator("[data-account-remote-link]").getAttribute("href");
    if (href !== "https://app.nokker.ai/account") throw new StepError(`the account link is not nokker.ai: ${href}`);
    await page.waitForTimeout(800);
    if ((await page.locator(".ob-error, [role=alert]").count()) !== 0) throw new StepError("an error banner shows on Mon compte");
    if (calls.length) throw new StepError(`account routes were called on a Lokkal: ${calls.join(", ")}`);
    await shot(page, "lokkal-account");
  } finally {
    await dev(false);
  }
}

/** Repli Deep → Ship (noyau 3992fc13) : `turn.done.notice` est une ligne d'état DISCRÈTE sous la réponse, telle quelle ; jamais dans le
 * texte de la réponse, jamais une erreur ; rien sans repli ; perdue au rechargement (le noyau ne la garde pas). */
async function turnNotice(page, base, t) {
  await login(page, base, t);
  const NOTICE = "Reply in lighter mode: deep mode is unavailable right now.";
  const lastBody = () => page.locator(".msg.nina .msg-body").last();
  await send(page, "hello", "");
  if (await page.locator("[data-turn-notice]").count()) throw new StepError("an ordinary reply carries a status line");
  await send(page, "simulate a deep fallback", "");
  await until(page, "the status line shows under the reply", (n) => [...document.querySelectorAll("[data-turn-notice]")].some((e) => e.textContent.trim() === n), NOTICE);
  const noticeNodes = await lastBody().locator("[data-turn-notice]").count();
  if (noticeNodes !== 1) throw new StepError(`expected one status line under the last reply, found ${noticeNodes}`);
  // The reply text itself (the body without the status line) never carries it.
  const replyWithout = await lastBody().evaluate((el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll("[data-turn-notice]").forEach((n) => n.remove());
    return c.innerText ?? c.textContent ?? "";
  });
  if (replyWithout.includes(NOTICE)) throw new StepError("the status line is inside the reply text");
  if (await page.locator('.toasts > *, [role=alert]').filter({ hasText: NOTICE }).count()) throw new StepError("the status line shows as an error");
  await noOverflow(page, "turn notice");
  await shot(page, "turn-notice");
  // The kernel keeps it out of the history: after a reload it is gone, the reply stays.
  await page.reload();
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  if (await page.locator("[data-turn-notice]").count()) throw new StepError("the status line survived a reload (it is not in the history)");
}

/** Face d'une carte d'approbation : la CIBLE lisible du noyau (`target`) est visible sans dépliage ; jamais `arguments` (le corps du
 * message tapé par la personne n'y paraît pas), jamais de JSON brut. */
async function approvalTarget(page, base, t) {
  await login(page, base, t);
  await newSession(page, `e2e target ${tag()}`); // un fil à soi : une carte laissée en attente ne gêne aucun autre parcours
  await page.fill("#nk-composer", "send the quarterly report");
  await page.click("button.send");
  const face = page.locator("[data-approval-target]").first();
  await face.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no target on the face of the approval card (is the mock up to date?)");
  });
  const text = (await face.innerText()).replace(/\s+/g, " ");
  if (!/recipient@example\.com/.test(text)) throw new StepError(`the face does not say what goes out: ${text}`);
  if (/quarterly report/.test(text)) throw new StepError(`the face shows the arguments (the typed body): ${text}`);
  if (/[{}]/.test(text)) throw new StepError(`raw JSON on the face: ${text}`);
  if (!(await face.locator("code").isVisible())) throw new StepError("the target is not visible without opening anything");
  await noOverflow(page, "approval target");
  await shot(page, "approval-target");
  // The card stays pending (this demo session cannot decide it): it lives in a thread of its own, so no other journey sees it.
}

async function accord(page, base, t, local) {
  if (!local) return void (t.skipped = "no local token");
  const dev = (path, body) => page.request.post(`${local.api}/v1/dev/accord/${path}`, { headers: { Authorization: `Bearer ${local.token}` }, data: body ?? {} });
  await dev("reset");
  await dev("seed", { device_id: "acc_7d4291008af2", key8: "7d429100" });
  await dev("seed", { device_id: "acc_5f897e8b4bda", key8: "5f897e8b", last_seen_at: Math.floor(Date.now() / 1000) - 180, name: "Salon" });
  await page.goto(`${base}/#token=${local.token}`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await openView(page, "devices").catch(() => {
    throw new StepError("no Devices view on the machine (is the mock started with MOCK_ACCORD=1?)");
  });
  await until(page, "the paired device is listed", () => /7d429100/.test(document.querySelector(".accord-list")?.textContent ?? ""));
  // Name and last connection: the kernel's name (or « ACCORD <key8> »), « 3 min ago », « never connected ».
  const rows = await page.locator("[data-device]").evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-device"), text: e.textContent ?? "" })));
  const salon = rows.find((r) => r.id === "acc_5f897e8b4bda");
  const other = rows.find((r) => r.id === "acc_7d4291008af2");
  if (!salon || !/Salon/.test(salon.text) || !/(3 min ago|il y a 3 min)/.test(salon.text)) throw new StepError(`the named device does not show its name and « 3 min ago »: ${salon?.text}`);
  if (!other || !/ACCORD 7d429100/.test(other.text) || !/(Never connected|Jamais connecté)/.test(other.text)) throw new StepError(`the default name or « never connected » is missing: ${other?.text}`);
  await noOverflow(page, "accord list");
  await shot(page, "accord-list");

  // Rename in place: Enter saves, the list shows the new name; empty goes back to the default name; Escape cancels.
  const first = page.locator('[data-device="acc_7d4291008af2"]');
  await first.locator("button", { hasText: /^(Rename|Renommer)$/ }).click();
  const field = first.locator("input");
  await field.fill("Bureau de Nina");
  await shot(page, "accord-rename");
  await field.press("Enter");
  await until(page, "the new name is shown", () => /Bureau de Nina/.test(document.querySelector('[data-device="acc_7d4291008af2"]')?.textContent ?? ""));
  await first.locator("button", { hasText: /^(Rename|Renommer)$/ }).click();
  await first.locator("input").fill("");
  await first.locator("input").press("Enter");
  await until(page, "back to the default name", () => /ACCORD 7d429100/.test(document.querySelector('[data-device="acc_7d4291008af2"]')?.textContent ?? ""));
  await first.locator("button", { hasText: /^(Rename|Renommer)$/ }).click();
  await first.locator("input").fill("x".repeat(41));
  if (!(await first.locator("button[type=submit]").isDisabled())) throw new StepError("a 41-character name can be sent");
  await first.locator("input").press("Escape");
  if (await first.locator("input").count()) throw new StepError("Escape does not close the rename field");

  // Pairing window: countdown, the machine's characters, "waiting for the device".
  await page.locator("button", { hasText: /Add a device|Ajouter un appareil/ }).click();
  await until(page, "the window is open", () => !!document.querySelector("[data-accord-pairing]"));
  if (!/\d:\d\d/.test(await page.locator(".accord-countdown").innerText())) throw new StepError("no countdown in the pairing window");
  const hostChars = (await page.locator(".accord-fp-chars").first().innerText()).replace(/\s+/g, "");
  if (!/^[0-9a-f]{8}$/.test(hostChars)) throw new StepError(`the machine fingerprint is not 8 hex characters: ${hostChars}`);
  if (!(await page.locator("button[type=submit]").isDisabled())) throw new StepError("the code can be sent before the device has asked to pair");
  await noOverflow(page, "accord waiting");
  await shot(page, "accord-waiting");

  // The device asks: its 8 characters appear next to the machine's, side by side, big.
  await dev("request", { key8: "1a2b3c4d", code: "246810" });
  await until(page, "the device characters appear", () => document.querySelectorAll(".accord-fp-chars").length === 2);
  const boxes = await page.locator(".accord-fp").evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect()));
  if (Math.abs(boxes[0].top - boxes[1].top) > 4) throw new StepError("the two fingerprints are not side by side");
  const size = await page.locator(".accord-fp-chars").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  if (size < 18) throw new StepError(`the fingerprint is not big (${size}px)`);
  // Each fingerprint must fit INSIDE its own box (a clipped character is a wrong comparison).
  const clipped = await page.locator(".accord-fp").evaluateAll((els) => els.filter((e) => { const c = e.querySelector(".accord-fp-chars"); return c && (c.scrollWidth > e.clientWidth - 2 || c.getBoundingClientRect().right > e.getBoundingClientRect().right); }).length);
  if (clipped) throw new StepError("a fingerprint overflows its box");
  if ((await page.locator(".accord-fp-chars").nth(1).innerText()).replace(/\s+/g, "") !== "1a2b3c4d") throw new StepError("the device characters are wrong");
  await noOverflow(page, "accord compare");
  await shot(page, "accord-compare");

  // Wrong code, then the right one.
  await page.fill("#accord-code", "000000");
  await page.locator("button[type=submit]").click();
  await until(page, "the wrong-code message", () => /Wrong code|Code incorrect/.test(document.querySelector("[data-accord-error]")?.textContent ?? ""));
  await shot(page, "accord-wrong-code");
  await page.fill("#accord-code", "246810");
  await page.locator("button[type=submit]").click();
  await until(page, "the device is paired", () => !!document.querySelector("[data-accord-paired]") && /1a2b3c4d/.test(document.querySelector(".accord-list")?.textContent ?? ""));
  await noOverflow(page, "accord paired");
  await shot(page, "accord-paired");

  // Revocation: asks first; Cancel leaves it; confirming revokes.
  const row = page.locator('[data-device]', { hasText: "1a2b3c4d" });
  await row.locator("button", { hasText: /^(Revoke|Révoquer)$/ }).click();
  await until(page, "the confirmation", () => /no longer be able|plus répondre/.test(document.querySelector(".accord-confirm")?.textContent ?? ""));
  await shot(page, "accord-revoke");
  await row.locator("button", { hasText: /Cancel|Annuler/ }).click();
  if (await page.locator(".accord-confirm").count()) throw new StepError("Cancel does not close the confirmation");
  await row.locator("button", { hasText: /^(Revoke|Révoquer)$/ }).click();
  await row.locator("button", { hasText: /Revoke the device|Révoquer l'appareil/ }).click();
  await until(page, "the device is revoked", () => /revoked|révoqué/.test(document.querySelector('[data-device]:nth-child(2)')?.textContent ?? "") || document.querySelectorAll(".accord-device.revoked").length === 1);

  // Window closed: a code now says so; then three wrong codes block the pairing.
  await dev("reset");
  await page.goto("about:blank");
  await page.goto(`${base}/#token=${local.token}`);
  // The app restores the last view (Devices): the composer is then hidden, so wait for either.
  await page.waitForSelector("#nk-composer, .view-devices", { timeout: STEP_MS });
  await openView(page, "devices");
  await page.locator("button", { hasText: /Add a device|Ajouter un appareil/ }).click();
  await until(page, "the window is open again", () => !!document.querySelector("[data-accord-pairing]"));
  await dev("request", { key8: "5e6f7a8b", code: "135790" });
  await until(page, "the device characters appear again", () => document.querySelectorAll(".accord-fp-chars").length === 2);
  for (const bad of ["111111", "222222", "333333"]) {
    await page.fill("#accord-code", bad);
    await page.locator("button[type=submit]").click();
    await page.waitForTimeout(250);
  }
  await until(page, "pairing blocked", () => /blocked for|bloqué pendant/.test(document.body.textContent ?? ""));
  if (!(await page.locator("button", { hasText: /Add a device|Ajouter un appareil/ }).isDisabled())) throw new StepError("Add a device stays enabled while pairing is blocked");
  const blockedMessages = await page.evaluate(() => (document.querySelector("[data-accord]")?.textContent ?? "").split(/blocked for|bloqué pendant/).length - 1);
  if (blockedMessages !== 1) throw new StepError(`the blocked pairing is said ${blockedMessages} times (once, with the countdown)`);
  await noOverflow(page, "accord blocked");
  await shot(page, "accord-blocked");
  await dev("reset");
}

/** Opening a Lokkal WITHOUT the key in the URL: the link carries `#code=<one-time code>` (never the local key). The page
 * clears the fragment before anything else, exchanges the code (no Authorization header) for a SESSION token of its own,
 * and opens. The same link a second time opens nothing and says so (a fresh browser: nothing stored). */
/** Kiosque et présentation par code (noyau p2/integ-kiosk-code) : la portée du code décide où va le jeton. */
async function kioskCode(page, base, t, local) {
  if (!local) return void (t.skipped = "no local token");
  const mint = async (scope) => (await (await page.request.post(`${local.api}/v1/local/session-code`, { headers: { Authorization: `Bearer ${local.token}`, "Content-Type": "application/json" }, data: scope ? { scope } : {} })).json()).code;
  const keys = (pg) => pg.evaluate(() => ({
    kiosk: window.sessionStorage.getItem("nokker.kiosk-token"),
    appSession: window.sessionStorage.getItem("nokker.local-token"),
    appLocal: window.localStorage.getItem("nokker.local-token"),
    scope: window.sessionStorage.getItem("nokker.token-scope"),
    note: window.sessionStorage.getItem("nokker.code-note"),
  }));
  const browser = page.context().browser();
  const fresh = async () => {
    const ctx = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1280, height: 800 } });
    return { ctx, p: await ctx.newPage() };
  };

  // /kiosk + a kiosk code: the kiosk's own key, never the app's; the link leaves the address bar.
  {
    const { ctx, p } = await fresh();
    try {
      const code = await mint("kiosk");
      if (!code) throw new StepError("no kiosk code (is the mock up to date?)");
      const seen = [];
      p.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
      p.on("console", (m) => m.type() === "error" && seen.push(`console: ${m.text()}`));
      await p.goto(`${base}/kiosk#code=${code}`);
      await p.waitForTimeout(2500);
      if (!(await p.locator("[data-kiosk]").count())) throw new StepError(`no kiosk page: ${seen.join(" | ") || "no console error"} (url ${p.url().replace(code, "<code>")}; text ${JSON.stringify((await p.evaluate(() => document.body.innerText)).slice(0, 120))}; kiosk key ${JSON.stringify(await keys(p))})`);
      await p.waitForSelector("[data-kiosk]", { timeout: STEP_MS });
      await until(p, "the kiosk reads its screen", () => document.querySelector("[data-kiosk]")?.getAttribute("data-kiosk") === "ready");
      if (/code=|token=/.test(p.url())) throw new StepError("the code stays in the address bar");
      const k = await keys(p);
      if (!k.kiosk) throw new StepError("no kiosk key kept");
      if (k.appSession || k.appLocal) throw new StepError("the kiosk code became the app key");
      await shot(p, "kiosk-code");
    } finally {
      await ctx.close();
    }
  }
  // /kiosk + an owner code: thrown away, nothing kept, the kiosk says to restart it from the machine.
  {
    const { ctx, p } = await fresh();
    try {
      const ownerCode = await mint();
      await p.goto(`${base}/kiosk#code=${ownerCode}`);
      await p.waitForSelector("[data-kiosk]", { timeout: STEP_MS });
      await until(p, "the kiosk asks for a restart", () => document.querySelector("[data-kiosk]")?.getAttribute("data-kiosk") === "need_key");
      const k = await keys(p);
      if (k.kiosk || k.appSession || k.appLocal) throw new StepError("an owner code opened the kiosk or left a key");
      // The kernel said 409 without using the code: the same code still opens the app on this machine.
      await p.goto(`${base}/#code=${ownerCode}`);
      await p.waitForSelector("#nk-composer", { timeout: STEP_MS });
    } finally {
      await ctx.close();
    }
  }
  // The app + a kiosk code: never the app key.
  {
    const { ctx, p } = await fresh();
    try {
      await p.goto(`${base}/#code=${await mint("kiosk")}`);
      await p.waitForTimeout(1500);
      const k = await keys(p);
      if (k.kiosk || k.appSession || k.appLocal) throw new StepError("a kiosk code became the app key");
      if (k.note !== "scope") throw new StepError(`a kiosk code on the app is not noted as a wrong scope (${k.note})`);
    } finally {
      await ctx.close();
    }
  }
  // /present + a present code: the app key for this tab only, never kept on disk; the scope is remembered.
  {
    const { ctx, p } = await fresh();
    try {
      await p.goto(`${base}/present#code=${await mint("present")}`);
      await p.waitForTimeout(1500);
      if (/code=|token=/.test(p.url())) throw new StepError("the code stays in the address bar");
      const k = await keys(p);
      if (!k.appSession) throw new StepError("no session key kept for the presentation");
      if (k.appLocal) throw new StepError("the presentation key was kept on disk (localStorage)");
      if (k.scope !== "present") throw new StepError(`scope not remembered (${k.scope})`);
      await shot(p, "present-code");
    } finally {
      await ctx.close();
    }
  }
}

async function sessionCode(page, base, t, local) {
  if (!local) return void (t.skipped = "no local token");
  const mint = async () => (await (await page.request.post(`${local.api}/v1/local/session-code`, { headers: { Authorization: `Bearer ${local.token}` } })).json()).code;
  const code = await mint();
  if (!code) throw new StepError("the machine gave no code (is the mock up to date?)");
  const exchanges = [];
  page.on("request", (r) => {
    if (/\/v1\/local\/session-code\/exchange$/.test(r.url())) exchanges.push({ auth: r.headers()["authorization"] ?? null, body: r.postData() });
  });
  await page.goto(`${base}/#code=${code}`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  if (/code=|token=/.test(page.url())) throw new StepError(`the code is still in the address bar: ${page.url().replace(code, "<code>")}`);
  if (exchanges.length !== 1 || exchanges[0].auth) throw new StepError("the exchange must be one request without Authorization");
  const stored = await page.evaluate(() => window.localStorage.getItem("nokker.local-token") ?? window.sessionStorage.getItem("nokker.local-token"));
  if (!stored) throw new StepError("no session token kept after the exchange");
  if (stored === local.token) throw new StepError("the page holds the LOCAL token: a session token of its own was expected");
  await shot(page, "session-code-opened");

  // The same link again, in a fresh browser: used, nothing opens, the page says what to do.
  const browser = page.context().browser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const p2 = await ctx.newPage();
    await p2.goto(`${base}/#code=${code}`);
    // The mock server is not a Lokkal core, so the app does not show the key page there: what is checked here is that the
    // used code opened NOTHING (no token kept), left the address bar, and was noted for the key page (the visible text is
    // covered by test/session-code.test.ts and by the real-core walk-through).
    await p2.waitForTimeout(1500);
    if (/code=/.test(p2.url())) throw new StepError("the used code stays in the address bar");
    const kept = await p2.evaluate(() => ({ token: window.localStorage.getItem("nokker.local-token") ?? window.sessionStorage.getItem("nokker.local-token"), note: window.sessionStorage.getItem("nokker.code-note") }));
    if (kept.token) throw new StepError("a used link opened a session");
    if (kept.note !== "used") throw new StepError(`a used link is not noted as used (${kept.note})`);
  } finally {
    await ctx.close();
  }
}

/** Knock to call (KNOCK.md §7): off by default and nothing listens; switching it on asks for the microphone (refused
 * here: no microphone in a test), the top bar then offers « Listen » again; switched off, the indicator goes. A browser
 * without AudioWorklet (old iOS Safari) greys the setting and says why. No real microphone. */
async function knockSetting(page, base, t) {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("refused", "NotAllowedError"));
  });
  await login(page, base, t);
  await openView(page, "account");
  const card = page.locator("[data-knock-card]");
  await card.waitFor({ timeout: STEP_MS });
  const toggle = card.locator("[data-knock-toggle]");
  if (await toggle.isChecked()) throw new StepError("knock to call is on by default");
  if ((await card.locator("[data-knock-state]").getAttribute("data-knock-state")) !== "off") throw new StepError("the listener is not off by default");
  if (await page.locator("[data-knock-indicator]").count()) throw new StepError("an indicator shows while the setting is off");
  await card.scrollIntoViewIfNeeded();
  await noOverflow(page, "knock setting");
  await shot(page, "knock-setting-light");
  await page.locator(".acct-btn").click();
  await page.locator(".menu-pop .menu-item[aria-pressed]").first().click();
  await until(page, "dark theme on", () => document.documentElement.getAttribute("data-theme") === "dark");
  await page.keyboard.press("Escape");
  await card.scrollIntoViewIfNeeded();
  await shot(page, "knock-setting-dark");
  await toggle.check();
  await until(page, "the refused microphone is said", () => /refused/.test(document.querySelector("[data-knock-card] [role=alert]")?.textContent ?? ""));
  await until(page, "the top bar offers to listen again", () => !!document.querySelector('[data-knock-indicator="off"]'));
  if ((await card.locator("[data-knock-state]").getAttribute("data-knock-state")) !== "off") throw new StepError("a refused microphone left the listener on");
  await noOverflow(page, "knock refused");
  await shot(page, "knock-refused-dark");
  await toggle.uncheck();
  await until(page, "switched off, no indicator", () => !document.querySelector("[data-knock-indicator]"));
  // A browser without AudioWorklet: the setting is greyed with the reason.
  await page.addInitScript(() => {
    window.AudioWorkletNode = undefined;
  });
  await page.reload();
  await openView(page, "account");
  await page.locator("[data-knock-unsupported]").waitFor({ timeout: STEP_MS });
  if (!(await page.locator("[data-knock-toggle]").isDisabled())) throw new StepError("the setting is not greyed without AudioWorklet");
  if (!/AudioWorklet/.test(await page.locator("[data-knock-unsupported]").innerText())) throw new StepError("the reason is not said");
  await page.locator("[data-knock-card]").scrollIntoViewIfNeeded();
  await shot(page, "knock-unsupported-dark");
}

/** Message envoyé depuis un AUTRE client (noyau 1ce737f1, `turn.started.user_message`) : il s'affiche dès le début du tour,
 * puis l'historique le remplace à la fin sans doublon ; coupé à 16 Kio, une ligne le dit. Le mock simule l'autre client
 * (`POST /v1/dev/remote-turn`). */
async function startedMessage(page, base, t, local) {
  if (!local) return void (t.skipped = "no mock api url");
  await login(page, base, t);
  // The other client writes in the thread this page shows (its title is in the conversation's label).
  const title = await page.evaluate(() => (document.querySelector("section.chat")?.getAttribute("aria-label") ?? "").replace(/^.*session\s+/, ""));
  if (!title) throw new StepError("cannot read the current thread's title");
  const remote = async (text, holdMs) => (await page.request.post(`${local.api}/v1/dev/remote-turn`, { data: { text, hold_ms: holdMs, title } })).status();
  const users = (needle) => page.evaluate((n) => [...document.querySelectorAll(".msg.user")].filter((e) => e.textContent.includes(n)).length, needle);

  const text = `from the other client ${tag()}`;
  if ((await remote(text, 3500)) !== 202) throw new StepError("the mock refused the remote turn");
  await until(page, "the other client's message is shown at the start of the turn", (n) => !!document.querySelector("[data-started-message]") && document.body.innerText.includes(n), text);
  if ((await page.locator(".msg.nina").filter({ hasText: "Reply to the other client" }).count()) !== 0) throw new StepError("the reply is already there: the message was not shown BEFORE the turn ended");
  await shot(page, "started-message");
  await until(page, "the history replaces the preview", (n) => !document.querySelector("[data-started-message]") && [...document.querySelectorAll(".msg.nina")].some((e) => e.textContent.includes("Reply to the other client")), text);
  if ((await users(text)) !== 1) throw new StepError(`the message is shown ${await users(text)} times after the turn (expected once)`);

  // Cut at 16 KiB: the preview says so, and the full text from the history replaces it without a duplicate.
  const big = `BIG-${tag()} ` + "word ".repeat(5000);
  await remote(big, 3000);
  await until(page, "the cut message is shown with its note", () => !!document.querySelector("[data-started-message]") && !!document.querySelector(".started-cut"));
  await until(page, "the full history replaces it", () => !document.querySelector("[data-started-message]"));
  if ((await users(big.slice(0, 12))) !== 1) throw new StepError("the long message is duplicated after the turn");
  await noOverflow(page, "started message");
}

/** Mon compte → Langue de l'interface (`PATCH /v1/account {lang}`) : choisir une langue l'écrit sur le compte et recharge l'interface
 * dans cette langue ; « Automatique » rend la main à la détection (le 400 `bad_lang` est couvert par les tests du mock). */
async function accountLang(page, base, t) {
  await login(page, base, t);
  await openView(page, "account");
  const row = page.locator("[data-account-lang]");
  await row.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no language selector on Mon compte");
  });
  const sel = row.locator("select");
  const values = await sel.locator("option").evaluateAll((os) => os.map((o) => o.value));
  if (values.join(",") !== "auto,fr,en") throw new StepError(`unexpected language choices: ${values}`);
  const pick = async (v) => {
    await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: STEP_MS }), sel.selectOption(v)]);
    await page.waitForSelector("[data-account-lang] select", { timeout: STEP_MS });
  };
  await pick("fr");
  await until(page, "the interface is in French", () => document.documentElement.lang === "fr");
  if ((await page.locator("[data-account-lang] select").inputValue()) !== "fr") throw new StepError("the selector does not show the account language");
  await shot(page, "account-lang-fr");
  await pick("en");
  await until(page, "the interface is in English", () => document.documentElement.lang === "en");
  await pick("auto");
  if ((await page.locator("[data-account-lang] select").inputValue()) !== "auto") throw new StepError("Automatic is not kept");
  await noOverflow(page, "account lang");
}

/** Mon compte → Modèles (BYOK cloud, core docs/CLOUD-BYOK.md; mock MOCK_CLOUD_BYOK=open): http refused before any
 * call, a private address refused by the server, a public https endpoint tested, its model added and saved as the
 * default; after a reload it is listed with « key stored » and the key is nowhere on the page; removed, the default
 * goes back to the Router. */
async function models(page, base, t) {
  await login(page, base, t);
  await openView(page, "account");
  const card = page.locator("[data-account-models]");
  await card.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no Models card (is the mock started with MOCK_CLOUD_BYOK=open?)");
  });
  await planButtonsOneLine(page);
  const fr = (await page.evaluate(() => document.documentElement.lang)) === "fr";
  const KEY = "sk-e2e-never-shown-4242";
  const test = async (url, key) => {
    await card.locator("#acc-byok-url").fill(url);
    await card.locator("#acc-byok-key").fill(key);
    await card.locator("button", { hasText: fr ? "Tester" : "Test" }).click();
  };
  await test("http://api.example.com/v1", "");
  await until(page, "http refused", () => /https:\/\//.test(document.querySelector("[data-account-models] .ob-error")?.textContent ?? ""));
  await test("https://192.168.1.4/v1", "");
  await until(page, "private address refused", () => /(public|publique)/.test(document.querySelector("[data-account-models] .ob-error")?.textContent ?? ""));
  await test("https://api.example.com/v1", KEY);
  await card.locator("#acc-byok-model").waitFor({ timeout: STEP_MS });
  if ((await card.locator("#acc-byok-key").inputValue()) !== "") throw new StepError("the key stays in its field after the test");
  await noOverflow(page, "models tested");
  await shot(page, "models-tested");
  await card.locator("button", { hasText: fr ? "Ajouter" : "Add" }).click();
  if (!(await card.locator('input[name="acc-default-model"][value="byok:api-example-com"]').isChecked())) throw new StepError("the added endpoint is not the default");
  await card.locator("button", { hasText: fr ? "Enregistrer" : "Save" }).click();
  await until(page, "saved", () => /(Setting saved|Réglage enregistré)/.test(document.querySelector("[data-account-models]")?.textContent ?? ""));
  await page.reload();
  await card.waitFor({ timeout: STEP_MS });
  await until(page, "listed with its key stored", () => /(key stored|clé rangée)/.test(document.querySelector("[data-account-models]")?.textContent ?? ""));
  if (!(await card.locator('input[name="acc-default-model"][value="byok:api-example-com"]').isChecked())) throw new StepError("the default is not kept after a reload");
  if ((await page.content()).includes(KEY)) throw new StepError("the key is on the page");
  await noOverflow(page, "models saved");
  await shot(page, "models-saved");
  await card.locator(".lk-byok-ok button").click();
  if (!(await card.locator('input[name="acc-default-model"][value="router"]').isChecked())) throw new StepError("removing the default does not fall back to the Router");
  await card.locator("button", { hasText: fr ? "Enregistrer" : "Save" }).click();
  await until(page, "saved without the endpoint", () => /(Setting saved|Réglage enregistré)/.test(document.querySelector("[data-account-models]")?.textContent ?? "") && !document.querySelector("[data-account-models] .lk-byok-ok"));
}

/** Lokkal opened without its local key (LOKKAL §7.1): on 127.0.0.1 served by a Lokkal core, the page explains how to
 * open it (installer link, key file) and never shows the nokker.ai sign-in; a wrong key is refused, the right one opens
 * this core and is kept in localStorage: a NEW tab opens the app without the key page. A revoked key (401, at start or
 * during the session, confirmed by the core) is forgotten and the key page comes back; a 401 about something else keeps
 * the session. `/setup` without the key says the same. On the mock (`localhost`) the sign-in is unchanged. */
async function lokkalKey(page, base, t, local) {
  if (!local?.token) throw new StepError("no local key from the mock");
  const lk = base.replace("//localhost:", "//127.0.0.1:");
  const ctx = page.context();
  // A real core answers /healthz without `mock: true`: the page then asks the core whether it is a Lokkal.
  await ctx.route("**/healthz", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  const keyPage = async (p, what) => {
    await p.locator("[data-local-key-page]").waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError(`no key page: ${what}`);
    });
    if (await p.locator("#wl-email").count()) throw new StepError(`the nokker.ai sign-in shows: ${what}`);
  };
  const t0 = Date.now();
  await page.goto(`${lk}/`);
  await keyPage(page, "Lokkal without key");
  t.lokkalPageMs = Date.now() - t0;
  const text = await page.locator("main").innerText();
  if (/private beta|Apply\b/i.test(text)) throw new StepError("the private beta / Apply shows on a Lokkal");
  // The page offers the one-time code only: the local key never enters a browser (no key file to copy, no key field).
  if (!text.includes(`${lk}/setup`) || !text.includes("nokker open --code")) throw new StepError("the page does not say how to get an opening code");
  if (/local-token|cat ~/.test(text)) throw new StepError("the page still points to the local key file");
  await noOverflow(page, "lokkal without key");
  await shot(page, "lokkal-key-light");
  // `/setup` without the key: locked, with the same help.
  const setup = await ctx.newPage();
  await setup.goto(`${lk}/setup`);
  await setup.locator("[data-local-key]").waitFor({ timeout: STEP_MS });
  if (await setup.locator("#wl-email").count()) throw new StepError("the sign-in shows on /setup without the key");
  await noOverflow(setup, "setup without key");
  await shot(setup, "lokkal-setup-locked");
  await setup.close();
  await page.fill("#lk-key-input", "not-this-machine");
  await page.locator("[data-local-key] button[type=submit]").click();
  await page.locator('[data-local-key-error="wrong"]').waitFor({ timeout: STEP_MS });
  await shot(page, "lokkal-key-wrong");
  // The local key pasted out of habit is refused and never kept.
  await page.fill("#lk-key-input", local.token);
  await page.locator("[data-local-key] button[type=submit]").click();
  await page.locator('[data-local-key-error="wrong"]').waitFor({ timeout: STEP_MS });
  if ((await page.evaluate(() => localStorage.getItem("nokker.local-token") ?? sessionStorage.getItem("nokker.local-token"))) !== null) throw new StepError("the local key was kept by the key page");
  // A code from `nokker open --code` opens it, with a session key of its own (never the local key).
  const code = (await (await page.request.post(`${local.api}/v1/local/session-code`, { headers: { Authorization: `Bearer ${local.token}` } })).json()).code;
  await page.fill("#lk-key-input", code);
  await page.locator("[data-local-key] button[type=submit]").click();
  await until(page, "the code opens this Lokkal", () => (location.pathname === "/setup" || location.pathname === "/") && !document.querySelector("[data-local-key]"));
  const kept = await page.evaluate(() => localStorage.getItem("nokker.local-token"));
  if (!kept) throw new StepError("no session key kept after the code");
  if (kept === local.token) throw new StepError("the page holds the LOCAL key: a session key of its own was expected");
  const sessionKey = kept;
  // A new tab on the same machine: the kept key opens the app, no key page.
  const tab = await ctx.newPage();
  await tab.goto(`${lk}/`);
  await tab.waitForSelector("#nk-composer", { timeout: STEP_MS }).catch(() => {
    throw new StepError("a new tab with a kept key does not open the app");
  });
  if (await tab.locator("[data-local-key-page]").count()) throw new StepError("the key page shows with a kept key");
  // During the session, a 401 about something else (the core still accepts the key): the session stays.
  const fail401 = (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"message":"refused"}}' });
  await tab.route("**/v1/chat/completions", fail401);
  const probe = tab.waitForResponse((r) => r.url().includes("/v1/local/setup"), { timeout: STEP_MS });
  await tab.fill("#nk-composer", "hello");
  await tab.click("button.send");
  if ((await probe).status() !== 200) throw new StepError("the key check did not accept the kept key");
  await tab.waitForTimeout(300);
  if (await tab.locator("[data-local-key-page]").count()) throw new StepError("a 401 about something else closed the session");
  if ((await tab.evaluate(() => localStorage.getItem("nokker.local-token"))) !== sessionKey) throw new StepError("a 401 about something else forgot the key");
  await tab.unroute("**/v1/chat/completions");
  // Key revoked while the tab stays open (install reset): the core refuses it everywhere → forgotten, key page.
  await tab.route("**/v1/**", fail401);
  await tab.fill("#nk-composer", "hello again");
  await tab.click("button.send");
  await keyPage(tab, "key revoked during the session");
  if ((await tab.evaluate(() => localStorage.getItem("nokker.local-token"))) !== null) throw new StepError("the key revoked during the session is not forgotten");
  await shot(tab, "lokkal-key-revoked-live");
  await tab.unroute("**/v1/**");
  // Revoked key (401): forgotten, the key page comes back.
  await tab.evaluate(() => localStorage.setItem("nokker.local-token", "revoked-key"));
  await tab.reload();
  await keyPage(tab, "revoked key");
  if ((await tab.evaluate(() => localStorage.getItem("nokker.local-token"))) !== null) throw new StepError("the revoked key is not forgotten");
  await tab.close();
  // Cloud mode unchanged: the mock (demo) on localhost keeps the nokker.ai sign-in.
  await ctx.unroute("**/healthz");
  const cloud = await ctx.newPage();
  await cloud.goto(base);
  await cloud.waitForSelector("#wl-email", { timeout: STEP_MS });
  if (await cloud.locator("[data-local-key-page]").count()) throw new StepError("the Lokkal page shows in cloud mode");
  await cloud.close();
}

// ---------- main ----------

/** « Ta carte » on the Lokkal machine (PAY-AGENT §11, own_card): a « to pay » card flagged `local_passkey` is approved
 * HERE with the machine's passkey (virtual authenticator, rpId localhost): first without a passkey (the card says to
 * create one in My account), then signed. A « to pay » card that is not own_card keeps its strong-card text, no
 * passkey button. */
async function ownCard(page, base, t, local) {
  if (!local?.api) return void (t.skipped = "no local token");
  const api = async (path, body) => {
    const r = await fetch(`${local.api}${path}`, { method: "POST", headers: { Authorization: `Bearer ${local.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new StepError(`${path}: HTTP ${r.status}`);
    return r.json();
  };
  await page.goto(`${base}/#token=${local.token}`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  const own = await api("/v1/dev/owncard-card", {});
  await page.goto(`${base}/approvals/${own.approval_id}`);
  const box = page.locator("[data-local-passkey]");
  await box.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « Approve with my passkey » on an own_card card");
  });
  const card = page.locator(".bubble-body").first();
  await until(page, "the purchase shown", () => /Papeterie Centrale/.test(document.querySelector(".pay-block")?.textContent ?? ""));
  // One text for the person, own_card: never the reason written for the model, never the generic « saved payment method ».
  if (await page.locator(".bubble-body .notify-text").count()) throw new StepError("a « to pay » card shows the reason written for the model");
  const note = await page.locator(".pay-note").innerText();
  if (!/own card|propre carte/.test(note) || /saved payment method|moyen de paiement enregistré/.test(note)) throw new StepError(`the « to pay » note is not the own-card one: « ${note} »`);
  if (/nokker\.ai|phone|terminal/i.test(await card.innerText())) throw new StepError("an own_card card speaks of nokker.ai, the phone or the terminal");
  await noOverflow(page, "own card");
  // Chromium sometimes refuses the very first capture of a freshly loaded phone page: one more try.
  await shot(page, "owncard-card").catch(async () => {
    await page.waitForTimeout(300);
    await shot(page, "owncard-card");
  });
  // No passkey on the machine yet (first journey on this mock): said on the card, with the way to My account.
  const keys = await (await fetch(`${local.api}/v1/local/passkeys`, { headers: { Authorization: `Bearer ${local.token}` } })).json();
  if (!keys.passkeys?.length) {
    await box.locator("[data-lp=approve]").click();
    await until(page, "no passkey said", () => document.querySelector("[data-lp-error]")?.getAttribute("data-lp-error") === "no_passkey" && !!document.querySelector("[data-lp-error] a"));
    await shot(page, "owncard-no-passkey");
  }
  // The machine's passkey: a virtual authenticator holding a P-256 key, registered with the core (mock only route).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credId = Buffer.from(`e2e-${tag()}`);
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: credId.toString("base64"), isResidentCredential: false, rpId: "localhost", privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), signCount: 0 } });
  await api("/v1/dev/local-passkey", { credential_id: credId.toString("base64url"), public_key_spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url") });
  await box.locator("[data-lp=approve]").click();
  await until(page, "the card is approved", () => !document.querySelector("[data-local-passkey]") && /approved|approuvée/.test(document.querySelector(".bubble-body .chip")?.textContent ?? ""));
  await shot(page, "owncard-approved");
  if (/token|jeton/i.test(await page.locator(".pay-block").innerText())) throw new StepError("an own_card payment speaks of a token");
  // The turn that follows the decision (`[Approbation]` block, `origin: "approval"`): a discreet line in the thread,
  // never a message of the person, nothing of the instructions written for the model.
  await page.goto(`${base}/`);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  const fab = page.locator(".drawer-fab");
  if (await fab.isVisible()) await fab.click();
  await page.locator("button.session-row", { hasText: "Shopping (demo)" }).first().click();
  if (await fab.isVisible()) await page.keyboard.press("Escape");
  await until(page, "the decision line", () => !!document.querySelector(".msg.system[data-continuation]"));
  const line = await page.locator(".msg.system[data-continuation]").last().innerText();
  if (!/Payment approved|Paiement approuvé/.test(line)) throw new StepError(`the decision line says « ${line} »`);
  if (await page.locator(".msg.user", { hasText: "Approbation" }).count()) throw new StepError("the [Approbation] block is shown as a message of the person");
  if (/ne la relance pas|ne saisis aucun/i.test(await page.locator(".chat-scroll, main").first().innerText())) throw new StepError("instructions written for the model are visible");
  // The approval bubble of the card: a human title in the interface language (never the raw tool name), one badge.
  const titles = await page.locator("article[data-bubble-id] .bubble-title").allInnerTexts();
  if (titles.some((x) => /pay_request|approved:/i.test(x))) throw new StepError(`an approval bubble is titled with the tool: « ${titles.join(" | ")} »`);
  if (!titles.some((x) => /Payment approved|Paiement approuvé/i.test(x))) throw new StepError(`no « Payment approved » bubble title: « ${titles.join(" | ")} »`);
  const pay = page.locator("article[data-bubble-id]", { has: page.locator(".pay-block") }).first();
  if ((await pay.locator(".chip", { hasText: /^(approved|approuvée)$/ }).count()) > 1) throw new StepError("the « approved » badge appears twice on the « to pay » card");
  await shot(page, "owncard-thread");
  // Any other « to pay » card: unchanged (no local signature, the strong-card text).
  const other = await api("/v1/dev/owncard-card", { own_card: false });
  await page.goto(`${base}/approvals/${other.approval_id}`);
  await until(page, "the other card", () => !!document.querySelector(".pay-block, .bubble-body .notify-text"));
  await until(page, "strong-card text", () => /Action forte/.test(document.querySelector(".bubble-body")?.textContent ?? ""));
  if (await page.locator("[data-local-passkey]").count()) throw new StepError("a « to pay » card that is not own_card offers the local passkey");
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
}

/** « Listen » to a reply (speaker, core p2/tts-stream; mock with MOCK_TTS=1): the button is on Nina's reply, playing
 * starts while the audio still arrives (chunks), pause, resume, the end brings it back; with the keyboard too. The
 * request carries no text: the server reads the reply itself. */
async function listen(page, base, t) {
  await login(page, base, t);
  const fr = (await page.evaluate(() => document.documentElement.lang)) === "fr";
  await newSession(page, `e2e listen ${tag()}`);
  const bodies = [];
  page.on("request", (r) => /\/messages\/\d+\/speech$/.test(r.url()) && bodies.push(r.postData() ?? ""));
  await send(page, "hello", "");
  const box = page.locator(".msg.nina .listen").last();
  await box.waitFor({ timeout: STEP_MS }).catch(() => {
    throw new StepError("no « Listen » button on Nina's reply (is the mock started with MOCK_TTS=1?)");
  });
  const btn = box.locator(".listen-btn");
  if ((await btn.getAttribute("aria-label")) !== (fr ? "Écouter cette réponse" : "Listen to this reply")) throw new StepError(`aria-label « ${await btn.getAttribute("aria-label")} »`);
  await noOverflow(page, "listen button");
  await shot(page, "listen-idle");
  await btn.click();
  await until(page, "playing", () => [...document.querySelectorAll(".listen")].some((x) => x.getAttribute("data-listen") === "playing"));
  if ((await btn.getAttribute("aria-pressed")) !== "true") throw new StepError("aria-pressed is not true while playing");
  // Chromium has MediaSource for MP3: playing must start while the audio still arrives, not after the whole file.
  if ((await box.getAttribute("data-listen-mode")) !== "stream") throw new StepError(`not played as a stream: « ${await box.getAttribute("data-listen-mode")} »`);
  await shot(page, "listen-playing");
  await btn.click();
  await until(page, "paused", () => [...document.querySelectorAll(".listen")].some((x) => x.getAttribute("data-listen") === "paused"));
  await btn.click();
  await until(page, "playing again", () => [...document.querySelectorAll(".listen")].some((x) => x.getAttribute("data-listen") === "playing"));
  await until(page, "back to « Listen » at the end", () => [...document.querySelectorAll(".listen")].every((x) => x.getAttribute("data-listen") === "idle"));
  // Keyboard: Enter starts, Space pauses.
  await btn.focus();
  await page.keyboard.press("Enter");
  await until(page, "playing (keyboard)", () => [...document.querySelectorAll(".listen")].some((x) => x.getAttribute("data-listen") === "playing"));
  await page.keyboard.press("Space");
  await until(page, "paused (keyboard)", () => [...document.querySelectorAll(".listen")].some((x) => x.getAttribute("data-listen") === "paused"));
  if (!bodies.length) throw new StepError("no speech request seen");
  const reply = await page.locator(".msg.nina .msg-body").last().innerText();
  const words = reply.split(/\s+/).filter((w) => w.length > 4).slice(0, 3);
  if (bodies.some((b) => words.some((w) => b.includes(w)))) throw new StepError(`the speech request carries text of the reply: ${bodies[0]}`);
}

async function main() {
  const only = process.env.E2E_ONLY;
  let base = process.env.E2E_BASE_URL;
  let stop = () => {};
  let local = process.env.E2E_LOCAL_TOKEN ? { token: process.env.E2E_LOCAL_TOKEN, cwd: process.env.E2E_LOCAL_CWD, api: process.env.E2E_API_URL } : null;
  if (!base) ({ base, stop, local } = await startServers());
  const browser = await chromium.launch({ headless: !process.env.E2E_HEADED });
  if (!PREVIEW) await warmUp(browser, base);
  const journeys = [
    ["desktop", DESKTOP, desktop],
    ["phone", PHONE, phone],
    ["small-phone", SMALL_PHONE, phone],
    ["phone-fr", { ...SMALL_PHONE, locale: "fr-CH" }, phoneFr], // French labels are longer: same overflow checks
    // Before `modes`: its local session (Lokkal) is not readable by the account, and would become the latest thread.
    ["navigation", DESKTOP, navigation],
    ["palette-settings", { ...DESKTOP, locale: "fr-CH" }, paletteSettings],
    ["navigation-phone", PHONE, navigation],
    ["modes", DESKTOP, modes],
    ["modes-busy", DESKTOP, modesBusy],
    ["folder", PHONE, folder],
    ["kiosk-code", DESKTOP, kioskCode],
    ["lokkal-account", DESKTOP, lokkalAccount],
    ["turn-notice", DESKTOP, turnNotice],
    ["approval-target", DESKTOP, approvalTarget],
    ["approval-target-phone", PHONE, approvalTarget],
    ["accord", DESKTOP, accord],
    ["quota", DESKTOP, quota],
    ["quota-phone", PHONE, quota],
    ["accord-phone", PHONE, accord],
    ["accord-fr", { ...PHONE, locale: "fr-CH" }, accord],
    ["session-code", DESKTOP, sessionCode],
    ["glance", GLASSES, glance],
    ["cast", DESKTOP, cast],
    ["artifact", DESKTOP, artifact],
    ["house", PHONE, house],
    ["presence", DESKTOP, presence],
    ["presence-phone", PHONE, presence],
    ["presence-phone-fr", { ...PHONE, locale: "fr-CH" }, presence],
    ["consolidation", DESKTOP, consolidation],
    ["long-memory", DESKTOP, longMemory],
    ["payments", DESKTOP, payments],
    ["auto-review", PHONE, autoReview],
    ["auto-review-fr", { ...DESKTOP, locale: "fr-CH" }, autoReview],
    ["listen", PHONE, listen],
    ["listen-fr", { ...DESKTOP, locale: "fr-CH" }, listen],
    ["own-card", PHONE, ownCard],
    ["own-card-fr", { ...DESKTOP, locale: "fr-CH" }, ownCard],
    ["budgets", SMALL_PHONE, budgets],
    ["voucher", PHONE, voucher],
    ["voucher-fr", { ...PHONE, locale: "fr-CH" }, voucher],
    ["voucher-off", PHONE, voucherOff],
    ["trial-cancelled", PHONE, trialCancelled],
    ["trial-cancelled-fr", { ...PHONE, locale: "fr-CH" }, trialCancelled],
    ["models", PHONE, models],
    ["started-message", DESKTOP, startedMessage],
    ["account-lang", DESKTOP, accountLang],
    ["models-fr", { ...DESKTOP, locale: "fr-CH" }, models],
    ["glance-pair", PHONE, glancePair],
    ["knock", PHONE, knockSetting],
    ["lokkal-key", PHONE, lokkalKey],
    ["showme", DESKTOP, (p, b, t) => showMe(p, b, t, "desktop-en")],
    ["showme-phone", PHONE, (p, b, t) => showMe(p, b, t, "phone-dark-en")],
    ["showme-fr", { ...DESKTOP, locale: "fr-CH" }, (p, b, t) => showMe(p, b, t, "desktop-fr")],
    ["showme-phone-fr", { ...PHONE, locale: "fr-CH" }, (p, b, t) => showMe(p, b, t, "phone-dark-fr")],
  ].filter(([n]) => !only || only.split(",").includes(n) || (only === "mobile" && n.endsWith("phone")));
  const report = [];
  for (const [name, device, fn] of journeys) {
    const ctx = await browser.newContext({ locale: "en-US", ...device });
    const page = await ctx.newPage();
    const problems = [];
    const timings = {};
    watch(page, problems);
    const t0 = Date.now();
    let error = null;
    try {
      await fn(page, base, timings, local);
    } catch (e) {
      error = e instanceof StepError ? e.message : String(e?.stack ?? e);
      await shot(page, `${name}-FAILED`);
    }
    const ok = !error && problems.length === 0;
    report.push({ journey: name, ok, ms: Date.now() - t0, timings, error, problems: [...new Set(problems)] });
    await ctx.close();
  }
  await browser.close();
  stop();
  for (const r of report) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.journey} (${r.ms} ms) ${JSON.stringify(r.timings)}`);
    if (r.error) console.log(`  step: ${r.error}`);
    for (const p of r.problems) console.log(`  ${p}`);
  }
  process.exit(report.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
