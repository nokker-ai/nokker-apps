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
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const MOCK = resolve(WEB, "../../packages/mock-server");
const EMAIL = "alice@example.com";
const CODE = "123456"; // MOCK_EMAIL_CODE
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 15000);
const PREVIEW = !!process.env.E2E_PREVIEW;
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : null;

/** 4xx that are part of the contract: feature probes off by default, local-only routes outside Lokkal. */
const ALLOWED_4XX = [
  [404, /\/v1\/(packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|payments\/budgets|payments\/mandates|local\/folder\/runs)(\?|$)/],
  [401, /\/v1\/local\//],
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
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_LOCAL_ROOTS: work, MOCK_CAST: "1", MOCK_HOUSE_ROOM: "1", MOCK_WHO_DOES_WHAT: "1", MOCK_CONSOLIDATION: "1", MOCK_PAYMENTS: "1", MOCK_FOLDER: "1", MOCK_SHOW_ME: "1", MOCK_GUIDE: "1" };
  if (PREVIEW) {
    // VITE_* flags are read at build time: « show me » must be on in the built web too, not only for `vite preview`.
    const b = spawnSync("npx", ["vite", "build"], { cwd: WEB, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, VITE_NOKKER_SHOW_ME: process.env.VITE_NOKKER_SHOW_ME ?? "1", VITE_NOKKER_GUIDE: process.env.VITE_NOKKER_GUIDE ?? "1" } });
    if (b.status !== 0) throw new Error("vite build failed");
  }
  const procs = [
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("npx", [...(PREVIEW ? ["vite", "preview"] : ["vite"]), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], {
      cwd: WEB,
      // « Show me » is a build flag (VITE_NOKKER_SHOW_ME), off by default: on here so its journey runs.
      env: { ...process.env, NOKKER_SERVER_URL: `http://127.0.0.1:${mockPort}`, VITE_NOKKER_SHOW_ME: process.env.VITE_NOKKER_SHOW_ME ?? "1", VITE_NOKKER_GUIDE: process.env.VITE_NOKKER_GUIDE ?? "1" },
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

async function noOverflow(page, where) {
  const o = await overflow(page);
  if (o.length) throw new StepError(`horizontal overflow on ${where}: ${o.join(" | ")}`);
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
  const users = await page.$$eval(".msg.user", (els) => els.length);
  await page.click(".mode-apply");
  await until(page, "plan mode lifted", () => !document.querySelector(".mode-bar")?.classList.contains("is-plan"));
  await until(page, "the plan is asked for", (n) => document.querySelectorAll(".msg.user").length > n, users);
  // Leave the local session at rest: the next journey opens the latest local thread, and a turn still running there
  // answers its first calls with 409 (turn_running).
  await until(page, "the turn is over", () => !!document.querySelector(".topbar") && !document.querySelector(".topbar.working"));
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
  if (!/Papeterie Centrale/.test(text) || !/59\.80 CHF/.test(text)) throw new StepError(`the purchase is not shown: « ${text.slice(0, 80)} »`);
  if (!/Only a passkey approves/.test(text)) throw new StepError("no « only a passkey approves »");
  const card = block.locator("xpath=ancestor::div[contains(@class,'bubble-body')][1]");
  if (await card.locator("form.totp").count()) throw new StepError("a TOTP form on a « to pay » card");
  await noOverflow(page, "to pay card");
  await shot(page, "pay-card");
  await openView(page, "account");
  const spending = page.locator(".pay-card");
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
async function budgets(page, base, t) {
  await login(page, base, t);
  await openView(page, "account");
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
  await until(page, "own budget saved", () => /own budget/.test(document.querySelector(".pay-lines > li")?.textContent ?? "") && /80\.00 CHF per purchase/.test(document.querySelector(".pay-lines > li")?.textContent ?? ""));
  await shot(page, "budget-saved");
  await me.locator("button", { hasText: "Change" }).click();
  await me.locator("button", { hasText: "Back to the default budget" }).click();
  await until(page, "back to the default budget", () => /default budget/.test(document.querySelector(".pay-lines > li")?.textContent ?? ""));
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

/** Lokkal opened without its local key (LOKKAL §7.1): on 127.0.0.1 served by a Lokkal core, the page explains how to
 * open it (installer link, key file) and never shows the nokker.ai sign-in; a wrong key is refused, the right one opens
 * this core and is kept in localStorage: a NEW tab opens the app without the key page. A revoked key (401) is forgotten
 * and the key page comes back. `/setup` without the key says the same. On the mock (`localhost`) the sign-in is unchanged. */
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
  if (!text.includes(`${lk}/setup`) || !text.includes("~/.nokker/state/local-token")) throw new StepError("the page does not say where the key is");
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
  await page.fill("#lk-key-input", local.token);
  await page.locator("[data-local-key] button[type=submit]").click();
  await until(page, "the key opens this Lokkal", () => (location.pathname === "/setup" || location.pathname === "/") && !document.querySelector("[data-local-key]"));
  if ((await page.evaluate(() => localStorage.getItem("nokker.local-token"))) !== local.token) throw new StepError("the key is not kept in localStorage");
  // A new tab on the same machine: the kept key opens the app, no key page.
  const tab = await ctx.newPage();
  await tab.goto(`${lk}/`);
  await tab.waitForSelector("#nk-composer", { timeout: STEP_MS }).catch(() => {
    throw new StepError("a new tab with a kept key does not open the app");
  });
  if (await tab.locator("[data-local-key-page]").count()) throw new StepError("the key page shows with a kept key");
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
    ["navigation-phone", PHONE, navigation],
    ["modes", DESKTOP, modes],
    ["folder", PHONE, folder],
    ["glance", GLASSES, glance],
    ["cast", DESKTOP, cast],
    ["house", PHONE, house],
    ["presence", DESKTOP, presence],
    ["presence-phone", PHONE, presence],
    ["presence-phone-fr", { ...PHONE, locale: "fr-CH" }, presence],
    ["consolidation", DESKTOP, consolidation],
    ["payments", DESKTOP, payments],
    ["budgets", SMALL_PHONE, budgets],
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
