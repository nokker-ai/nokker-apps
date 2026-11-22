/**
 * Recette « Écran mural » (LOKKAL-PHONE §4.4, lot P10b, phase S) dans la FAUSSE COQUE (e2e/phone-shell.mjs).
 * Sécurité (décision dev 06.11, défaut relevé à la relecture des textes) : mise en place REFUSÉE sans code sur l'appareil ; la mise en
 * place ferme d'office la session complète (aucun jeton de session ne reste : IndexedDB, localStorage, cookies) ; la
 * sortie exige la biométrie ou le code (refus : le mur reste ; succès : écran de connexion, pas un compte).
 *  1. inscription du téléphone, mode maison allumé ;
 *  2. « Utiliser comme écran mural » sans code → refus expliqué, rien n'est appairé ;
 *  3. avec code → appairage glance « wall », nkg_ au « trousseau » (jamais stockage web, URL, page ni requête), session
 *     fermée, la page devient le mur : nombre de cartes, heure du rendez-vous SANS titre, pas de brief ;
 *  4. nuit (horloge figée à 23:10 dans un contexte séparé : l'horloge est par contexte) ;
 *  5. sortie : 3 s d'appui → authentification refusée → le mur reste ; acceptée → écran de connexion ;
 *  6. reconnexion pour régler le mur (le nœud et le mur restent inscrits : trousseau de la fausse coque) → « Ouvrir
 *     l'écran mural » referme la session AVANT d'afficher le mur (clé d'appareil présente avant, absente après).
 * 390 portrait sombre EN et 1280 paysage clair FR. Usage : `node e2e/wall.mjs` (E2E_SHOTS=<dossier>).
 */
