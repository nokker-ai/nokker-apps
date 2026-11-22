import { describe, expect, it } from "vitest";
import { isNativeShell, nativePlatform, NATIVE_DEFAULT_SERVER, purchasesAllowed, resolveServerUrl, storeBuild } from "../src/platform/native.js";
import { signBlocker } from "../src/approvals/remote.js";

const shell = (platform: string) => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => platform } });
const web = { Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" } };

describe("coque native (LOKKAL-PHONE §1.1)", () => {
  it("détecte la coque Capacitor, jamais un navigateur (pont absent, faux ou qui lève)", () => {
    expect(isNativeShell(shell("ios"))).toBe(true);
    expect(nativePlatform(shell("android"))).toBe("android");
    expect(isNativeShell(web)).toBe(false);
    expect(isNativeShell({})).toBe(false);
    expect(isNativeShell({ Capacitor: { isNativePlatform: () => { throw new Error("x"); } } })).toBe(false);
    expect(nativePlatform({})).toBe("web");
  });
  it("W1 : base de l'API absolue dans l'app, même origine dans le web, celle de la build sinon", () => {
    expect(resolveServerUrl(undefined, "capacitor://localhost", true)).toBe(NATIVE_DEFAULT_SERVER);
    expect(resolveServerUrl(undefined, "https://app.nokker.ai", false)).toBe("https://app.nokker.ai");
    expect(resolveServerUrl("https://beta.nokker.ai/", "capacitor://localhost", true)).toBe("https://beta.nokker.ai");
  });
  it("W11 : aucun achat dans une build de magasin (variable de build ou plateforme native)", () => {
    expect(storeBuild("ios", {})).toBe("ios");
    expect(storeBuild(undefined, shell("android"))).toBe("android");
    expect(storeBuild(undefined, web)).toBeNull();
    expect(storeBuild("autre", {})).toBeNull();
    expect(purchasesAllowed(null)).toBe(true);
    expect(purchasesAllowed("ios")).toBe(false);
  });
  it("W12 : la vue web de la coque n'est pas un « navigateur intégré » à fuir", () => {
    const wv = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    expect(signBlocker({ ua: wv, webauthn: true, telegram: false })).toEqual({ kind: "in_app", app: null });
    expect(signBlocker({ ua: wv, webauthn: true, telegram: false, native: true })).toBeNull();
  });
});

import { externalHref } from "../src/platform/native.js";
import { createNav, type HistoryLike } from "../src/nav/history.js";

describe("liens externes dans la coque", () => {
  const a = (href: string | null) => ({ getAttribute: () => href });
  it("http(s) → navigateur système ; liens internes, ancres et mailto restent", () => {
    expect(externalHref(a("https://nokker.ai/beta"))).toBe("https://nokker.ai/beta");
    expect(externalHref(a("http://example.org"))).toBe("http://example.org");
    for (const h of ["/account", "#/t/x", "mailto:a@b.c", null]) expect(externalHref(a(h))).toBeNull();
  });
});

/** Historique factice : une pile, un index, `popstate` rejoué à la main. */
function fakeHistory() {
  const stack: Array<{ state: unknown; url: string }> = [{ state: null, url: "/" }];
  let i = 0;
  let onPop: (s: unknown) => void = () => undefined;
  const h: HistoryLike & { stack: typeof stack; index: () => number; listen: (f: (s: unknown) => void) => void } = {
    get state() {
      return stack[i]!.state;
    },
    pushState(state, _u, url) {
      stack.splice(i + 1);
      stack.push({ state, url: url ?? stack[i]!.url });
      i++;
    },
    replaceState(state, _u, url) {
      stack[i] = { state, url: url ?? stack[i]!.url };
    },
    back() {
      if (i === 0) return;
      i--;
      onPop(stack[i]!.state);
    },
    stack,
    index: () => i,
    listen: (f) => void (onPop = f),
  };
  return h;
}

describe("historique de la coque (W2)", () => {
  it("vue → retour au chat ; tiroir → le retour le ferme d'abord ; choisir dans le tiroir ne laisse pas d'entrée morte", () => {
    const h = fakeHistory();
    const seen: string[] = [];
    const nav = createNav(h, "chat", (e) => seen.push(`${e.tab}${e.drawer ? "+tiroir" : ""}`));
    h.listen((s) => nav.onPop(s));
    nav.go("account");
    nav.openDrawer();
    expect(nav.current()).toMatchObject({ tab: "account", drawer: true });
    h.back(); // ferme le tiroir
    expect(nav.current()).toMatchObject({ tab: "account", drawer: false });
    h.back(); // revient au chat
    expect(nav.current()).toMatchObject({ tab: "chat", drawer: false });
    nav.openDrawer();
    nav.closeDrawer(() => nav.go("connectors")); // une vue choisie dans le tiroir : appliquée après le retour
    expect(nav.current()).toMatchObject({ tab: "connectors", drawer: false });
    h.back();
    expect(nav.current().tab).toBe("chat");
    expect(h.index()).toBe(0);
    nav.go("chat"); // déjà là : rien
    expect(h.index()).toBe(0);
    expect(seen[0]).toBe("account");
  });
  it("fermer le tiroir par la croix revient en arrière ; une entrée d'un autre (lien de fil) ferme seulement le tiroir", () => {
    const h = fakeHistory();
    const nav = createNav(h, "chat", () => undefined);
    h.listen((s) => nav.onPop(s));
    nav.openDrawer();
    nav.closeDrawer();
    expect(h.index()).toBe(0);
    expect(nav.current().drawer).toBe(false);
    nav.openDrawer();
    expect(nav.onPop(null)).toBeNull();
    expect(nav.current().drawer).toBe(false);
  });
});

import { keyboardHeight } from "../src/platform/viewport.js";
describe("clavier ouvert (W7)", () => {
  it("hauteur visible seulement quand le clavier mange la page", () => {
    expect(keyboardHeight(844, { height: 844, offsetTop: 0 })).toBeNull();
    expect(keyboardHeight(844, { height: 800, offsetTop: 0 })).toBeNull(); // barre d'adresse, pas un clavier
    expect(keyboardHeight(844, { height: 508.4, offsetTop: 0 })).toBe(508);
    expect(keyboardHeight(844, { height: 508, offsetTop: 300 })).toBeNull(); // défilé, pas réduit
  });
});

import { nativeHaptics } from "../src/platform/native.js";
describe("vibrations dans l'app (W10)", () => {
  it("une impulsion par « marche » du motif, aux bons instants ; rien hors de l'app", () => {
    const calls: string[] = [];
    const plug = { vibrate: (o: { duration: number }) => void calls.push(`v${o.duration}`), impact: () => void calls.push("i") };
    const at: number[] = [];
    const later = (f: () => void, ms: number) => {
      at.push(ms);
      f();
    };
    const and = { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android", Plugins: { Haptics: plug } } };
    expect(nativeHaptics([30, 70, 30, 70, 40], and, later)).toBe(true);
    expect(calls).toEqual(["v30", "v30", "v40"]);
    expect(at).toEqual([100, 200]);
    calls.length = 0;
    const ios = { Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: { Haptics: plug } } };
    nativeHaptics([30, 70, 30], ios, later);
    expect(calls).toEqual(["i", "i"]);
    expect(nativeHaptics([30], {}, later)).toBe(false);
  });
});

import { deviceKeys, type NativeKeysPlugin, type WebKeyStore } from "../src/platform/keys.js";
describe("clé d'appareil (W3)", () => {
  it("web : paire non extractible, rangée puis relue ; elle signe ; oubliée", async () => {
    let saved: Parameters<WebKeyStore["put"]>[0] | undefined;
    const store: WebKeyStore = { put: async (v) => void (saved = v), get: async () => saved, remove: async () => void (saved = undefined) };
    const k = deviceKeys(store, {});
    expect(k.kind).toBe("web");
    const g = await k.generate();
    const h = await g.commit("dev_1");
    expect(saved?.privateKey.extractable).toBe(false);
    expect((await k.load())?.deviceId).toBe("dev_1");
    expect((await h.sign("abc", "login")).length).toBeGreaterThan(20);
    await k.forget();
    expect(await k.load()).toBeUndefined();
  });
  it("native : le plugin de la coque, s'il existe", async () => {
    const p: NativeKeysPlugin = {
      generate: async () => ({ key_ref: "r1", public_key: "PUB" }),
      commit: async () => undefined,
      load: async () => ({ device_id: "dev_9", public_key: "PUB" }),
      sign: async ({ challenge }) => ({ signature: `sig:${challenge}` }),
      forget: async () => undefined,
    };
    const w = { Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: { NokkerKeys: p } } };
    const k = deviceKeys({} as WebKeyStore, w);
    expect(k.kind).toBe("native");
    expect(await (await k.load())!.sign("c", "login")).toBe("sig:c");
    expect(deviceKeys({} as WebKeyStore, { Capacitor: { isNativePlatform: () => true } }).kind).toBe("web");
  });
});

