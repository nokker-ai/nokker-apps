/**
 * Recette « Ce téléphone » (LOKKAL-PHONE §3 et §5.4, lot P7, phase S) dans une FAUSSE COQUE : `window.Capacitor` simulé
 * avec un plugin `NokkerNode` en WebCrypto (clé P-256 non extractible, preuve ES256 sur method/hôte/chemin/ts/nonce/
 * sha256 du corps) qui parle au mock EN DIRECT (CORS réel, comme l'URLSession de l'app), et `__NOKKER_FAKE_SHELL__`.
 *  1. Mon compte → « Inscrire ce téléphone » → attente avec l'empreinte de la clé (8 car.) ;
 *  2. l'AUTRE appareil approuve (route de réglage du mock) → jeton remis au plugin → battement → « joignable » ;
 *  3. le noyau met une tâche zone.state en file → le plugin la prend au long poll, répond → le journal la montre « fait »
 *     (sans contenu) ;
 *  3c. P7b : « lis le texte de l'image » → ocr.image (blob signé) retenu au-delà de l'attente du noyau → bulle
 *     phone_task « en cours », puis la suite (phone_continue, jamais rendue) → « reçu » ;
 *  3d. P10a : mode nœud maison (coupé par défaut) → adresse publique refusée, jeton par le « champ natif » (jamais
 *     dans la page), Wi-Fi maison → lan_home ; entités (vide par défaut, « tout » refusé) ; ha.states par la file sans
 *     coordonnées ; action refusée (nœud non attesté) ; oubli ;
 *  (3e. écran mural : e2e/wall.mjs)
 *  4. pause / reprise ; retrait : révocation, puis le jeton du nœud est refusé (401).
 * 390 sombre EN et 1280 clair FR. Usage : `node e2e/phone-node.mjs` (E2E_SHOTS=<dossier>).
 */
import { chromium } from "playwright-core";
// SDK compilé (dist, construit avant les recettes) : Node ne charge pas les sources TypeScript.
import { HaRelay, haWsUrl } from "../../../packages/sdk/dist/home-relay.js";
import { startFakeHa } from "../../../scripts/ios-ci/fake-ha.mjs";
import { fakeShell, HA_TOKEN, login, PHONE, PNG, servers, shot, STEP_MS, StepError, until, watch } from "./phone-shell.mjs";

