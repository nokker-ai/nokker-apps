/**
 * Recettes du téléphone (phone-node.mjs, wall.mjs) : serveurs (faux noyau + web), surveillance, connexion, captures,
 * et la FAUSSE COQUE (NokkerNode en WebCrypto, mode maison, écran mural). Dev seulement.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cspWatch, webCommand } from "./web-server.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const MOCK = resolve(WEB, "../../packages/mock-server");
export const STEP_MS = Number(process.env.E2E_STEP_MS ?? 20000);
export const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : null;
export const EMAIL = "alice@example.com";
export const CODE = "123456";
export const ALLOWED_4XX = [
  [404, /\/v1\/(guide|packs|code\/sessions|household\/invitations\/received|sso\/connections|glance\/devices|house|presence|memory\/consolidation\/runs|local\/folder\/runs|payments\/budgets|payments\/mandates|payments\/method|speech|account\/models|capabilities|local\/sites|connectors\/oauth[^?]*)(\?|$)/],
  [401, /\/v1\/local\//],
];
export const HA_TOKEN = `e2e-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light", locale: "fr-CH" };

export class StepError extends Error {}

export const freePort = () =>
  new Promise((ok, ko) => {
    const s = createServer();
    s.once("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

export async function waitHttp(url, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* pas encore */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} injoignable`);
}

export async function servers(extraEnv = {}) {
  const mockPort = await freePort();
  const webPort = await freePort();
  const cfg = mkdtempSync(join(tmpdir(), "nokker-e2e-touch-"));
  const env = { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: cfg, MOCK_PORT: String(mockPort), MOCK_CAPABILITIES: "1", MOCK_CONNECTORS_MULTI: "1", NOKKER_MOCK_PHONE_WAIT_MS: "1500", ...extraEnv };
  const procs = [
    spawn("npx", ["tsx", "src/run.ts"], { cwd: MOCK, env, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("npx", [...webCommand(), "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], {
      cwd: WEB,
      env: { ...process.env, NOKKER_SERVER_URL: `http://127.0.0.1:${mockPort}` },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    }),
  ];
  const stop = () => {
    for (const p of procs) {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        /* parti */
      }
    }
    rmSync(cfg, { recursive: true, force: true });
  };
  process.on("exit", stop);
  await waitHttp(`http://127.0.0.1:${mockPort}/`);
  const base = `http://localhost:${webPort}`;
  await waitHttp(base);
  const mock = `http://127.0.0.1:${mockPort}`;
  const dev = async (path, body) => {
    const r = await fetch(`${mock}${path}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { base, mock, stop, dev };
}

export function watch(page, problems) {
  cspWatch(page, () => page.url().replace(/^https?:\/\/[^/]+/, ""));
  page.on("pageerror", (e) => problems.push(`erreur de page : ${e.message}`));
  page.on("response", (r) => {
    const s = r.status();
    if (s < 400) return;
    const url = r.url();
    if (s < 500 && ALLOWED_4XX.some(([code, re]) => code === s && re.test(url))) return;
    problems.push(`HTTP ${s} ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  });
}

export async function until(page, what, fn, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout: STEP_MS, polling: 100 });
  } catch {
    throw new StepError(`délai dépassé : ${what}`);
  }
}

export async function login(page, base) {
  await page.goto(base);
  await page.waitForSelector("#wl-email", { timeout: STEP_MS });
  await page.fill("#wl-email", EMAIL);
  await page.click("form button[type=submit]");
  await page.waitForSelector("#wl-code", { timeout: STEP_MS });
  await page.fill("#wl-code", CODE);
  await page.keyboard.press("Enter");
}




export async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}


