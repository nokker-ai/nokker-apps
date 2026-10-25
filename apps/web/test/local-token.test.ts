import { beforeEach, describe, expect, it, vi } from "vitest";
import { takeLocalToken } from "../src/onboarding/localToken.js";

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
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
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
});
