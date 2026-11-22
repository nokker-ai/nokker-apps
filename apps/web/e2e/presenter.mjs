/**
 * Recette « Nina présentatrice » (V3 +, drapeau browser_live_presenter : allumé ici par localStorage
 * nokker.web.presenter = "1") sur le mock (MOCK_BROWSER_LIVE=1), scène « logement » :
 *  1. dans la bulle navigateur : l'encadré de Nina, ses bulles d'explication (la désignation « why » : 138 €/nuit),
 *     le faisceau et le halo sur l'annonce désignée ;
 *  2. /present/{session} en 1920×1080 : la page en fond, Nina à droite, halo sur la même annonce, sous-titres ;
 *     aucun micro demandé, aucun composeur ;
 *  3. drapeau éteint : aucune trace de la présentatrice dans la bulle.
 * Usage : `node e2e/presenter.mjs` (E2E_SHOTS=<dossier>).
 */
import { chromium } from "playwright-core";
import { login, servers, shot, STEP_MS, StepError, until, watch } from "./phone-shell.mjs";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const s = await servers({ MOCK_BROWSER_LIVE: "1", MOCK_BROWSER_STEP_MS: "500" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" });
await ctx.addInitScript(() => localStorage.getItem("nokker.web.presenter") === null && localStorage.setItem("nokker.web.presenter", "1"));
const page = await ctx.newPage();
const problems = [];
watch(page, problems);
let mic = 0;
await ctx.exposeFunction("__micAsked", () => (mic += 1));
await ctx.addInitScript(() => {
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) navigator.mediaDevices.getUserMedia = (c) => (window.__micAsked?.(), gum(c));
});
try {
  await login(page, s.base);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.fill("#nk-composer", "trouve un logement pour 4 avec balcon");
  await page.click("button.send");
  const b = page.locator("[data-brw-session]").first();
  await b.waitFor({ timeout: STEP_MS });
  await until(page, "halo sur l'annonce désignée", () => !!document.querySelector("[data-brw-session] [data-np-halo]"));
  await until(page, "bulle « why » de Nina", () => /138 €\/nuit/.test(document.querySelector("[data-brw-session] [data-np-bubbles]")?.textContent ?? ""));
  if (!(await b.locator("[data-np-frame]").count())) throw new StepError("pas d'encadré de Nina dans la bulle");
  if (!(await b.locator("[data-np-beam]").count())) throw new StepError("pas de faisceau vers la cible");
  await shot(page, "presenter-bubble-desktop-light-fr");
  const sid = await b.getAttribute("data-brw-session");
  // 2. Grand écran 16:9.
  const big = await ctx.newPage();
  watch(big, problems);
  await big.setViewportSize({ width: 1920, height: 1080 });
  await big.goto(`${s.base}/present/${sid}`);
  await big.waitForSelector(`[data-present-session="${sid}"]`, { timeout: STEP_MS });
  await until(big, "halo sur le grand écran", () => !!document.querySelector(".present [data-np-halo]"));
  await until(big, "sous-titres", () => (document.querySelector("[data-present-caption]")?.textContent ?? "").trim().length > 0);
  if (await big.locator("#nk-composer").count()) throw new StepError("un composeur sur le grand écran");
  await shot(big, "presenter-stage-1920");
  await big.close();
  // 2b. Le vrai site de démo (séjours.test, enregistré par le navigateur du pool) : halo sur l'annonce Alfama.
  await page.fill("#nk-composer", "trouve un logement à Lisbonne pour 4");
  await page.click("button.send");
  await until(page, "session Lisbonne", () => [...document.querySelectorAll("[data-brw-session]")].some((b) => /Lisbonne/.test(b.textContent ?? "")));
  const lis = page.locator("[data-brw-session]", { hasText: "Lisbonne" }).first();
  const lsid = await lis.getAttribute("data-brw-session");
  const big2 = await ctx.newPage();
  watch(big2, problems);
  await big2.setViewportSize({ width: 1920, height: 1080 });
  await big2.goto(`${s.base}/present/${lsid}`);
  await until(big2, "halo sur Alfama", () => !!document.querySelector(".present [data-np-halo]") && (document.querySelector("[data-np-bubbles]")?.textContent ?? "").includes("Alfama"));
  await big2.waitForTimeout(900);
  await shot(big2, "presenter-stage-lisbonne-1920");
  await big2.close();
  if (mic) throw new StepError(`le micro a été demandé ${mic} fois`);
  // 3. Drapeau éteint : la bulle reste celle de V3.
  await page.evaluate(() => localStorage.setItem("nokker.web.presenter", "0"));
  await page.reload();
  // Le rechargement peut rouvrir un autre fil (une notification d'une autre session) : on revient au fil de la scène.
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  if (!(await page.locator("[data-brw-session]").count())) await page.locator(".session-row", { hasText: "General" }).first().click();
  await page.locator("[data-brw-session]").first().waitFor({ timeout: STEP_MS });
  await page.waitForTimeout(800);
  if (await page.locator("[data-brw-session] [data-np]").count()) throw new StepError("présentatrice visible drapeau éteint");
  if (problems.length) throw new StepError(problems.slice(0, 3).join(" | "));
  report.push("ok   presenter desktop-light-fr + stage 1920");
} catch (e) {
  failed++;
  report.push(`FAIL presenter: ${e.message}`);
  await shot(page, "FAIL-presenter").catch(() => {});
} finally {
  await ctx.close();
  s.stop();
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
