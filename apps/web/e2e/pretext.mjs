/**
 * Recette V5 (Pretext, drapeau localStorage nokker.web.pretext) : pendant un flux lent (MOCK_WORD_MS) de la réponse de
 * Nokker, drapeau ALLUMÉ le bloc passe en data-pretext="on" et sa hauteur glisse (plusieurs paliers) sans jamais couper
 * le texte AU REPOS (aucun style de hauteur posé, aucune animation en cours : hauteur réelle) ; drapeau ÉTEINT : jamais « on », rien de chargé. Captures avant/après (E2E_SHOTS).
 * Usage : `node e2e/pretext.mjs [dossier de captures]`.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { login, servers, STEP_MS } from "./phone-shell.mjs";
const OUT = process.argv[2] ?? process.env.E2E_SHOTS ?? "/tmp/pretext-shots"; mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const s = await servers({ NOKKER_MOCK_THINK_MS: "0", MOCK_WORD_MS: "260" });
const rows = [];
for (const scheme of ["light", "dark"]) for (const flag of ["0", "1"]) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, colorScheme: scheme, locale: "fr-CH" });
  await ctx.addInitScript((f) => localStorage.setItem("nokker.web.pretext", f), flag);
  const page = await ctx.newPage();
  await login(page, s.base);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.evaluate(() => {
    window.__h = []; let last = -1;
    window.__clip = 0; let lastChange = performance.now(); const tick = () => { const el = [...document.querySelectorAll(".msg.nina .msg-body")].at(-1); if (el && el.getAttribute("data-pretext") === "on" && el.getAnimations().length === 0 && performance.now() - lastChange > 350 && el.scrollHeight - el.getBoundingClientRect().height > 2) { window.__clip++; window.__cd = window.__cd || [el.getAnimations().map((a) => [a.playState, Math.round(a.currentTime ?? -1), a.pending, a.effect.getTiming().duration].join("/")).join(";"), document.visibilityState, el.scrollHeight, Math.round(el.getBoundingClientRect().height * 10) / 10, el.textContent.length, el.style.height, performance.now() - lastChange]; } const h = el ? el.getBoundingClientRect().height : -1; if (h !== last) { lastChange = performance.now(); window.__h.push([Math.round(performance.now()), Math.round(h * 10) / 10, el?.getAttribute("data-pretext") ?? "-"]); last = h; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.fill("#nk-composer", "Dis-moi en une phrase ce que tu peux faire pour moi.");
  await page.click("button.send");
  await page.waitForSelector(".msg.nina .msg-body", { timeout: STEP_MS });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${OUT}/pretext-${flag === "1" ? "apres" : "avant"}-${scheme}.png` });
  await page.waitForTimeout(5000);
  const h = await page.evaluate(() => window.__h);
  const body = await page.evaluate(() => [...document.querySelectorAll(".msg.nina .msg-body")].at(-1)?.textContent ?? "");
  const deltas = h.slice(1).map((x, i) => Math.abs(x[1] - h[i][1])).filter((d) => d > 0);
  const clipped = await page.evaluate(() => window.__clip); if (clipped) console.log("clip detail", JSON.stringify(await page.evaluate(() => window.__cd)));
  rows.push({ scheme, flag, clipped, steps: h.length, maxJump: Math.max(0, ...deltas), jumps8: deltas.filter((d) => d > 8).length, mode: [...new Set(h.map((x) => x[2]))].join("/"), text: body.slice(0, 200) });
  await ctx.close();
}
console.table(rows);
s.stop(); await browser.close();
const on = rows.filter((r) => r.flag === "1"), off = rows.filter((r) => r.flag === "0");
const errs = [];
if (!on.every((r) => r.mode.includes("on"))) errs.push("drapeau allumé : le bloc n'est jamais passé en « on »");
if (off.some((r) => r.mode.includes("on"))) errs.push("drapeau éteint : « on » vu");
if (!on.every((r) => r.clipped === 0)) errs.push("texte coupé pendant le glissement");
if (errs.length) { console.log("FAIL pretext: " + errs.join(" | ")); process.exit(1); }
console.log("ok   pretext (flux : on/off, jamais coupé)");
