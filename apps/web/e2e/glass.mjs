/**
 * Recette V4 « Verre liquide » (drapeau localStorage nokker.web.glass) sur le mock : captures avant/après, clair et sombre
 * (chat + carte d'approbation + barre de saisie), et la garde de performance (?glassfps=<i/s> remplace la mesure) :
 *  - drapeau éteint (valeur mémorisée "off", qui l'emporte aussi sur un build allumé) : aucune classe, aucun filtre ;
 *  - allumé : html.nk-glass + data-glass (refract dans Chromium) ; le flou est appliqué aux bulles de Nina, à la barre de saisie ;
 *  - 60 i/s mesurés : le rendu est gardé ; 40 : repli sur « blur » (flou seul, sans filtre SVG) ; 20 : verre éteint.
 * Usage : `E2E_SHOTS=<dossier> node e2e/glass.mjs`.
 */
import { chromium } from "playwright-core";
import { login, servers, shot, STEP_MS, StepError, until, watch } from "./phone-shell.mjs";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const s = await servers({});
async function run(name, { flag, theme, fps, extra = "" }, check) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, colorScheme: theme, locale: "fr-CH" });
  await ctx.addInitScript(([f, t]) => { if (f) localStorage.setItem("nokker.web.glass", f); localStorage.setItem("nokker.web.theme", JSON.stringify(t)); }, [flag, theme]);
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
  try {
    await login(page, `${s.base}${fps ? `?glassfps=${fps}` : "?x=1"}${extra}`);
    await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
    await page.fill("#nk-composer", "Dis-moi en une phrase ce que tu peux faire pour moi.");
    await page.click("button.send");
    await until(page, "réponse de Nina", () => document.querySelectorAll(".msg.nina .msg-body").length >= 2 && !document.querySelector(".msg.nina.streaming"));
    await page.fill("#nk-composer", "envoie le compte rendu à toute l'équipe");
    await page.click("button.send");
    await page.waitForTimeout(1800);
    await page.fill("#nk-composer", "");
    await page.waitForTimeout(1500); // le temps que la garde mesure et se prononce
    await shot(page, `glass-${flag ? "apres" : "avant"}-${theme}`);
    const st = await page.evaluate(() => {
      const h = document.documentElement;
      const msg = [...document.querySelectorAll(".msg.nina .msg-body")].at(-1);
      const comp = document.querySelector(".composer");
      return {
        cls: h.classList.contains("nk-glass"), mode: h.getAttribute("data-glass"), fps: h.getAttribute("data-glass-fps"),
        msgBlur: msg ? /blur/.test(getComputedStyle(msg).backdropFilter) : null, compBlur: comp ? /blur/.test(getComputedStyle(comp).backdropFilter) : null,
        msgRefract: msg ? /url\(/.test(getComputedStyle(msg).backdropFilter) : null, defs: !!document.getElementById("nk-glass-defs"),
      };
    });
    await check(st, page);
    const real = problems.filter((x) => !/404|Failed to load resource/.test(x));
    if (real.length) throw new StepError(real.slice(0, 2).join(" | "));
    report.push(`ok   glass ${name}`);
  } catch (e) {
    failed++;
    report.push(`FAIL glass ${name}: ${e.message}`);
    await shot(page, `FAIL-glass-${name}`).catch(() => {});
  } finally {
    await ctx.close();
  }
}
for (const theme of ["light", "dark"]) {
  await run(`éteint ${theme}`, { flag: "off", theme }, (st) => { if (st.cls || st.mode || st.defs) throw new StepError(`traces du verre drapeau éteint : ${JSON.stringify(st)}`); });
  await run(`allumé ${theme} (60 i/s)`, { flag: "1", theme, fps: 60 }, (st) => {
    if (!st.cls || st.mode !== "refract" || !st.defs) throw new StepError(`verre non posé : ${JSON.stringify(st)}`);
    if (!st.msgBlur || !st.compBlur || !st.msgRefract) throw new StepError(`flou/réfraction absents : ${JSON.stringify(st)}`);
  });
}
await run("repli à 40 i/s : blur seul", { flag: "1", theme: "light", fps: 40 }, (st) => {
  if (st.mode !== "blur" || !st.msgBlur || st.msgRefract) throw new StepError(`pas de repli sur blur : ${JSON.stringify(st)}`);
});
await run("repli à 20 i/s : éteint", { flag: "1", theme: "light", fps: 20 }, (st) => {
  if (st.cls || st.mode) throw new StepError(`le verre reste posé à 20 i/s : ${JSON.stringify(st)}`);
});
await run("badge d'essai (?glassdebug=1)", { flag: "1", theme: "light", fps: 40, extra: "&glassdebug=1" }, async (st, page) => {
  const t = await page.evaluate(() => document.querySelector("[data-glass-debug]")?.textContent ?? "");
  if (!/glass: blur · 40 fps \(started as refract\)/.test(t)) throw new StepError(`badge : « ${t} »`);
});
await run("forcé blur", { flag: "blur", theme: "light", fps: 60 }, (st) => {
  if (st.mode !== "blur" || st.msgRefract) throw new StepError(`blur forcé non respecté : ${JSON.stringify(st)}`);
});
s.stop();
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
