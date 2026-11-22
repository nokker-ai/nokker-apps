/**
 * Recette « L'agent qui montre » (V3, contrat noyau BROWSER-LIVE v3) sur le mock (MOCK_BROWSER_LIVE=1) :
 *  1. « réserve une table… » → une bulle navigateur dans le fil : capture en direct (URL signée, même origine),
 *     curseur lion, frise d'actions ;
 *  2. la frame qui suit la saisie dans un champ sensible n'a PAS d'image (cache « Masqué ») ; le texte saisi n'apparaît
 *     nulle part ;
 *  3. la carte d'approbation est DANS la bulle, ancrée sur la vignette de sa frame, et nomme la règle du foyer
 *     (le libellé de la règle seul) ;
 *  4. approuvée (TOTP de démo) → reprise en main 2FA : « Je prends la main » ouvre la vue à usage unique (2e ouverture :
 *     410), « J'ai fini » → la session reprend puis se termine (« Terminé. ») ;
 *  5. une capture expirée ou rejouée se relit par GET /v1/browser/sessions/{id} (la bulle se remet d'elle-même).
 * 390 sombre EN et 1280 clair FR. Usage : `node e2e/browser-live.mjs` (E2E_SHOTS=<dossier>).
 */
import { chromium } from "playwright-core";
import { login, PHONE, servers, shot, STEP_MS, StepError, until, watch } from "./phone-shell.mjs";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [dev, opts] of [["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }], ["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }]]) {
  const fr = dev.includes("-fr");
  const s = await servers({ MOCK_BROWSER_LIVE: "1", MOCK_BROWSER_STEP_MS: "500" });
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  try {
    await login(page, s.base);
    await page.waitForSelector("#nk-composer", { timeout: STEP_MS });
    await page.fill("#nk-composer", fr ? "réserve une table pour 4 samedi soir" : "book a table for 4 on Saturday evening");
    await page.click("button.send");
    // 1. Bulle navigateur, capture en direct.
    const b = page.locator("[data-brw-session]").first();
    await b.waitFor({ timeout: STEP_MS });
    await until(page, "capture affichée", () => {
      const img = document.querySelector("[data-brw-session] .brw-zoom > img");
      return !!img && img.complete && img.naturalWidth > 0;
    });
    const src = await b.locator(".brw-zoom > img").getAttribute("src");
    if (!/\/v1\/browser\/frames\/frm_[0-9a-f]+\.webp\?exp=\d+&sig=/.test(src ?? "")) throw new StepError(`URL de capture inattendue : ${src}`);
    // 2. Frame sensible : vignette masquée dans la frise, aucune image.
    await until(page, "frame sensible masquée", () => !!document.querySelector("[data-brw-session] .brw-mini.veil"));
    // 3. Carte dans la bulle, ancrée sur sa frame, avec la règle du foyer.
    const card = b.locator("[data-brw-card]").first();
    await card.waitFor({ timeout: STEP_MS * 2 });
    const seq = await card.getAttribute("data-brw-card-seq");
    if (!(await b.locator(`[data-brw-frame="${seq}"] .brw-pin`).count())) throw new StepError(`carte non ancrée sur la frame ${seq}`);
    await until(page, "« Ton accord » avec le libellé de la règle", (want) => (document.querySelector("[data-brw-card] [data-approval-blocked-by]")?.textContent ?? "").includes(want), fr ? "Envoi à un destinataire autorisé" : "Sending to an allowed recipient");
    if (/Bloqué par|Blocked by|Ton accord :|Your approval:/.test(await card.locator("[data-approval-blocked-by]").innerText())) throw new StepError("préfixe devant le libellé de la règle");
    // UNE voie d'approbation (l'appareil) ; le jargon (outil, effet) est replié dans « Détails ».
    if (await card.locator("form.totp").count()) throw new StepError("le formulaire TOTP est affiché d'emblée à côté de l'appareil");
    if (await card.locator("[data-approval-details][open]").count()) throw new StepError("le détail technique est déplié");
    // Agrandir la capture : plein écran, Échap ferme.
    await b.locator("[data-brw-zoom=open]").click();
    await page.locator("[data-brw-lightbox]").waitFor({ timeout: STEP_MS });
    await shot(page, `browser-live-big-${dev}`);
    await page.keyboard.press("Escape");
    await until(page, "grande vue fermée", () => !document.querySelector("[data-brw-lightbox]"));
    if (!(await b.locator("[data-brw-action=type]").count())) throw new StepError("saisie absente de la frise");
    if (/••••/.test(await b.locator(".brw-strip").innerText())) throw new StepError("du texte saisi apparaît dans la frise");
    await shot(page, `browser-live-card-${dev}`);
    // 4. Approbation (TOTP de démo) → reprise en main.
    const totp = (await s.dev("/healthz")).body.totp_demo;
    await card.locator("[data-approval-totp-open]").click();
    await card.locator("input[autocomplete=one-time-code]").fill(String(totp));
    await card.locator("form.totp button[type=submit], .totp button[type=submit]").first().click();
    await until(page, "reprise en main 2FA", () => document.querySelector("[data-brw-session]")?.getAttribute("data-brw-state") === "handoff" && !!document.querySelector("[data-brw-handoff=\"2fa\"]"));
    await shot(page, `browser-live-handoff-${dev}`);
    // Le code est échangé (Bearer) contre le cookie de reprise, puis l'écran s'ouvre ; rejoué : refusé, la bulle le dit.
    const [tab] = await Promise.all([ctx.waitForEvent("page"), b.locator("[data-brw-takeover]").click()]);
    await tab.waitForURL(/\/v1\/browser\/sessions\/bs_[0-9a-f]+\/screen$/, { timeout: STEP_MS });
    if (!/restaurant\.example/.test(await tab.content())) throw new StepError("vue de reprise vide");
    await tab.close();
    const [tab2] = await Promise.all([ctx.waitForEvent("page"), b.locator("[data-brw-takeover]").click()]);
    await until(page, "code de reprise rejoué refusé", () => !!document.querySelector("[data-brw-handoff] .error"));
    await tab2.close().catch(() => {});
    await b.locator("[data-brw-resume]").click();
    await until(page, "session terminée", () => document.querySelector("[data-brw-session]")?.getAttribute("data-brw-state") === "ended" && document.querySelector("[data-brw-ended]")?.getAttribute("data-brw-ended") === "done");
    // 5. Capture expirée : la bulle relit l'état (on simule l'expiration en cassant l'URL affichée).
    await page.evaluate(() => {
      const img = document.querySelector("[data-brw-session] .brw-zoom > img");
      img.src = img.src.replace(/sig=[^&]+/, "sig=bad");
    });
    await until(page, "capture relue après une URL refusée", () => {
      const img = document.querySelector("[data-brw-session] .brw-zoom > img");
      return !!img && !/sig=bad/.test(img.src) && img.complete && img.naturalWidth > 0;
    });
    await shot(page, `browser-live-done-${dev}`);
    const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (o > 1) throw new StepError(`débordement horizontal ${o}px`);
    // Attendus : 410 du code de reprise rejoué, 403 de la capture à signature cassée.
    const real = problems.filter((p) => !/HTTP 410 POST \/v1\/browser\/takeover\//.test(p) && !/HTTP 403 GET \/v1\/browser\/frames\//.test(p));
    if (real.length) throw new StepError(real.slice(0, 3).join(" | "));
    report.push(`ok   browser-live ${dev}`);
  } catch (e) {
    failed++;
    report.push(`FAIL browser-live ${dev}: ${e.message}`);
    await shot(page, `FAIL-browser-live-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
