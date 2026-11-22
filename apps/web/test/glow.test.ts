import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GLOW_CLASS,
  GLOW_STORAGE_KEY,
  currentGlowMode,
  glowEnabled,
  glowFlag,
  glowMode,
  hasWebGL,
  installGlow,
  isAppleWebKit,
  mixHex,
  parseHex,
  resetGlowProbeForTests,
} from "../src/visual/glow.js";
import { WallGlow, wallGlowColors } from "../src/visual/WallGlow.js";

const store = (v: string | null) => ({ getItem: (k: string) => (k === GLOW_STORAGE_KEY ? v : null) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetGlowProbeForTests();
});

describe("V1 Glow — interrupteur unique", () => {
  it("allumé par défaut, éteint par \"0\" à la build ou sur l'appareil", () => {
    expect(glowFlag(undefined, null)).toBe(true);
    expect(glowFlag("1", "1")).toBe(true);
    expect(glowFlag("0", null)).toBe(false);
    expect(glowFlag(undefined, "0")).toBe(false);
    expect(glowFlag(" 0 ", null)).toBe(false);
  });
  it("glowEnabled lit VITE_NOKKER_GLOW et localStorage nokker.web.glow", () => {
    expect(glowEnabled()).toBe(true);
    vi.stubEnv("VITE_NOKKER_GLOW", "0");
    expect(glowEnabled()).toBe(false);
    vi.unstubAllEnvs();
    vi.stubGlobal("localStorage", store("0"));
    expect(glowEnabled()).toBe(false);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(glowEnabled()).toBe(true);
  });
  it("éteint : aucune classe sur <html>, pas de fond sur le mur", () => {
    const classes = new Set<string>();
    const root = { classList: { add: (c: string) => classes.add(c) } } as unknown as HTMLElement;
    vi.stubGlobal("localStorage", store("0"));
    expect(installGlow(root)).toBe(false);
    expect(classes.size).toBe(0);
    expect(currentGlowMode()).toBe("off");
    expect(renderToStaticMarkup(React.createElement(WallGlow, { night: false }))).toBe("");
    vi.stubGlobal("localStorage", store(null));
    expect(installGlow(root)).toBe(true);
    expect([...classes]).toEqual([GLOW_CLASS]);
  });
});

describe("V1 Glow — choix du rendu", () => {
  const env = { enabled: true, reducedMotion: false, webgl: true, appleWebKit: false };
  it("WebGL seulement s'il est là, hors WebKit d'Apple et hors mouvement réduit", () => {
    expect(glowMode(env)).toBe("webgl");
    expect(glowMode({ ...env, webgl: false })).toBe("css");
    expect(glowMode({ ...env, appleWebKit: true })).toBe("css");
    expect(glowMode({ ...env, reducedMotion: true })).toBe("static");
    expect(glowMode({ ...env, enabled: false, reducedMotion: true })).toBe("off");
  });
  it("mouvement réduit : rendu fixe, sans animation", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    expect(currentGlowMode()).toBe("static");
    expect(renderToStaticMarkup(React.createElement(WallGlow, { night: true }))).toContain("nk-wall-glow night still");
  });
  it("sans WebGL : fond CSS seul, jamais d'élément vide", () => {
    const html = renderToStaticMarkup(React.createElement(WallGlow, { night: false }));
    expect(html).toContain('data-wall-glow="css"');
    expect(html).toContain("nk-wall-glow-css");
    expect(html).not.toContain("nk-wall-gl ");
  });
  it("WebKit d'Apple reconnu (iPhone, iPad en mode bureau, Safari), pas Chrome ni Android", () => {
    expect(isAppleWebKit("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148")).toBe(true);
    expect(isAppleWebKit("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe(true);
    expect(isAppleWebKit("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", 5)).toBe(true);
    expect(isAppleWebKit("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36")).toBe(false);
    expect(isAppleWebKit("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36")).toBe(false);
  });
  it("sonde WebGL : contexte absent ou exception → false, sans lever", () => {
    expect(hasWebGL({ createElement: () => ({ getContext: () => null }) } as never)).toBe(false);
    resetGlowProbeForTests();
    expect(
      hasWebGL({
        createElement: () => {
          throw new Error("no canvas");
        },
      } as never),
    ).toBe(false);
    resetGlowProbeForTests();
    let lost = false;
    let attrs: unknown = null;
    const gl = { getExtension: () => ({ loseContext: () => (lost = true) }) };
    expect(hasWebGL({ createElement: () => ({ getContext: (_: string, a: unknown) => ((attrs = a), gl) }) } as never)).toBe(true);
    expect(lost).toBe(true);
    // Rendu logiciel refusé par défaut (écran allumé jour et nuit).
    expect(attrs).toEqual({ failIfMajorPerformanceCaveat: true });
  });
});

describe("V1 Glow — couleurs du mur", () => {
  it("mélanges lisibles et bornés", () => {
    expect(parseHex("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parseHex("rgb(1,2,3)")).toBeNull();
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#102030", "#ffffff", 2)).toBe("#ffffff");
  });
  it("nuit plus sombre que le jour, faible contraste", () => {
    const lum = (h: string) => parseHex(h)!.reduce((a, b) => a + b, 0) / 3;
    const day = wallGlowColors(false, "#e2474f", "#a85400");
    const night = wallGlowColors(true, "#ff6f61", "#f2a34a");
    expect(Math.max(...night.map(lum))).toBeLessThan(20);
    expect(Math.min(...day.map(lum))).toBeGreaterThan(200);
  });
});
