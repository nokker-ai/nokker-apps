import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("surface web : onglet ou application installée", () => {
  const load = async () => (await import("../src/surface.js")).webSurface;
  it("onglet du navigateur → web", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", {});
    expect((await load())()).toBe("web");
  });
  it("display-mode standalone (PWA installée) → pwa", async () => {
    vi.stubGlobal("window", { matchMedia: (q: string) => ({ matches: q.includes("standalone") }) });
    vi.stubGlobal("navigator", {});
    expect((await load())()).toBe("pwa");
  });
  it("Safari iOS : navigator.standalone → pwa ; pas de matchMedia → web", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { standalone: true });
    expect((await load())()).toBe("pwa");
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    expect((await load())()).toBe("web");
  });
});
