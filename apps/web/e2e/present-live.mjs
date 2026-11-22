/**
 * Recette de /present en mode démo (drapeau localStorage nokker.web.present.live ; build VITE_NOKKER_NINA_LIVE=1) sur le
 * mock (MOCK_BROWSER_LIVE=1) : Nina LIVE en vignette, JAMAIS le rig 2D.
 *  0. avant le bouton « Parler à Nina » : seulement l'orbe (narration), aucune salle ouverte, jamais de visage muet ;
 *  1. salle en connexion (réponse de /v1/nina-live/session retardée) : vignette en bas à droite, hors de la page et de
 *     la cible, rig masqué, faisceau parti de la vignette, bulles des cibles au-dessus ; bouton « Parler à Nina » → micro
 *     demandé seulement après le geste, puis push-to-talk (bouton maintenu / barre d'espace), aucun getUserMedia
 *     (aucune salle) ;
 *  2. live indisponible (404 prévu du mock) : la vignette disparaît, aucun rig 2D, halo + faisceau + sous-titres + bulles ;
 *  3. drapeau éteint : /present comme avant (rig 2D), aucune vignette.
 * Usage : `VITE_NOKKER_NINA_LIVE=1 E2E_PREVIEW=1 node e2e/present-live.mjs` (E2E_SHOTS=<dossier>).
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
let delayMs = 0;
let sessionCalls = 0;
await ctx.route("**/v1/nina-live/session", async (r) => {
  sessionCalls++;
  if (delayMs) await new Promise((ok) => setTimeout(ok, delayMs));
  await r.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"not_found"}}' });
});
try {
  await login(page, s.base);
  await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
  await page.fill("#nk-composer", "trouve un logement pour 4 avec balcon");
  await page.click("button.send");
  const b = page.locator("[data-brw-session]").first();
  await b.waitFor({ timeout: STEP_MS });
  const sid = await b.getAttribute("data-brw-session");
  const open = async (demo, delay) => {
    delayMs = delay;
    const p = await ctx.newPage();
    watch(p, problems);
    await p.addInitScript((d) => localStorage.setItem("nokker.web.present.live", d), demo);
    await p.setViewportSize({ width: 1920, height: 1080 });
    await p.goto(`${s.base}/present/${sid}?ptt=1`);
    await p.waitForSelector(`[data-present-session="${sid}"]`, { timeout: STEP_MS });
    return p;
  };
  // 1. Salle en connexion : la vignette est là.
  const big = await open("1", 9000);
  // Avant le bouton : seulement l'orbe (la narration), JAMAIS un visage muet : aucune salle n'est ouverte.
  await until(big, "orbe de Nina (coin libre)", () => !!document.querySelector("[data-pl-orb-box] .pl-orb"));
  await until(big, "halo sur la cible", () => !!document.querySelector(".present [data-np-halo]"));
  await big.waitForTimeout(600);
  if (await big.locator("[data-pl-vignette]").count()) throw new StepError("vignette Nina live avant l'échange au micro");
  if (sessionCalls) throw new StepError("une salle Nina live a été ouverte avant l'échange au micro");
  await big.click("[data-pl-mic]"); // le geste : l'échange commence, la vignette se monte
  await until(big, "vignette de Nina", () => !!document.querySelector("[data-pl-vignette]"));
  await big.waitForTimeout(400);
  const g = await big.evaluate(() => {
    const st = document.querySelector(".present-stage").getBoundingClientRect();
    const rel = (r) => ({ x: (r.left - st.left) / st.width, y: (r.top - st.top) / st.height, w: r.width / st.width, h: r.height / st.height });
    const v = document.querySelector("[data-pl-vignette]").getBoundingClientRect();
    const th = document.querySelector(".pl-thumb").getBoundingClientRect();
    const halo = document.querySelector(".present [data-np-halo]").getBoundingClientRect();
    const fr = document.querySelector(".present-frame").getBoundingClientRect();
    const line = document.querySelector("[data-np-beam] line");
    const bub = document.querySelector("[data-np-bubbles]")?.getBoundingClientRect();
    const rig = document.querySelector(".pl-thumb .nk-nina-live-rig");
    return {
      v: rel(v), thumbSquare: Math.abs(th.width - th.height) < 2, halo: rel(halo), frame: rel(fr),
      x1: parseFloat(line?.getAttribute("x1") ?? "NaN") / 100, y1: parseFloat(line?.getAttribute("y1") ?? "NaN") / 100, thumb: rel(th),
      bubBottom: bub ? (bub.bottom - st.top) / st.height : null,
      rigShown: rig ? getComputedStyle(rig).display !== "none" : false,
      rigFrames: document.querySelectorAll(".np-frame, [data-np-frame]").length,
      mode: document.querySelector(".nk-nina-live")?.getAttribute("data-mode") ?? null,
    };
  });
  const hit = (a, c) => a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y;
  if (g.v.x < 0.7 || g.v.y < 0.35) throw new StepError(`vignette pas en bas à droite : ${JSON.stringify(g.v)}`);
  if (g.v.x + g.v.w > 0.951 || g.v.y + g.v.h > 0.951) throw new StepError("la vignette sort de la zone sûre TV");
  if (hit(g.v, g.halo) || hit(g.v, g.frame)) throw new StepError("la vignette recouvre la cible ou la page");
  if (!g.thumbSquare) throw new StepError("le cadre de Nina n'est pas carré");
  if (g.rigShown || g.rigFrames) throw new StepError("le rig 2D est visible en mode démo");
  const cx = g.thumb.x + g.thumb.w / 2, cy = g.thumb.y + g.thumb.h / 2;
  if (Math.abs(g.x1 - cx) > 0.02 || Math.abs(g.y1 - cy) > 0.03) throw new StepError(`le faisceau ne part pas de la vignette (${g.x1.toFixed(3)},${g.y1.toFixed(3)} / ${cx.toFixed(3)},${cy.toFixed(3)})`);
  if (g.bubBottom !== null && g.bubBottom > g.v.y + 0.02) throw new StepError("les bulles des cibles descendent sur la vignette");
  await shot(big, "present-live-vignette-1920");
  // Push-to-talk : aucun micro avant le geste ; le bouton « Parler à Nina » le demande, ensuite bouton / espace.
  await big.waitForSelector(".pl-hold", { timeout: STEP_MS });
  await until(big, "indicateur « À toi »", () => !!document.querySelector("[data-pl-floor]"));
  await big.keyboard.down("Space");
  await until(big, "bouton maintenu (espace)", () => document.querySelector(".pl-hold")?.classList.contains("held"));
  await big.keyboard.up("Space");
  await until(big, "bouton relâché", () => !document.querySelector(".pl-hold")?.classList.contains("held"));
  if (mic) throw new StepError(`le micro a été demandé ${mic} fois sans salle`);
  // 2. Live indisponible : la vignette disparaît, jamais le rig.
  await until(big, "vignette retirée (live indisponible)", () => !document.querySelector("[data-pl-vignette]") && !!document.querySelector("[data-pl-orb-box]"));
  await big.waitForTimeout(500);
  const after = await big.evaluate(() => ({
    rig: document.querySelectorAll(".np-frame, [data-np-frame], .nk-nina img").length,
    halo: !!document.querySelector(".present [data-np-halo]"), beam: !!document.querySelector("[data-np-beam]"),
    caption: (document.querySelector("[data-present-caption]")?.textContent ?? "").trim().length > 0,
    bubbles: !!document.querySelector("[data-np-bubbles]"),
    x1: parseFloat(document.querySelector("[data-np-beam] line")?.getAttribute("x1") ?? "NaN") / 100,
  }));
  // La narration reste : le faisceau part de l'orbe, au centre du même cadre carré.
  if (!(Math.abs(after.x1 - cx) < 0.02)) throw new StepError(`au repli le faisceau ne part pas de l'orbe (x1 ${after.x1})`);
  if (after.rig) throw new StepError("le rig 2D est apparu au repli (mode démo)");
  if (!after.halo || !after.beam || !after.caption || !after.bubbles) throw new StepError(`repli incomplet : ${JSON.stringify(after)}`);
  await shot(big, "present-live-repli-1920");
  await big.close();
  // 3. Drapeau éteint : /present comme avant.
  const off = await open("0", 0);
  await until(off, "halo", () => !!document.querySelector(".present [data-np-halo]"));
  await off.waitForSelector("[data-np-frame]", { timeout: STEP_MS });
  if (await off.locator("[data-pl-vignette]").count()) throw new StepError("vignette drapeau éteint");
  await off.close();
  const real = problems.filter((x) => !/nina-live|Failed to load resource/.test(x));
  if (real.length) throw new StepError(real.slice(0, 3).join(" | "));
  if (!sessionCalls) throw new StepError("Nina live n'a jamais été demandée");
  report.push("ok   present-live (vignette, push-to-talk, repli, éteint)");
} catch (e) {
  failed++;
  report.push(`FAIL present-live: ${e.message}`);
  await shot(page, "FAIL-present-live").catch(() => {});
} finally {
  await ctx.close();
  s.stop();
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