import { chromium } from "playwright-core";
import { fakeShell, login, PHONE, servers, shot, STEP_MS, StepError, until, watch } from "./phone-shell.mjs";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [dev, opts] of [["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }], ["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }]]) {
  const E = dev.includes("-en");
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const kc = new Map();
  const flags = { passcode: false, auth: false };
  await ctx.exposeFunction("__kcGet", (k) => kc.get(k) ?? null);
  await ctx.exposeFunction("__kcSet", (k, v) => (v == null ? kc.delete(k) : kc.set(k, v), true));
  await ctx.exposeFunction("__passcode", () => flags.passcode);
  await ctx.exposeFunction("__authOk", () => flags.auth);
  await ctx.exposeFunction("__haPrompt", () => true);
  await ctx.exposeFunction("__haRun", () => ({ error: "ha_unreachable" }));
  const page = await ctx.newPage();
  await page.addInitScript(fakeShell, s.mock);
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  const leaked = [];
  page.on("request", (r) => r.url().includes("nkg_") && leaked.push(r.url()));
  try {
    // 1. Téléphone inscrit, mode maison allumé.
    await login(page, s.base);
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    await page.evaluate(() => localStorage.setItem("nokker.web.tab", JSON.stringify("account")));
    await page.reload();
    const card = page.locator("[data-phone-node]");
    await card.waitFor({ timeout: STEP_MS });
    await card.locator("[data-phone-register]").click();
    await card.locator("[data-phone-waiting]").waitFor({ timeout: STEP_MS });
    const pending = (await s.dev("/v1/dev/phone/pending")).body;
    await s.dev("/v1/dev/phone/approve", { approval_id: pending.approval_id });
    await until(page, "téléphone joignable", () => document.querySelector("[data-phone-state]")?.getAttribute("data-phone-state") === "live");
    await card.locator("[data-home-toggle]").click();
    await until(page, "mode maison allumé", () => document.querySelector("[data-phone-home]")?.getAttribute("data-phone-home") === "on");
    const wallBox = card.locator("[data-phone-wall]");
    await wallBox.waitFor({ timeout: STEP_MS });

    // 2. Sans code sur l'appareil : refusé, rien n'est appairé, la session reste.
    await card.locator("[data-wall-setup]").click();
    await until(page, "refus sans code", () => !!document.querySelector(".phone-wall [role=alert]"));
    const refusal = (await page.locator(".phone-wall [role=alert]").textContent()) ?? "";
    if (!(E ? /passcode/ : /code/).test(refusal)) throw new StepError(`refus sans code : ${refusal}`);
    if (kc.has("wall-token")) throw new StepError("un mur a été appairé sans code sur l'appareil");
    await shot(page, `wall-nopasscode-${dev}`);

    // 3. Avec code : appairage, session fermée, la page devient le mur.
    flags.passcode = true;
    await card.locator("[data-wall-setup]").click();
    await page.waitForURL((u) => u.pathname === "/glance" && u.search.includes("wall=1"), { timeout: STEP_MS });
    await page.waitForSelector("[data-wall-cards]", { timeout: STEP_MS }).catch(() => {
      throw new StepError("la page murale ne montre pas les cartes");
    });
    const nkg = kc.get("wall-token") ?? "";
    if (!nkg.startsWith("nkg_")) throw new StepError("pas de jeton nkg_ au trousseau");
    const probe = () =>
      page.evaluate(
      async () =>
        JSON.stringify({
          ls: Object.keys(localStorage).filter((k) => k !== "nokker.web.theme" && k !== "nokker.web.tab" && k !== "lang"),
          lsVals: Object.values(localStorage),
          ss: Object.values(sessionStorage),
          cookie: document.cookie,
          device: await new Promise((ok) => {
            const r = indexedDB.open("nokker-web", 1);
            r.onupgradeneeded = () => r.result.createObjectStore("keys");
            r.onsuccess = () => {
              const g = r.result.transaction("keys", "readonly").objectStore("keys").get("device");
              g.onsuccess = () => ok(g.result ? "present" : "absent");
              g.onerror = () => ok("error");
            };
            r.onerror = () => ok("error");
          }),
        }),
    );
    const left = await probe();
    const L = JSON.parse(left);
    if (L.device !== "absent") throw new StepError(`clé d'appareil (session) encore présente après la mise en place : ${L.device}`);
    if (L.cookie) throw new StepError(`cookie restant après la mise en place : ${L.cookie.slice(0, 40)}`);
    if (left.includes("nkg_") || page.url().includes("nkg_") || (await page.content()).includes(nkg)) throw new StepError("le jeton du mur est dans un stockage web, l'URL ou la page");
    const cardsText = (await page.locator("[data-wall-cards]").textContent()) ?? "";
    if (!(E ? /(Nothing to decide|to decide in the Nokker app)/ : /(Rien à décider|à décider dans l'app Nokker)/).test(cardsText)) throw new StepError(`ligne des cartes : ${cardsText}`);
    if (/—/.test((await page.locator("[data-wall-event]").textContent()) ?? "") || (await page.locator("[data-wall-brief]").count())) throw new StepError("titre ou brief sur le mur sans le réglage");
    if (await page.evaluate(() => [...document.scripts].some((x) => x.src && new URL(x.src).origin !== location.origin))) throw new StepError("script tiers sur la page murale");
    const ow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (ow > 1) throw new StepError(`débordement horizontal sur le mur ${ow}px`);
    await shot(page, `wall-day-${dev}`);

    // 3b. F1 — vue « Foyer » (de jour) : agenda par personne, tâche cochée depuis le mur (relue aussitôt), mode invité
    // allumé SANS authentification (le privé disparaît), éteint seulement avec le code de l'appareil.
    if ((await page.locator("main.wall").getAttribute("data-night")) === "0") {
      await page.waitForSelector("[data-wall-foyer=on] [data-fy-agenda]", { timeout: STEP_MS }).catch(() => {
        throw new StepError("pas de vue Foyer sur le mur de jour");
      });
      if (!(await page.locator("[data-fy-event] .fy-chip").count())) throw new StepError("agenda sans personne");
      const ag = (await page.locator("[data-fy-agenda]").innerText()) ?? "";
      if (!/(Réunion de parents|Piano|Cinéma)/.test(ag)) throw new StepError("titres partagés absents de l'agenda du Foyer");
      if (!/(busy|occupé)/.test(ag)) throw new StepError("l'événement privé n'est pas « occupé »");
      if (/(Incident|API p95)/.test(await page.locator("main.wall").innerText())) throw new StepError("incidents techniques sur le mur familial");
      const task = page.locator('[data-fy-check="tk_dishes"]');
      if ((await task.getAttribute("aria-pressed")) !== "false") throw new StepError("tâche déjà cochée");
      await task.click();
      await until(page, "tâche cochée depuis le mur", () => document.querySelector('[data-fy-check="tk_dishes"]')?.getAttribute("aria-pressed") === "true");
      await shot(page, `wall-foyer-${dev}`);
      await page.locator("[data-wall-guest-toggle=on]").click();
      await until(page, "mode invité allumé", () => document.querySelector("main.wall")?.getAttribute("data-wall-foyer") === "guest" && !document.querySelector("[data-fy-tasks]") && !document.querySelector("[data-fy-projects]"));
      if (/(Réunion de parents|Piano|Cinéma)/.test((await page.locator("[data-fy-agenda]").innerText()) ?? "")) throw new StepError("titres d'agenda en mode invité");
      await shot(page, `wall-guest-${dev}`);
      const authBefore = flags.auth;
      flags.auth = false;
      await page.locator("[data-wall-guest-toggle=off]").click();
      await page.waitForTimeout(600);
      if ((await page.locator("main.wall").getAttribute("data-wall-foyer")) !== "guest") throw new StepError("mode invité quitté sans le code de l'appareil");
      flags.auth = true;
      await page.locator("[data-wall-guest-toggle=off]").click();
      await until(page, "mode invité quitté avec le code", () => document.querySelector("main.wall")?.getAttribute("data-wall-foyer") === "on" && !!document.querySelector("[data-fy-tasks]"));
      flags.auth = authBefore;
      const ow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (ow2 > 1) throw new StepError(`débordement horizontal dans la vue Foyer ${ow2}px`);
    }
    // 3c. Emplacement de l'orbe vocal : caché par défaut ; la crochet de test force un état (la voix du mur n'existe pas encore).
    if (await page.locator("[data-wall-orb]").count()) throw new StepError("l'orbe du mur est visible sans état");
    for (const st of ["listening", "thinking", "speaking"]) {
      await page.evaluate((x) => window.__nokkerWallOrb(x), st);
      await until(page, `orbe du mur ${st}`, (x) => document.querySelector("[data-wall-orb] [data-orb]")?.getAttribute("data-orb") === x, st);
      if (!(await page.locator("[data-wall-orb] [role=status]").innerText()).trim()) throw new StepError(`orbe du mur ${st} sans libellé`);
      const ob = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (ob > 1) throw new StepError(`débordement horizontal avec l'orbe ${ob}px`);
      await shot(page, `wall-orb-${st}-${dev}`);
    }
    await page.evaluate(() => window.__nokkerWallOrb("off"));
    await until(page, "orbe du mur caché", () => !document.querySelector("[data-wall-orb]"));

    // 4. Nuit, dans un contexte séparé (horloge par contexte).
    const nightCtx = await browser.newContext(opts);
    await nightCtx.exposeFunction("__kcGet", (k) => kc.get(k) ?? null);
    await nightCtx.exposeFunction("__kcSet", () => true);
    const night = await nightCtx.newPage();
    await night.addInitScript(fakeShell, s.mock);
    await night.clock.setFixedTime(new Date(2026, 10, 6, 23, 10));
    await night.goto(`${s.base}/glance?wall=1`);
    // 2 lectures par minute déjà prises : la page peut dire « en attente » ou « hors ligne », c'est voulu.
    await night.waitForSelector('[data-wall="ready"][data-night="1"] :is([data-wall-cards], [data-wall-offline])', { timeout: STEP_MS }).catch(() => {
      throw new StepError("le mur ne passe pas en nuit à 23:10");
    });
    await shot(night, `wall-night-${dev}`);
    await nightCtx.close();

    // 5. Sortie : authentification refusée → le mur reste ; acceptée → écran de connexion (plus de session).
    const hold = async () => {
      const box = await page.locator("[data-wall-exit]").boundingBox();
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.mouse.down();
      await page.waitForTimeout(3400);
      await page.mouse.up();
    };
    await hold();
    await page.waitForSelector("[data-wall-denied]", { timeout: STEP_MS }).catch(() => {
      throw new StepError("pas de message après une authentification refusée");
    });
    if (!page.url().includes("wall=1")) throw new StepError("le mur a été quitté sans authentification");
    await shot(page, `wall-denied-${dev}`);
    flags.auth = true;
    await hold();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 8000 }).catch(() => {
      throw new StepError("la sortie authentifiée ne quitte pas le mur");
    });
    await page.waitForSelector("#wl-email", { timeout: STEP_MS }).catch(() => {
      throw new StepError("après la sortie, pas d'écran de connexion (un compte serait ouvert)");
    });
    if (kc.get("wall-active")) throw new StepError("le mur reste marqué actif après la sortie");
    // 6. Reconnexion pour régler le mur, puis « Ouvrir l'écran mural » : la session se referme d'abord.
    await login(page, s.base);
    // L'onglet « Mon compte » est retenu depuis l'étape 1 : on attend la fin de la connexion, pas le composeur.
    await until(page, "connecté à nouveau", () => !document.querySelector("#wl-code") && !document.querySelector("#wl-email") && !!document.querySelector(".acct-btn, .composer"));
    await page.evaluate(() => localStorage.setItem("nokker.web.tab", JSON.stringify("account")));
    await page.reload();
    await page.locator('[data-phone-wall="set"]').waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("après reconnexion, le mur n'apparaît pas comme réglé (inscription du nœud perdue ?)");
    });
    if (JSON.parse(await probe()).device !== "present") throw new StepError("pas de session après la reconnexion : le contrôle suivant ne prouverait rien");
    await page.locator("[data-wall-open]").click();
    await page.waitForURL((u) => u.pathname === "/glance" && u.search.includes("wall=1"), { timeout: STEP_MS });
    await page.waitForSelector('[data-wall="ready"]', { timeout: STEP_MS });
    const again = JSON.parse(await probe());
    if (again.device !== "absent" || again.cookie) throw new StepError(`session restée derrière le mur rouvert : ${JSON.stringify(again).slice(0, 120)}`);
    if (leaked.length) throw new StepError(`jeton du mur dans une URL : ${leaked[0].replace(/nkg_[^&/]+/, "nkg_…")}`);
    // 429 sur /v1/glance : la limite voulue (2 lectures par minute) ; le mur la gère (« hors ligne », lecture suivante).
    const real = problems.filter((p) => !/^HTTP 429 GET \/v1\/glance$/.test(p));
    if (real.length) throw new StepError(real.slice(0, 3).join(" | "));
    report.push(`ok   wall ${dev}`);
  } catch (e) {
    failed++;
    report.push(`FAIL wall ${dev}: ${e.message}`);
    await shot(page, `FAIL-wall-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