const report = [];
let failed = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [dev, opts] of [["phone-dark-en", { ...PHONE, colorScheme: "dark", locale: "en-US" }], ["desktop-light-fr", { viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "fr-CH" }]]) {
  const E = dev.includes("-en");
  const s = await servers();
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.addInitScript(fakeShell, s.mock);
  // P10a : le jeton HA ne vit que côté « natif » (ici : Node) ; la page ne reçoit qu'un vrai/faux.
  const ha = await startFakeHa({ token: HA_TOKEN });
  const kc = new Map();
  await ctx.exposeFunction("__kcGet", (k) => kc.get(k) ?? null);
  await ctx.exposeFunction("__kcSet", (k, v) => (v == null ? kc.delete(k) : kc.set(k, v), true));
  // P10c : le « LAN » de la maison, simulé côté Node : une vignette CHIFFRÉE par URL, servie une seule fois.
  const lan = new Map();
  await ctx.exposeFunction("__lanPut", (t, b) => (lan.set(t, b), true));
  await ctx.exposeFunction("__lanGet", (t) => {
    const b = lan.get(t) ?? null;
    lan.delete(t);
    return b;
  });
  let haToken = null;
  await page.exposeFunction("__haPrompt", () => ((haToken = HA_TOKEN), true));
  await page.exposeFunction("__haRun", async (op, args, cfg) => {
    const relay = new HaRelay({ wsUrl: haWsUrl(ha.url), token: haToken ?? "", entities: cfg.entities, homeWifi: () => true, open: (u) => new WebSocket(u), timeoutMs: 3000 });
    try {
      return { result: await relay.run(op, args) };
    } catch (e) {
      return { error: e.code ?? "ha_error" };
    } finally {
      relay.close();
    }
  });
  if (dev.includes("dark")) await page.addInitScript(() => localStorage.setItem("nokker.web.theme", JSON.stringify("dark")));
  const problems = [];
  watch(page, problems);
  const regBodies = [];
  page.on("response", (r) => /\/v1\/link\/phone\/registrations\//.test(r.url()) && r.status() === 201 && r.text().then((t) => regBodies.push(t), () => undefined));
  const outside = [];
  page.on("request", (r) => /nokker\.ai/.test(new URL(r.url()).hostname) && outside.push(r.url()));
  try {
    await login(page, s.base);
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    await page.evaluate(() => localStorage.setItem("nokker.web.tab", JSON.stringify("account")));
    await page.reload();
    const card = page.locator("[data-phone-node]");
    await card.waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("pas de carte « Ce téléphone » dans Mon compte");
    });
    await card.scrollIntoViewIfNeeded();
    await shot(page, `phone-node-none-${dev}`);

    // 1. Inscription : attente avec l'empreinte.
    await card.locator("[data-phone-register]").click();
    await card.locator("[data-phone-waiting]").waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("pas d'attente d'approbation après « Inscrire »");
    });
    const fp = await page.evaluate(() => window.__node.fp);
    const shown = (await card.locator(".phone-fp code").textContent())?.trim();
    if (!/^[0-9a-f]{8}$/.test(shown ?? "") || shown !== fp) throw new StepError(`empreinte affichée ${shown} ≠ clé ${fp}`);
    await shot(page, `phone-node-waiting-${dev}`);
    // 2. L'autre appareil approuve (le mock joue ce second appareil enrôlé).
    const pending = (await s.dev("/v1/dev/phone/pending")).body;
    if (pending?.key_fingerprint !== fp) throw new StepError(`la carte du noyau porte l'empreinte ${pending?.key_fingerprint}, pas ${fp}`);
    const approvalId = pending.approval_id;
    if (!approvalId) throw new StepError("carte d'inscription introuvable côté mock");
    const ap = await s.dev("/v1/dev/phone/approve", { approval_id: approvalId });
    if (ap.status !== 200) throw new StepError(`approbation : HTTP ${ap.status}`);
    await until(page, "téléphone joignable", () => document.querySelector("[data-phone-state]")?.getAttribute("data-phone-state") === "live" && window.__node.beats >= 1);
    const live = (await card.locator("[data-phone-state]").textContent()) ?? "";
    if (!(E ? /Reachable while the app is open/ : /Joignable tant que l'app est ouverte/).test(live)) throw new StepError(`état affiché : ${live}`);
    const tok = await page.evaluate(() => window.__node.token);
    if (!/^mt_/.test(tok ?? "")) throw new StepError("le plugin n'a pas ouvert le sceau");
    if (regBodies.length !== 1 || regBodies[0].includes(tok) || regBodies[0].includes("machine_token") || !regBodies[0].includes("sealed_token"))
      throw new StepError("la réponse d'inscription vue par la WebView porte le jeton en clair (ou pas de sceau)");
    if ((await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)).map((k) => localStorage.getItem(k) ?? sessionStorage.getItem(k) ?? "").join(" "))).includes(await page.evaluate(() => window.__node.token)))
      throw new StepError("le jeton de machine est dans un stockage web");

    // 3. Une tâche du noyau → long poll → résultat → journal sans contenu.
    const q = await s.dev("/v1/dev/phone/task", { op: "zone.state", args: { zone_id: "zn_maison01" } });
    if (q.status !== 201) throw new StepError(`mise en file : HTTP ${q.status}`);
    const end = Date.now() + STEP_MS;
    let t;
    while (Date.now() < end && (t = await s.dev(`/v1/dev/phone/task/${q.body.task_id}`)).body.status !== "done") await new Promise((r) => setTimeout(r, 200));
    if (t?.body.status !== "done" || !/"inside":true/.test(t.body.result ?? "")) throw new StepError(`tâche zone.state : ${JSON.stringify(t?.body)}`);
    await page.evaluate(() => window.__nodeBeat());
    await until(page, "lecture « fait » au journal", () => [...document.querySelectorAll(".phone-log li")].some((li) => /(Zone check|Vérification de zone).*(done|fait)/.test(li.textContent ?? "")));
    if (/inside|07:30/.test((await card.locator(".phone-log").textContent()) ?? "")) throw new StepError("le journal montre le contenu du résultat");
    await shot(page, `phone-node-live-${dev}`);

    // 3b. P11 : pages par le téléphone. Coupé par défaut ; on l'allume, on ajoute un site.
    if ((await card.locator("[data-phone-egress]").getAttribute("data-phone-egress")) !== "off") throw new StepError("les pages par le téléphone ne sont pas coupées par défaut");
    await card.locator("[data-egress-toggle]").click();
    await until(page, "pages allumées", () => document.querySelector("[data-phone-egress]")?.getAttribute("data-phone-egress") === "on");
    await card.locator("[data-egress-host-input]").fill("nas.local");
    await card.locator("[data-egress-host-add]").click();
    if (!(await card.locator(".phone-egress [role=alert]").count())) throw new StepError("un hôte local a été accepté dans la liste");
    await card.locator("[data-egress-host-input]").fill("*.Meteo.Example.CH");
    await card.locator("[data-egress-host-add]").click();
    await card.locator('[data-egress-host="*.meteo.example.ch"]').waitFor({ timeout: STEP_MS });
    // Données mobiles coupées par défaut ; le plafond n'apparaît qu'une fois autorisées.
    if (await card.locator("[data-egress-cap]").count()) throw new StepError("plafond mobile affiché alors que les données mobiles sont coupées");
    await card.locator("[data-egress-cellular]").click();
    await card.locator("[data-egress-cap]").waitFor({ timeout: STEP_MS });
    await shot(page, `phone-node-egress-${dev}`);
    // On la décoche : le plafond disparaît, et une page en données mobiles sera refusée (cellular_off).
    await card.locator("[data-egress-cellular]").click();
    await until(page, "plafond masqué", () => !document.querySelector("[data-egress-cap]"));
    // Dans le fil : une page refusée → offre → GESTE → page ouverte par le téléphone.
    await page.locator(".back-chat").click();
    await page.waitForSelector(".composer", { timeout: STEP_MS });
    await page.fill("#nk-composer", "ouvre https://tarifs.blocked.example.test/2027");
    await page.keyboard.press("Enter");
    const offerBtn = page.locator("[data-phone-fetch]").last();
    await offerBtn.waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("pas de bouton « Ouvrir par mon téléphone » sur la page refusée");
    });
    if ((await page.evaluate(() => window.__node.fetches.length)) !== 0) throw new StepError("le téléphone a ouvert la page AVANT le geste");
    await offerBtn.click();
    await until(page, "page ouverte par le téléphone", () => [...document.querySelectorAll("[data-phone-fetched] [data-ok='1']")].some((p) => /tarifs\.blocked\.example\.test/.test(p.textContent ?? "")));
    const fetches = await page.evaluate(() => window.__node.fetches);
    if (fetches.length !== 1 || fetches[0].trigger !== "explicit" || !/^pfg_/.test(fetches[0].grant_id ?? "")) throw new StepError(`fetch du geste : ${JSON.stringify(fetches)}`);
    if (!(await page.locator('[data-origin="phone_fetch"]').count())) throw new StepError("le geste n'apparaît pas comme un message de la personne");
    // Échec côté téléphone : la phrase de la table du noyau, d'après le code brut.
    await page.fill("#nk-composer", "ouvre https://lowbat.blocked.example.test/");
    await page.keyboard.press("Enter");
    const lowbat = page.locator("[data-phone-fetch]", { hasText: "lowbat.blocked.example.test" });
    await lowbat.waitFor({ timeout: STEP_MS });
    await lowbat.click();
    await until(page, "échec low_battery affiché", () => [...document.querySelectorAll("[data-phone-fetched] [data-ok='0']")].some((p) => /lowbat\.blocked\.example\.test/.test(p.textContent ?? "") && /(20 %|20 %)/.test(p.textContent ?? "")));
    // Données mobiles non cochées : refus cellular_off, phrase de la table du noyau.
    await page.fill("#nk-composer", "ouvre https://mobile.blocked.example.test/");
    await page.keyboard.press("Enter");
    const cell = page.locator("[data-phone-fetch]", { hasText: "mobile.blocked.example.test" });
    await cell.waitFor({ timeout: STEP_MS });
    await cell.click();
    await until(page, "échec cellular_off affiché", () => [...document.querySelectorAll("[data-phone-fetched] [data-ok='0']")].some((p) => /mobile\.blocked\.example\.test/.test(p.textContent ?? "") && /(Also on mobile data|Aussi en données mobiles)/.test(p.textContent ?? "")));
    // Hôte de la liste : directement par le téléphone, en mode allowlist.
    await page.fill("#nk-composer", "ouvre https://geneve.meteo.example.ch/demain");
    await page.keyboard.press("Enter");
    await until(page, "page de la liste ouverte par le téléphone", () => [...document.querySelectorAll("[data-phone-fetched] [data-ok='1']")].some((p) => /geneve\.meteo\.example\.ch/.test(p.textContent ?? "")));
    const f2 = await page.evaluate(() => window.__node.fetches.at(-1));
    if (f2?.trigger !== "allowlist" || !(f2.allow_hosts ?? []).includes("*.meteo.example.ch")) throw new StepError(`fetch de la liste : ${JSON.stringify(f2)}`);
    await shot(page, `phone-fetch-chat-${dev}`);
    // 3c. P7b : lecture d'une image par le téléphone au-delà de l'attente du tour → bulle phone_task, puis la suite.
    await page.setInputFiles('.composer input[type=file][accept^="image/"]', { name: "facture.png", mimeType: "image/png", buffer: PNG });
    await page.fill("#nk-composer", "lis le texte de l'image");
    await page.keyboard.press("Enter");
    await until(page, "tâche du téléphone en attente", () => !!document.querySelector('[data-phone-tasks] [data-phone-task="pending"]'));
    if (!(await page.evaluate(() => window.__node.ocr?.args?.image_url?.includes("/v1/gateway/phone/blobs/")))) throw new StepError("ocr.image sans blob signé");
    const pendingText = (await page.locator('[data-phone-task="pending"]').first().textContent()) ?? "";
    if (!(E ? /Text from an image: request sent to your phone/ : /Texte d'une image : demande envoyée à ton téléphone/).test(pendingText)) throw new StepError(`bulle phone_task : ${pendingText}`);
    await shot(page, `phone-task-pending-${dev}`);
    await page.evaluate(() => (window.__node.ocrRelease = true));
    await until(page, "suite du téléphone reçue", () => !!document.querySelector('[data-phone-tasks] [data-phone-task="done"]') && /Facture 2027/.test(document.querySelector(".chat")?.textContent ?? document.body.textContent ?? ""));
    if (/\[Téléphone\]/.test((await page.locator("body").textContent()) ?? "")) throw new StepError("le tour de suite (phone_continue) est rendu comme un message");
    await shot(page, `phone-task-done-${dev}`);
    const ow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (ow > 1) throw new StepError(`débordement horizontal dans le fil ${ow}px`);
    // Retour à Mon compte par l'interface (pas de rechargement : la fausse coque garde son état).
    await page.locator(".acct-btn").click();
    await page.locator('.menu-pop [data-view="account"]').click();
    await card.waitFor({ timeout: STEP_MS });

    // 3d. P10a : mode nœud maison → relais Home Assistant (faux HA), lectures seulement, aucune coordonnée.
    const homeBox = card.locator("[data-phone-home]");
    if ((await homeBox.getAttribute("data-phone-home")) !== "off") throw new StepError("le mode maison n'est pas coupé par défaut");
    await card.locator("[data-home-toggle]").click();
    await until(page, "mode maison allumé", () => document.querySelector("[data-phone-home]")?.getAttribute("data-phone-home") === "on");
    // « Toc toc toc » coupé en mode maison (pièce commune) : carte grisée avec sa raison, aucun indicateur d'écoute.
    await until(page, "toc toc toc coupé en mode maison", () => !!document.querySelector('[data-knock-card] [data-knock-blocked="home"]') && document.querySelector("[data-knock-toggle]")?.disabled === true);
    if (await page.locator("[data-knock-indicator]").count()) throw new StepError("indicateur d'écoute visible en mode maison");
    await card.locator("[data-home-url]").fill("https://ha.example.ch");
    await card.locator("[data-home-url-save]").click();
    await until(page, "adresse publique refusée", () => !!document.querySelector(".phone-home [role=alert]"));
    // P10d : « Trouver Home Assistant » ne trouve rien hors du Wi-Fi maison ; la saisie à la main reste possible.
    await card.locator("[data-home-find]").click();
    await card.locator("[data-home-found-none]").waitFor({ timeout: STEP_MS });
    await card.locator("[data-home-url]").fill("http://homeassistant.local:8123");
    await card.locator("[data-home-url-save]").click();
    await card.locator("[data-home-token]").click();
    await until(page, "jeton gardé", () => document.querySelector("[data-home-token-state]")?.getAttribute("data-home-token-state") === "set");
    if ((await page.content()).includes(HA_TOKEN) || (await page.evaluate(() => JSON.stringify(window.__node))).includes(HA_TOKEN)) throw new StepError("le jeton HA est arrivé dans la WebView");
    if ((await homeBox.getAttribute("data-lan-home")) !== "off") throw new StepError("lan_home allumé sans Wi-Fi maison");
    await card.locator("[data-home-wifi-mark]").click();
    await until(page, "relais joignable", () => document.querySelector("[data-phone-home]")?.getAttribute("data-lan-home") === "on");
    // P10d sur le Wi-Fi maison : HA trouvé (le champ se remplit, rien n'est enregistré sans « Enregistrer ») ; appareils
    // listés par nom et type seulement (la route du titulaire est testée dans le faux noyau).
    await card.locator("[data-home-url]").fill("");
    await card.locator("[data-home-find]").click();
    await card.locator('[data-home-found="http://homeassistant.local:8123"]').click();
    if ((await card.locator("[data-home-url]").inputValue()) !== "http://homeassistant.local:8123") throw new StepError("« Trouver Home Assistant » ne remplit pas le champ");
    await card.locator("[data-lan-scan]").click();
    await card.locator('[data-lan-service="TV Salon"]').waitFor({ timeout: STEP_MS });
    if (/\b\d{1,3}(\.\d{1,3}){3}\b|:\d{4}/.test((await card.locator("[data-phone-lan]").textContent()) ?? "")) throw new StepError("adresse ou port affiché dans les appareils de la maison");
    if (!(await card.locator("[data-home-entities-empty]").count())) throw new StepError("la liste d'entités n'est pas vide par défaut");
    await card.locator("[data-home-entity-input]").fill("*.*");
    await card.locator("[data-home-entity-add]").click();
    await until(page, "motif « tout » refusé", () => !!document.querySelector(".phone-home [role=alert]"));
    for (const e of ["light.*", "Person.*"]) {
      await card.locator("[data-home-entity-input]").fill(e);
      await card.locator("[data-home-entity-add]").click();
      await card.locator(`[data-home-entity="${e.toLowerCase()}"]`).waitFor({ timeout: STEP_MS });
    }
    await card.locator("[data-home-check]").click();
    await until(page, "HA répond", () => document.querySelector("[data-home-check-result]")?.getAttribute("data-home-check-result") === "ok");
    await page.evaluate(() => window.__nodeBeat());
    // Le noyau demande les états : par la file, au relais ; pas de coordonnées, rien hors de la liste.
    const hq = await s.dev("/v1/dev/phone/task", { op: "ha.states", args: {} });
    if (hq.status !== 201) throw new StepError(`ha.states en file : HTTP ${hq.status}`);
    let ht;
    const hEnd = Date.now() + STEP_MS;
    while (Date.now() < hEnd && !["done", "failed"].includes((ht = await s.dev(`/v1/dev/phone/task/${hq.body.task_id}`)).body.status)) await new Promise((r) => setTimeout(r, 200));
    const states = JSON.parse(ht?.body.result ?? "{}").states ?? [];
    if (ht?.body.status !== "done" || states.map((x) => x.entity_id).sort().join(",") !== "light.cuisine,light.salon,person.lea") throw new StepError(`ha.states : ${JSON.stringify(ht?.body).slice(0, 200)}`);
    if (/latitude|longitude|gps_accuracy/.test(ht.body.result)) throw new StepError("des coordonnées ont quitté le téléphone");
    const hw = await s.dev("/v1/dev/phone/task", { op: "ha.call_service", args: { domain: "light", service: "turn_on", entity_ids: ["light.salon"] } });
    if (hw.status !== 403 || hw.body?.error?.code !== "attestation_required") throw new StepError(`action HA acceptée pour un nœud non attesté : ${hw.status}`);
    if (ha.calls.length) throw new StepError("un appel de service est parti vers HA");
    await homeBox.scrollIntoViewIfNeeded();
    await shot(page, `phone-home-${dev}`);
    const oh = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (oh > 1) throw new StepError(`débordement horizontal (mode maison) ${oh}px`);
    // 3f. P10c : caméra de veille (coupée par défaut) → détections lues à la demande → vignette chiffrée, une fois.
    const camBox = card.locator("[data-phone-camera]");
    if ((await camBox.getAttribute("data-phone-camera")) !== "off") throw new StepError("la caméra de veille n'est pas coupée par défaut");
    if (!(await card.locator("[data-camera-inform]").count())) throw new StepError("pas de rappel d'informer le foyer");
    await card.locator("[data-camera-toggle]").click();
    await until(page, "veille allumée", () => document.querySelector("[data-phone-camera]")?.getAttribute("data-camera-cap") === "on");
    const now = Math.floor(Date.now() / 1000);
    await page.evaluate((t) => {
      window.__node.camera.events.push({ id: "cam_e2e_1", camera: "Entrée", start: t - 600, end: t - 590, severity: "detection", niveau: "inconnu", title: "personne", summary: null, objects: ["person"], zones: [], has_thumb: true });
      window.__node.camera.events.push({ id: "cam_e2e_2", camera: "Entrée", start: t - 60, end: t - 55, severity: "detection", niveau: "inconnu", title: "mouvement", summary: null, objects: [], zones: [], has_thumb: true });
    }, now);
    await page.evaluate(() => window.__nodeBeat());
    const camPhone = card.locator(`[data-camera-phone]`).first();
    await camPhone.locator("[data-camera-load]").click();
    await camPhone.locator('[data-camera-event="cam_e2e_1"]').waitFor({ timeout: STEP_MS }).catch(() => {
      throw new StepError("les détections ne s'affichent pas");
    });
    const evText = (await camPhone.locator("[data-camera-event]").first().textContent()) ?? "";
    if (!(E ? /movement/ : /mouvement/).test(evText)) throw new StepError(`détection la plus récente d'abord : ${evText}`);
    const personText = (await camPhone.locator('[data-camera-event="cam_e2e_1"]').textContent()) ?? "";
    if (!(E ? /a person/ : /une personne/).test(personText)) throw new StepError(`« une personne » attendu : ${personText}`);
    await camPhone.locator('[data-camera-show="cam_e2e_1"]').click();
    await until(page, "vignette déchiffrée affichée", () => {
      const img = document.querySelector("[data-camera-image] img");
      return !!img && img.complete && img.naturalWidth === 64;
    });
    const thumbKeyInDom = await page.evaluate(() => /[A-Za-z0-9_-]{43}/.test(document.querySelector("[data-camera-events]")?.innerHTML ?? "") || Object.values(localStorage).some((v) => /:8802\/t\//.test(v)));
    if (thumbKeyInDom) throw new StepError("clé ou URL de vignette dans le DOM ou le stockage");
    if (lan.size !== 0) throw new StepError("la vignette est restée servable sur le LAN après la lecture");
    await page.locator("[data-camera-image]").scrollIntoViewIfNeeded();
    await shot(page, `phone-camera-${dev}`);
    // Usage unique : la 2e vignette passe par une NOUVELLE URL ; une URL déjà lue (ou inconnue) est refusée.
    await camPhone.locator('[data-camera-show="cam_e2e_2"]').click();
    await until(page, "2e vignette", () => document.querySelector("[data-camera-image]")?.getAttribute("data-camera-image") === "cam_e2e_2");
    const replay = await page.evaluate(async () => {
      const p = window.Capacitor.Plugins.NokkerNode;
      try {
        await p.fetchLocalImage({ url: `http://192.168.1.50:8802/t/${"A".repeat(32)}`, key: "A".repeat(43), id: "cam_e2e_2" });
        return "served";
      } catch (e) {
        return e.code;
      }
    });
    if (replay !== "thumb_gone") throw new StepError(`URL de vignette rejouée : ${replay}`);
    // Veille coupée → la lecture le dit (502 camera_off, texte de l'app).
    await card.locator("[data-camera-toggle]").click();
    await until(page, "veille coupée", () => document.querySelector("[data-phone-camera]")?.getAttribute("data-phone-camera") === "off");
    await camPhone.locator("[data-camera-load]").click();
    await until(page, "veille éteinte annoncée", () => /(watch camera is off|caméra de veille est éteinte)/.test(document.querySelector("[data-camera-error]")?.textContent ?? ""));
    // 3g. Frapper pour appeler sur le nœud maison : les trois coups iront à la voix du foyer (wall_voice), jamais dans
    // la session complète. Tant qu'elle n'existe pas : réglage caché, allumage refusé par le natif, ancien n°32.
    if (await card.locator("[data-home-knock]").count()) throw new StepError("réglage « Frapper pour appeler » visible alors que la voix du foyer n'existe pas");
    const knockOn = await page.evaluate(async () => {
      try {
        await window.Capacitor.Plugins.NokkerNode.setKnock({ on: true });
        return "on";
      } catch (e) {
        return e.code;
      }
    });
    if (knockOn !== "unavailable") throw new StepError(`allumage du toc toc natif : ${knockOn}`);
    await until(page, "carte toc toc toc : aucune écoute permanente", () => /no permanent listening|aucune écoute permanente/.test(document.querySelector("[data-knock-blocked]")?.textContent ?? ""));
    await card.locator("[data-home-forget]").click();
    await until(page, "mode maison oublié", () => document.querySelector("[data-phone-home]")?.getAttribute("data-phone-home") === "off");
    // Sortie du mode maison : plus de verrou, mais pas de reprise automatique de l'écoute.
    await until(page, "verrou du toc toc toc levé", () => !document.querySelector("[data-knock-blocked]"));
    if (await page.evaluate(() => /listening|starting/.test(document.querySelector("[data-knock-state]")?.getAttribute("data-knock-state") ?? "off"))) throw new StepError("le toc toc toc a repris tout seul à la sortie du mode maison");
    await ha.close();

    // 4. Pause puis reprise ; retrait → révocation, jeton refusé.
    await card.locator("[data-phone-running]").click();
    await until(page, "état en pause", () => document.querySelector("[data-phone-state]")?.getAttribute("data-phone-state") === "paused");
    await card.locator("[data-phone-running]").click();
    await until(page, "reprise", () => document.querySelector("[data-phone-state]")?.getAttribute("data-phone-state") === "live").catch(async (e) => {
      throw new StepError(`${e.message} [${await page.evaluate(() => `${document.querySelector("[data-phone-state]")?.getAttribute("data-phone-state")} ${JSON.stringify({ running: window.__node.running, err: window.__node.err, beat: window.__node.beatStatus })}`)}]`);
    });
    const token = await page.evaluate(() => window.__node.token);
    const beforeRemove = problems.length;
    await card.locator("[data-phone-remove]").click();
    await until(page, "carte revenue à l'inscription", () => document.querySelector("[data-phone-node]")?.getAttribute("data-phone-node") === "none");
    const after = await fetch(`${s.mock}/v1/gateway/phone/beat`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
    if (after.status !== 401) throw new StepError(`jeton encore accepté après retrait : HTTP ${after.status}`);
    const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (o > 1) throw new StepError(`débordement horizontal ${o}px`);
    if (outside.length) throw new StepError(`la fausse coque a parlé à nokker.ai : ${outside[0]}`);
    // Entre la révocation et l'oubli local, le long poll en vol reçoit 401 : attendu, et seulement là.
    // 502 camera_off : voulu (étape 3f, veille coupée puis lecture).
    const real = problems.filter((p, i) => !(i >= beforeRemove && /^HTTP 401 GET \/v1\/gateway\/phone\/tasks/.test(p)) && !/^HTTP 502 GET \/v1\/link\/phone\/[^/]+\/camera\/events/.test(p));
    if (real.length) throw new StepError(real.slice(0, 3).join(" | "));
    report.push(`ok   phone-node ${dev} (empreinte ${fp}, tâche ${t.body.status})`);
  } catch (e) {
    failed++;
    report.push(`FAIL phone-node ${dev}: ${e.message}`);
    await shot(page, `FAIL-phone-node-${dev}`).catch(() => {});
  } finally {
    await ctx.close();
    await ha.close().catch(() => undefined);
    s.stop();
  }
}
await browser.close();
console.log(report.join("\n"));
process.exit(failed ? 1 : 0);
