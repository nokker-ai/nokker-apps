import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { redeemSessionCode, takeCodeFromHash, takeCodeNote } from "../src/onboarding/sessionCode.js";
import { takeLocalToken } from "../src/onboarding/localToken.js";

/** Un `window` minimal : fragment modifiable, historique observable, deux stockages. */
function fakeWindow(hash: string) {
  const store = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
  };
  const w = {
    location: { hash, pathname: "/setup", search: "", origin: "http://127.0.0.1:8743", hostname: "127.0.0.1" },
    history: { replaceState: vi.fn((_s: unknown, _t: string, url: string) => { w.location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : ""; }) },
    localStorage: store(),
    sessionStorage: store(),
  };
  vi.stubGlobal("window", w);
  return w;
}
afterEach(() => vi.unstubAllGlobals());

describe("lien #code= : le fragment part AVANT le réseau", () => {
  it("lit le code, efface le fragment (un #token= voisin reste pour la transition)", () => {
    const w = fakeWindow("#code=AbC-123_xyz");
    expect(takeCodeFromHash()).toBe("AbC-123_xyz");
    expect(w.history.replaceState).toHaveBeenCalledWith(null, "", "/setup");
    expect(w.location.hash).toBe("");
    const w2 = fakeWindow("#token=old&code=NEWCODE");
    expect(takeCodeFromHash()).toBe("NEWCODE");
    expect(w2.location.hash).toBe("#token=old");
    fakeWindow("#nothing");
    expect(takeCodeFromHash()).toBeNull();
  });

  it("échange réussi : le jeton de session est gardé (le jeton local n'est pas nécessaire), jamais d'Authorization", async () => {
    fakeWindow("");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify({ token: "SESSION-TOKEN", expires_in: 2592000 }), { status: 200 }))) as unknown as typeof fetch;
    expect(await redeemSessionCode("http://127.0.0.1:8742/", "CODE", { fetchImpl: f })).toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8742/v1/local/session-code/exchange");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ code: "CODE" });
    expect(JSON.stringify(calls[0]!.init.headers ?? {})).not.toMatch(/authorization/i);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(takeLocalToken()).toBe("SESSION-TOKEN"); // l'app le retrouve comme elle retrouvait le jeton local
  });

  it("échecs : déjà servi, périmé, trop d'essais, injoignable — jamais de jeton, la raison est dite une fois", async () => {
    for (const [status, body, note] of [
      [410, { error: { code: "code_used" } }, "used"],
      [410, { error: { code: "code_expired" } }, "expired"],
      [429, { error: { code: "rate_limited" } }, "limited"],
      [500, "oops", "unreachable"],
    ] as const) {
      const w = fakeWindow("");
      const f = vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
      expect(await redeemSessionCode("http://127.0.0.1:8742", "X", { fetchImpl: f })).toBe(false);
      expect(w.localStorage.getItem("nokker.local-token")).toBeNull();
      expect(takeCodeNote()).toBe(note);
      expect(takeCodeNote()).toBeNull(); // lue une fois
    }
    fakeWindow("");
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await redeemSessionCode("http://127.0.0.1:8742", "X", { fetchImpl: down })).toBe(false);
    expect(takeCodeNote()).toBe("unreachable");
  });
});

describe("page de clé : le lien qui a échoué le dit, une seule fois, avec le moyen d'en obtenir un autre", () => {
  // Importé APRÈS avoir posé un `window` : la page de clé touche `window.location` au chargement (api.ts).
  let Help: typeof import("../src/onboarding/LocalKey.js").LocalKeyHelp;
  const page = (lang: "fr" | "en"): string => renderToStaticMarkup(createElement(Help, { lang, origin: "http://127.0.0.1:8743", onOpened: () => undefined }));
  beforeAll(async () => {
    fakeWindow("");
    Help = (await import("../src/onboarding/LocalKey.js")).LocalKeyHelp;
  });
  it("déjà servi / périmé / trop d'essais / injoignable, en français et en anglais ; rien quand le lien n'a pas échoué", () => {
    for (const [note, fr, en] of [["used", "déjà servi", "already been used"], ["expired", "a expiré", "has expired"], ["limited", "essais de lien en peu de temps", "Too many link attempts"], ["unreachable", "pas répondu à ce lien", "did not answer"]] as const) {
      const w = fakeWindow("");
      w.sessionStorage.setItem("nokker.code-note", note);
      const frHtml = page("fr"); // la page lit la raison UNE fois (puis l'oublie)
      expect(frHtml).toContain(fr);
      expect(frHtml).toContain("data-code-note");
      expect(page("fr")).not.toContain("data-code-note"); // un rechargement ne la répète pas
      w.sessionStorage.setItem("nokker.code-note", note);
      const enHtml = page("en");
      expect(enHtml).toContain(en);
      expect(enHtml).toContain("nokker open");
    }
    fakeWindow("");
    expect(page("en")).not.toContain("data-code-note");
  });
  it("la page ne propose QUE le code : plus de fichier de clé locale à copier, champ « Code d'ouverture », jamais masqué en mot de passe", () => {
    fakeWindow("");
    for (const lang of ["fr", "en"] as const) {
      const html = page(lang);
      expect(html).toContain("nokker open --code");
      expect(html).not.toMatch(/local-token|cat ~|\.nokker\/state/);
      expect(html).toContain(lang === "fr" ? "Code d&#x27;ouverture" : "Opening code");
      expect(html).not.toContain('type="password"');
    }
  });
  it("la consigne de la page dit #code= (plus #token=) et les 60 secondes", () => {
    fakeWindow("");
    const html = page("en");
    expect(html).toContain("#code=");
    expect(html).toContain("60 seconds");
    expect(html).not.toContain("#token=");
  });
});
