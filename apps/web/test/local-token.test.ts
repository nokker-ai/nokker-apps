import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLocalToken, keepLocalToken, takeLocalToken } from "../src/onboarding/localToken.js";

/** Un `window` minimal : pas de jsdom dans ce paquet. */
function fakeWindow(hash: string, stored?: string) {
  const store = new Map<string, string>(stored ? [["nokker.local-token", stored]] : []);
  const w = {
    location: { hash, pathname: "/setup", search: "" },
    history: {
      replaceState: vi.fn((_s: unknown, _t: string, url: string) => {
        w.location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
      }),
    },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  };
  vi.stubGlobal("window", w);
  return w;
}

beforeEach(() => vi.unstubAllGlobals());

describe("jeton local (fragment #token)", () => {
  it("lit le fragment, l'efface de la barre d'adresse et le garde en sessionStorage", () => {
    const w = fakeWindow("#token=abc123");
    expect(takeLocalToken()).toBe("abc123");
    expect(w.history.replaceState).toHaveBeenCalledWith(null, "", "/setup");
    expect(w.location.hash).toBe("");
    expect(takeLocalToken()).toBe("abc123");
  });

  it("sans fragment : reprend celui de sessionStorage ; sinon null", () => {
    fakeWindow("", "gardé");
    expect(takeLocalToken()).toBe("gardé");
    fakeWindow("");
    expect(takeLocalToken()).toBeNull();
  });

  it("sessionStorage qui jette : le jeton du fragment reste utilisable", () => {
    const w = fakeWindow("#token=xyz");
    w.sessionStorage.setItem = () => {
      throw new Error("bloqué");
    };
    expect(takeLocalToken()).toBe("xyz");
  });

  it("Lokkal: kept in localStorage, so a new tab opens without pasting it again; forgotten on a 401", () => {
    const local = new Map<string, string>();
    const w = fakeWindow("#token=k1") as ReturnType<typeof fakeWindow> & { localStorage: unknown };
    const ls = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) };
    w.localStorage = ls;
    expect(takeLocalToken()).toBe("k1");
    expect(local.get("nokker.local-token")).toBe("k1");
    // New tab: empty sessionStorage, same localStorage.
    const tab = fakeWindow("") as ReturnType<typeof fakeWindow> & { localStorage: unknown };
    tab.localStorage = ls;
    expect(takeLocalToken()).toBe("k1");
    // A 401 for an older key in flight does not erase the newer one.
    forgetLocalToken("k0-older");
    expect(local.get("nokker.local-token")).toBe("k1");
    forgetLocalToken("k1");
    expect(local.size).toBe(0);
    expect(takeLocalToken()).toBeNull();
  });

  it("not persistent (the mock): the tab only", () => {
    const local = new Map<string, string>();
    const w = fakeWindow("") as ReturnType<typeof fakeWindow> & { localStorage: unknown };
    w.localStorage = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) };
    keepLocalToken("k2", { persistent: false });
    expect(local.size).toBe(0);
    expect(takeLocalToken()).toBe("k2");
  });
});