import { fakeShellAllowed } from "../src/platform/native.js";
describe("fausse coque des recettes e2e (garde)", () => {
  const flag = { __NOKKER_FAKE_SHELL__: true };
  it("acceptée seulement en développement, hors build de magasin, avec le drapeau", () => {
    expect(fakeShellAllowed({ DEV: true }, flag)).toBe(true);
    expect(fakeShellAllowed({ DEV: false }, flag)).toBe(false); // build de production : ignorée
    expect(fakeShellAllowed({ DEV: true, VITE_NOKKER_STORE_BUILD: "ios" }, flag)).toBe(false); // build de magasin
    expect(fakeShellAllowed({ DEV: true }, {})).toBe(false);
    expect(fakeShellAllowed({ DEV: true }, { __NOKKER_FAKE_SHELL__: "1" })).toBe(false);
  });
  it("la vraie coque parle toujours à app.nokker.ai ; la fausse garde la base du mock", () => {
    expect(resolveServerUrl(undefined, "capacitor://localhost", true, false)).toBe(NATIVE_DEFAULT_SERVER);
    expect(resolveServerUrl(undefined, "http://localhost:5173", true, true)).toBe("http://localhost:5173");
    expect(resolveServerUrl("https://app.nokker.ai", "http://localhost:5173", true, true)).toBe("https://app.nokker.ai");
  });
});
