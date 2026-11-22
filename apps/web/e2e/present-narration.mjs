/**
 * Recette de la narration vocale de /present (mode démo, drapeau localStorage nokker.web.present.live) sur le mock
 * (MOCK_BROWSER_LIVE=1) : chaque point désigné est DIT avec la voix de la persona (route de narration du noyau, simulée
 * par le mock : ton d'essai de 3 s) ; orbe V2 « speaking » pendant la parole, sous-titre = le texte du noyau, micro jamais
 * demandé, aucune salle Nina live ouverte (la vignette n'existe que pendant l'échange au micro), UN seul appel par point.
 *  1. route servie : on entend (élément audio qui joue), orbe speaking, puis retour au calme ;
 *  2. route absente (404) : un seul essai, sous-titres et bulles seuls, aucune erreur ;
 *  3. synthèse éteinte (503) : idem ;
 *  4. drapeau éteint : aucune requête de narration ;
 *  5. capacité browser_narration fausse (noyau) : la route n'est même pas tentée.
 * Usage : `VITE_NOKKER_NINA_LIVE=1 E2E_PREVIEW=1 node e2e/present-narration.mjs` (E2E_SHOTS=<dossier>).
 */
import { chromium } from "playwright-core";
import { login, servers, shot, STEP_MS, StepError, until, watch } from "./phone-shell.mjs";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });

async function scenario(name, narrationMode, demo, check, extra = {}) {
  const s = await servers({ MOCK_BROWSER_LIVE: "1", MOCK_BROWSER_STEP_MS: "500", MOCK_NARRATION: narrationMode, ...extra });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" });
  await ctx.addInitScript(() => localStorage.getItem("nokker.web.presenter") === null && localStorage.setItem("nokker.web.presenter", "1"));
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
  let mic = 0, live = 0;
  const narr = [];
  await ctx.exposeFunction("__micAsked", () => (mic += 1));
  await ctx.addInitScript(() => {
    const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (gum) navigator.mediaDevices.getUserMedia = (c) => (window.__micAsked?.(), gum(c));
  });
  await ctx.route("**/v1/nina-live/session", (r) => (live++, r.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"not_found"}}' })));
  ctx.on("request", (r) => { if (/\/narrations\/\d+\/speech\/timed/.test(r.url())) narr.push(r.url().replace(/^.*\/narrations\//, "")); });
  try {
    await login(page, s.base);
    await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
    await page.fill("#nk-composer", "trouve un logement pour 4 avec balcon");
    await page.click("button.send");
    const b = page.locator("[data-brw-session]").first();
    await b.waitFor({ timeout: STEP_MS });
    const sid = await b.getAttribute("data-brw-session");
    const big = await ctx.newPage();
    watch(big, problems);
    await big.addInitScript((d) => localStorage.setItem("nokker.web.present.live", d), demo);
    await big.setViewportSize({ width: 1920, height: 1080 });
    await big.goto(`${s.base}/present/${sid}?ptt=1`);
    await big.waitForSelector(`[data-present-session="${sid}"]`, { timeout: STEP_MS });
    await until(big, "halo sur la cible", () => !!document.querySelector(".present [data-np-halo]"));
    await check({ big, narr, get mic() { return mic; }, get live() { return live; }, problems });
    const real = problems.filter((x) => !/nina-live|narrations|Failed to load resource/.test(x));
    if (real.length) throw new StepError(real.slice(0, 3).join(" | "));
    report.push(`ok   ${name}`);
  } catch (e) {
    failed++;
    report.push(`FAIL ${name}: ${e.message}`);
    await shot(page, `FAIL-${name}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}

await scenario("narration (route servie)", "1", "1", async (t) => {
  await until(t.big, "narration en cours", () => document.querySelector("[data-present]")?.getAttribute("data-narration") === "speaking");
  const st = await t.big.evaluate(() => ({
    orb: document.querySelector("[data-pl-orb-state]")?.getAttribute("data-pl-orb-state"),
    caption: (document.querySelector("[data-present-caption]")?.textContent ?? "").trim(),
    audio: [...document.querySelectorAll("audio")].length, vignette: !!document.querySelector("[data-pl-vignette]"),
  }));
  if (st.orb !== "speaking") throw new StepError(`l'orbe n'est pas en parole (${st.orb})`);
  if (!/4 voyageurs, balcon/.test(st.caption)) throw new StepError(`le sous-titre n'est pas le texte du noyau : « ${st.caption} »`);
  if (st.vignette) throw new StepError("un visage (vignette) pendant la narration");
  await shot(t.big, "present-narration-speaking-1920");
  await until(t.big, "retour au calme", () => document.querySelector("[data-present]")?.getAttribute("data-narration") === "idle", undefined);
  if (t.mic) throw new StepError(`le micro a été demandé ${t.mic} fois`);
  if (t.live) throw new StepError("une salle Nina live a été ouverte sans échange au micro");
  const seqs = t.narr.map((x) => x.split("/")[0]);
  if (!seqs.length || new Set(seqs).size !== seqs.length) throw new StepError(`un point narré deux fois : ${seqs.join(",")}`);
});
await scenario("narration (noyau sans route : un seul essai)", "404", "1", async (t) => {
  await t.big.waitForTimeout(3000);
  if (t.narr.length !== 1) throw new StepError(`${t.narr.length} essais au lieu d'un seul après un 404`);
  const st = await t.big.evaluate(() => ({ phase: document.querySelector("[data-present]")?.getAttribute("data-narration"), bubbles: !!document.querySelector("[data-np-bubbles]"), caption: (document.querySelector("[data-present-caption]")?.textContent ?? "").trim().length > 0 }));
  if (st.phase !== "idle" || !st.bubbles || !st.caption) throw new StepError(`repli incomplet : ${JSON.stringify(st)}`);
}, { MOCK_CAPABILITIES: "0" }); // noyau d'avant /v1/capabilities : le web tente la route, une fois
await scenario("narration (synthèse éteinte 503)", "503", "1", async (t) => {
  await t.big.waitForTimeout(3000);
  if (t.narr.length !== 1) throw new StepError(`${t.narr.length} essais après un 503`);
});
await scenario("narration (drapeau éteint)", "1", "0", async (t) => {
  await t.big.waitForTimeout(2500);
  if (t.narr.length) throw new StepError("narration demandée drapeau éteint");
});
// 5. Le noyau dit « pas de narration » (capacité browser_narration fausse) : on ne tente même pas la route.
await scenario("narration (capacité fausse)", "off", "1", async (t) => {
  await t.big.waitForTimeout(2500);
  if (t.narr.length) throw new StepError("route tentée alors que la capacité est fausse");
});
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
