/**
 * Recette de /present SANS identifiant (mode démo : localStorage nokker.web.present.live) sur le mock (MOCK_BROWSER_LIVE=1) :
 *  1. attente propre (lion, orbe, « Nina te montrera ici ce qu'elle fait. ») tant qu'aucune session navigateur n'est active ;
 *  2. quand Nina ouvre le navigateur (session lancée depuis un autre onglet), bascule SANS rien toucher sur sa session ;
 *  3. à la fin de la session, retour à l'attente (après la tenue de l'écran final) ;
 *  4. une page ouverte PENDANT une session déjà en cours la trouve (balayage des bulles) ;
 *  5. drapeau éteint : pas de suivi (message habituel), aucune requête de balayage.
 * Usage : `E2E_PREVIEW=1 node e2e/present-follow.mjs` (E2E_SHOTS=<dossier>).
 */
import { chromium } from "playwright-core";
import { login, servers, shot, STEP_MS, StepError, until, watch } from "./phone-shell.mjs";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const s = await servers({ MOCK_BROWSER_LIVE: "1", MOCK_BROWSER_STEP_MS: "400", MOCK_BROWSER_STAY_MS: "5000" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" });
await ctx.addInitScript(() => localStorage.getItem("nokker.web.presenter") === null && localStorage.setItem("nokker.web.presenter", "1"));
const page = await ctx.newPage();
const problems = [];
watch(page, problems);
const open = async (demo) => {
  const p = await ctx.newPage();
  watch(p, problems);
  await p.addInitScript((d) => localStorage.setItem("nokker.web.present.live", d), demo);
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto(`${s.base}/present`);
  return p;
};
try {
  await login(page, s.base);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  // 1. Attente.
  const tv = await open("1");
  await tv.waitForSelector("[data-present-wait]", { timeout: STEP_MS });
  const w = await tv.evaluate(() => ({ text: document.querySelector(".present-wait-text")?.textContent ?? "", lion: !!document.querySelector(".present-lion"), orb: !!document.querySelector(".present-wait-orb .orb") }));
  if (!/Nina te montrera ici ce qu'elle fait/.test(w.text) || !w.lion || !w.orb) throw new StepError(`attente incomplète : ${JSON.stringify(w)}`);
  await shot(tv, "present-follow-attente-1920");
  // 2. Nina ouvre le navigateur : la TV bascule seule.
  await page.fill("#nk-composer", "trouve un logement pour 4 avec balcon");
  await page.click("button.send");
  await tv.waitForSelector("[data-present-session]", { timeout: STEP_MS });
  await until(tv, "halo sur la cible", () => !!document.querySelector(".present [data-np-halo]"));
  await shot(tv, "present-follow-session-1920");
  const sid = await tv.getAttribute("[data-present-session]", "data-present-session");
  const bubble = await page.locator("[data-brw-session]").first().getAttribute("data-brw-session");
  if (sid !== bubble) throw new StepError(`la TV montre ${sid} au lieu de la session de la bulle ${bubble}`);
  // 3. Fin de session : « Terminé », puis retour à l'attente.
  await until(tv, "écran final", () => !!document.querySelector(".present-note") && /Terminé|Finished/.test(document.querySelector(".present-note").textContent ?? ""));
  await tv.waitForSelector("[data-present-wait]", { timeout: 30000 });
  await tv.close();
  // 4. Page ouverte pendant une session en cours.
  await page.fill("#nk-composer", "trouve un logement à Lisbonne pour 4");
  await page.click("button.send");
  await until(page, "session Lisbonne", () => [...document.querySelectorAll("[data-brw-session]")].some((b) => /Lisbonne/.test(b.textContent ?? "")));
  const late = await open("1");
  await late.waitForSelector("[data-present-session]", { timeout: STEP_MS });
  await late.close();
  // 5. Drapeau éteint.
  const off = await open("0");
  await off.waitForTimeout(1500);
  if (await off.locator("[data-present-wait], [data-present-session]").count()) throw new StepError("suivi actif drapeau éteint");
  if (!/not turned on|pas activ/i.test((await off.locator("body").innerText()) || "")) throw new StepError("message habituel absent drapeau éteint");
  await off.close();
  const real = problems.filter((x) => !/Failed to load resource/.test(x));
  if (real.length) throw new StepError(real.slice(0, 3).join(" | "));
  report.push("ok   present-follow (attente, bascule, fin, ouverture en cours, éteint)");
} catch (e) {
  failed++;
  report.push(`FAIL present-follow: ${e.message}`);
  await shot(page, "FAIL-present-follow").catch(() => {});
} finally {
  await ctx.close();
  s.stop();
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