// Fausse coque : NokkerNode en WebCrypto. Le jeton reste dans la mémoire du « plugin » (le trousseau de l'app).
export function fakeShell(mock) {
  window.__NOKKER_FAKE_SHELL__ = true;
  const st = (window.__node = { enrolled: false, running: false, token: null, machine: null, key: null, fp: null, beats: 0, tasks: [], fetches: [], listeners: [], egress: { on: false, cellular: false, cellular_cap_mb: 100, cellular_used_mb: 0 }, home: { on: false, url: null, token: null, entities: [], wifiSet: false, wifi: false, check: null }, camera: { on: false, name: "Maison", sensitivity: "medium", position: "back", permission: "granted", events: [] } });
  const b64u = (u) => btoa(String.fromCharCode(...new Uint8Array(u))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hex = (u) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const status = () => ({ enrolled: st.enrolled, running: st.running, key_storage: "software", key_fingerprint: st.fp ?? undefined, machine_id: st.machine ?? undefined, last_beat_at: st.lastBeat, last_error: st.err, egress: { ...st.egress }, home: homeStatus(), knock: knockStatus() });
  // Frapper pour appeler (natif) : écoute seulement en mode maison, au premier plan (toujours ici).
  // Tant que la voix du foyer (wall_voice) n'existe pas : indisponible, comme le natif (`available: false`).
  const knockStatus = () => ({ on: false, cut: false, permission: "granted", state: "off", available: false });
  // P10a : le « natif » du nœud maison. Le jeton reste ICI (le trousseau) ; la WebView ne voit que `ha_token_set`.
  const lanHome = () => st.home.on && !!st.home.url && !!st.home.token && st.home.wifi;
  // P10c : la veille ne « tourne » qu'en mode maison (la fausse coque est toujours en charge et au premier plan).
  const camCap = () => (st.camera.on && st.home.on && st.camera.permission === "granted" ? "on" : "off");
  const cameraStatus = () => ({ on: st.camera.on, name: st.camera.name, sensitivity: st.camera.sensitivity, position: st.camera.position, permission: st.camera.permission, cap: camCap(), events: st.camera.events.length, bytes: 0 });
  const homeStatus = () => ({ camera: cameraStatus(), on: st.home.on, ha_url: st.home.url, ha_token_set: !!st.home.token, entities: [...st.home.entities], home_wifi_set: st.home.wifiSet, home_wifi: st.home.wifi, ha_check: st.home.check, lan_home: lanHome() ? "on" : "off" });
  // Même règle que NokkerHome.normalizeBase : http(s), .local ou adresse privée, sans chemin.
  const baseOf = (raw) => {
    const m = /^(https?):\/\/([a-z0-9-]+\.local|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?\/?$/.exec(String(raw).trim().toLowerCase());
    return m ? `${m[1]}://${m[2]}${m[3] ?? ""}` : null;
  };
  const emit = () => st.listeners.forEach((cb) => cb(status()));
  const LAN = [
    { id: "a1b2c3d4e5f60718", type: "_googlecast._tcp", types: ["_googlecast._tcp", "_raop._tcp"], name: "TV Salon" },
    { id: "0f1e2d3c4b5a6978", type: "_sonos._tcp", types: ["_sonos._tcp"], name: "Cuisine" },
  ];
  // Le « trousseau » de la fausse coque vit côté Node (`__kcGet`/`__kcSet` de la recette) : l'inscription du nœud et
  // les réglages maison survivent à un rechargement, comme dans l'app (le natif garde clé et jeton). Clé de test
  // exportable (JWK) : seulement dans la fausse coque.
  const persist = () =>
    window.__kcSet?.("fake-node", st.enrolled ? JSON.stringify({ jwk: st.jwk, token: st.token, machine: st.machine, base: st.base, fp: st.fp, home: st.home, egress: st.egress, camera: st.camera, running: st.running }) : null);
  const restored = (async () => {
    const raw = await window.__kcGet?.("fake-node");
    if (!raw) return;
    const o = JSON.parse(raw);
    const alg = { name: "ECDSA", namedCurve: "P-256" };
    const key = { privateKey: await crypto.subtle.importKey("jwk", o.jwk.priv, alg, true, ["sign"]), publicKey: await crypto.subtle.importKey("jwk", o.jwk.pub, alg, true, ["verify"]) };
    Object.assign(st, { key, jwk: o.jwk, token: o.token, machine: o.machine, base: o.base, fp: o.fp, home: o.home, egress: o.egress, camera: o.camera ?? st.camera, enrolled: true, running: o.running });
    if (st.running) {
      await beat();
      void loop();
    }
  })().catch(() => undefined);
  async function call(method, pq, body) {
    const raw = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const ts = Math.floor(Date.now() / 1000);
    const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const host = new URL(mock).host;
    const msg = `${method}\n${host}\n${pq}\n${ts}\n${nonce}\n${hex(await crypto.subtle.digest("SHA-256", raw))}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, st.key.privateKey, new TextEncoder().encode(msg));
    const r = await fetch(mock + pq, { method, headers: { Authorization: `Bearer ${st.token}`, "X-Nokker-Node-Proof": `v1;ts=${ts};nonce=${nonce};sig=${b64u(sig)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: raw }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const beat = async () => {
    const r = await call("POST", "/v1/gateway/phone/beat", { v: 1, app_version: "0.1.0", os: "iOS 18.2", mode: st.home.on ? "home" : "pocket", reach: "live", power: { charging: true, level: 0.9 }, net: { type: "wifi", metered: false, home_wifi: st.home.wifi }, caps: { location: "on", device_calendar: "on", ocr: "on", stt: "off", egress: st.egress.on ? "on" : "off", lan_home: lanHome() ? "on" : "off", camera: camCap() }, queue: { leased: 0 }, slm: null });
    st.beatStatus = r.status;
    if (r.status === 200) (st.beats++, (st.lastBeat = new Date().toISOString()), (st.err = undefined));
    else st.err = `beat_${r.status}`;
    emit();
  };
  async function loop() {
    while (st.running) {
      const r = await call("GET", "/v1/gateway/phone/tasks?wait=2").catch(() => null);
      if (!st.running) return;
      if (r?.status !== 200) return void (st.err = `poll_${r?.status}`, emit());
      for (const t of r.body.tasks) {
        st.tasks.push(t.op);
        if (t.op === "fetch.get") st.fetches.push(t.args);
        // Échec joué par le « natif » : batterie trop faible pour un hôte de test.
        // Hôte « mobile » : le téléphone est en données mobiles ; sans la case cochée, refus cellular_off (comme le natif).
        if (t.op === "fetch.get" && /mobile\./.test(t.args.url) && !st.egress.cellular) {
          await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, { status: "failed", error: { code: "cellular_off" } });
          continue;
        }
        if (t.op === "fetch.get" && /lowbat/.test(t.args.url)) {
          await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, { status: "failed", error: { code: "low_battery" } });
          continue;
        }
        // P10c : caméra de veille — texte des événements ; vignette chiffrée (AES-256-GCM, AAD nokker-thumb-v1|<id>)
        // déposée sur le « LAN » simulé côté Node, servie UNE fois.
        if (t.op === "lan.discover") {
          await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, st.home.wifi ? { status: "done", result: JSON.stringify({ services: LAN, at: new Date().toISOString() }) } : { status: "failed", error: { code: "not_home_wifi" } });
          continue;
        }
        if (t.op === "camera.watch_event") {
          const r = !st.camera.on ? { status: "failed", error: { code: "camera_off" } } : { status: "done", result: JSON.stringify({ items: st.camera.events.filter((e) => e.start > (t.args.after ?? 0)), now: Date.now() / 1000 }) };
          await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, r);
          continue;
        }
        if (t.op === "camera.thumb_url") {
          const e = st.camera.events.find((x) => x.id === t.args.id);
          if (!e) {
            await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, { status: "failed", error: { code: "not_found" } });
            continue;
          }
          const cv = document.createElement("canvas");
          cv.width = 64;
          cv.height = 48;
          const g = cv.getContext("2d");
          g.fillStyle = "#3a6";
          g.fillRect(0, 0, 64, 48);
          const jpeg = Uint8Array.from(atob(cv.toDataURL("image/jpeg").split(",")[1]), (c) => c.charCodeAt(0));
          const raw = crypto.getRandomValues(new Uint8Array(32));
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const k = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
          const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`nokker-thumb-v1|${e.id}`) }, k, jpeg));
          const data = new Uint8Array(12 + ct.length);
          data.set(iv);
          data.set(ct, 12);
          const token = b64u(crypto.getRandomValues(new Uint8Array(24)));
          await window.__lanPut(token, b64u(data));
          st.lastJpeg = b64u(jpeg);
          await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, { status: "done", result: JSON.stringify({ id: e.id, url: `http://192.168.1.50:8802/t/${token}`, key: b64u(raw), expires_in: 300 }) });
          continue;
        }
        // P10a : relais HA par le relais de référence (côté Node, contre le faux HA), comme le natif.
        if (t.op.startsWith("ha.")) {
          st.haTasks = (st.haTasks ?? 0) + 1;
          const r = lanHome() ? await window.__haRun(t.op, t.args, { entities: st.home.entities }) : { error: "not_home_wifi" };
          await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, r.error ? { status: "failed", error: { code: r.error } } : { status: "done", result: JSON.stringify(r.result) });
          continue;
        }
        // P7b : lecture d'image retenue jusqu'au feu vert du test (au-delà de l'attente du noyau → phone_tasks).
        if (t.op === "ocr.image") {
          st.ocr = t;
          while (!st.ocrRelease && st.running) await new Promise((r) => setTimeout(r, 50));
          await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, { status: "done", result: JSON.stringify({ text: "Facture 2027 — total 84.00" }) });
          continue;
        }
        const result =
          t.op === "zone.state"
            ? JSON.stringify({ inside: true, since: "2026-11-06T07:30:00Z" })
            : t.op === "fetch.get"
              ? JSON.stringify({ status: 200, final_url: t.args.url, content_type: "text/html", charset: "utf-8", text: "<p>Grille 2027</p>", bytes: 18, truncated: false, hops: 0 })
              : null;
        await call("POST", `/v1/gateway/phone/tasks/${t.task_id}/result`, result ? { status: "done", result } : { status: "failed", error: { code: "unknown_op" } });
      }
    }
  }
  const plugin = {
    status: async () => (await restored, status()),
    prepareKey: async () => {
      if (!st.key) {
        st.key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        st.jwk = { priv: await crypto.subtle.exportKey("jwk", st.key.privateKey), pub: await crypto.subtle.exportKey("jwk", st.key.publicKey) };
      }
      st.agree ??= await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const spki = await crypto.subtle.exportKey("spki", st.key.publicKey);
      st.fp = hex(await crypto.subtle.digest("SHA-256", spki)).slice(0, 8);
      return { public_key_spki: b64u(spki), enc_key_spki: b64u(await crypto.subtle.exportKey("spki", st.agree.publicKey)), key_storage: "software", key_fingerprint: st.fp };
    },
    // Ce que fait le natif : ouvrir le sceau (ECDH → HKDF info nokker-phone-v1|<approval_id> → AES-GCM, AAD = approval_id).
    enroll: async (o) => {
      const fromB64u = (x) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const t = o.sealed_token;
      const epk = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: t.epk.x, y: t.epk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, st.agree.privateKey, 256);
      const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`nokker-phone-v1|${o.approval_id}`) }, hk, 256);
      const k = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(t.iv), additionalData: new TextEncoder().encode(o.approval_id) }, k, fromB64u(t.ct));
      st.token = JSON.parse(new TextDecoder().decode(pt)).machine_token;
      return (st.machine = o.machine_id), (st.base = o.base_url), (st.enrolled = true), await persist(), status();
    },
    start: async () => ((st.running = true), await persist(), await beat(), void loop(), status()),
    stop: async () => ((st.running = false), await persist(), status()),
    forget: async () => (Object.assign(st, { enrolled: false, running: false, machine: null, key: null, jwk: null, fp: null }), await persist(), status()),
    setEgress: async (o) => {
      if (typeof o.on === "boolean") st.egress.on = o.on;
      if (typeof o.cellular === "boolean") st.egress.cellular = o.cellular;
      if (typeof o.cellular_cap_mb === "number") st.egress.cellular_cap_mb = o.cellular_cap_mb;
      await beat();
      await persist();
      return status();
    },
    setHome: async (o) => {
      if (typeof o.ha_url === "string") {
        const b = baseOf(o.ha_url);
        if (!b) throw Object.assign(new Error("bad_url"), { code: "bad_url" });
        st.home.url = b;
      }
      if (Array.isArray(o.entities)) st.home.entities = o.entities;
      if (typeof o.on === "boolean") st.home.on = o.on;
      await beat();
      await persist();
      return status();
    },
    // Ce que fait le champ natif sécurisé : le jeton est saisi hors de la WebView.
    promptHaToken: async () => ((st.home.token = await window.__haPrompt()), await persist(), { saved: true }),
    markHomeWifi: async () => ((st.home.wifiSet = true), (st.home.wifi = true), await persist(), await beat(), { ...status(), ok: true }),
    checkHa: async () => {
      const r = await window.__haRun("ha.states", {}, { entities: st.home.entities });
      st.home.check = r.error ?? "ok";
      await persist();
      return status();
    },
    // P10b : le trousseau est côté Node (survit aux navigations, jamais dans un stockage web).
    setWall: async (o) => ((await window.__kcSet("wall-active", o.on ? "1" : null)), { on: !!o.on, night: false }),
    wallToken: async () => ({ token: await window.__kcGet("wall-token"), device_id: await window.__kcGet("wall-device"), night: false, active: !!(await window.__kcGet("wall-active")) }),
    setWallToken: async (o) => {
      await window.__kcSet("wall-token", o.token ?? null);
      await window.__kcSet("wall-device", o.device_id ?? null);
      if (!o.token) await window.__kcSet("wall-active", null);
      return { stored: !!o.token };
    },
    // Code de l'appareil et biométrie : réglés côté Node par la recette (succès et refus).
    wallCheck: async () => ({ passcode: !!(await window.__passcode?.()) }),
    authenticateExit: async () => ({ ok: !!(await window.__authOk?.()) }),
    setCamera: async (o) => {
      if (typeof o.name === "string") st.camera.name = o.name;
      if (o.sensitivity) st.camera.sensitivity = o.sensitivity;
      if (o.position) st.camera.position = o.position;
      if (typeof o.on === "boolean") st.camera.on = o.on;
      await persist();
      await beat();
      return status();
    },
    // Ce que fait le natif du téléphone du titulaire : lit le chiffré sur le LAN (une fois) et le déchiffre.
    fetchLocalImage: async (o) => {
      const m = /^http:\/\/192\.168\.\d+\.\d+:8802\/t\/([A-Za-z0-9_-]{32})$/.exec(o.url);
      if (!m) throw Object.assign(new Error("bad_args"), { code: "bad_args" });
      const b = await window.__lanGet(m[1]);
      if (!b) throw Object.assign(new Error("thumb_gone"), { code: "thumb_gone" });
      const fromB = (x) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(x.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
      const data = fromB(b);
      const k = await crypto.subtle.importKey("raw", fromB(o.key), { name: "AES-GCM" }, false, ["decrypt"]);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12), additionalData: new TextEncoder().encode(`nokker-thumb-v1|${o.id}`) }, k, data.slice(12)));
      let bin = "";
      for (const x of plain) bin += String.fromCharCode(x);
      return { data: btoa(bin), type: "image/jpeg" };
    },
    // P10d : ce que rend le natif APRÈS son filtre (le filtre lui-même est testé dans le SDK et par l'autotest iOS).
    discoverHa: async () => ({ candidates: st.home.wifi ? [{ name: "Home", url: "http://homeassistant.local:8123" }] : [] }),
    discoverLan: async () => {
      if (!st.home.wifi) throw Object.assign(new Error("not_home_wifi"), { code: "not_home_wifi" });
      return { services: LAN, at: new Date().toISOString() };
    },
    forgetHome: async () => ((st.home = { on: false, url: null, token: null, entities: [], wifiSet: false, wifi: false, check: null }), await persist(), await beat(), status()),
    setKnock: async () => {
      throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    },
    addListener: (_ev, cb) => (st.listeners.push(cb), { remove: () => (st.listeners = st.listeners.filter((x) => x !== cb)) }),
  };
  window.__nodeBeat = beat;
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: { NokkerNode: plugin } };
}
