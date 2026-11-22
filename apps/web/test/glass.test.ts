import { describe, expect, it } from "vitest";
import { FPS_FLOOR, FPS_OFF, downgrade, fpsOf, glassMode, svgBackdropSupported } from "../src/glass/glass.js";

const base = { reducedMotion: false, reducedTransparency: false, svgBackdrop: true };

describe("V4 verre liquide : choix du rendu", () => {
  it("éteint par défaut ; allumé par le drapeau de build ou de recette", () => {
    expect(glassMode({ ...base })).toBe("off");
    expect(glassMode({ ...base, build: "1" })).toBe("refract");
    expect(glassMode({ ...base, stored: "1" })).toBe("refract");
    expect(glassMode({ ...base, stored: "0", build: "" })).toBe("off");
    expect(glassMode({ ...base, stored: "n'importe quoi" })).toBe("off");
  });

  it("sans filtre SVG de fond (WebKit/iOS), le départ est « blur » ; la recette peut forcer « blur »", () => {
    expect(glassMode({ ...base, build: "1", svgBackdrop: false })).toBe("blur");
    expect(glassMode({ ...base, stored: "blur" })).toBe("blur");
    expect(glassMode({ ...base, stored: "refract", svgBackdrop: false })).toBe("blur");
  });

  it("transparence réduite côté système : jamais de verre", () => {
    expect(glassMode({ ...base, build: "1", reducedTransparency: true })).toBe("off");
  });

  it("repli automatique d'un cran sous les planchers mesurés", () => {
    expect(downgrade("refract", FPS_FLOOR)).toBe("refract");
    expect(downgrade("refract", FPS_FLOOR - 1)).toBe("blur");
    expect(downgrade("blur", FPS_FLOOR - 1)).toBe("blur"); // « blur » ne s'éteint que bien plus bas
    expect(downgrade("blur", FPS_OFF - 1)).toBe("off");
    expect(downgrade("off", 5)).toBe("off");
  });

  it("cadence médiane d'une série d'intervalles", () => {
    expect(fpsOf([])).toBe(0);
    expect(fpsOf([16.7, 16.7, 16.7, 40, 16.7])).toBeCloseTo(59.9, 0);
    expect(fpsOf([100, 100, 100])).toBe(10);
  });

  it("filtre SVG de fond : Chromium hors iOS seulement", () => {
    expect(svgBackdropSupported("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", undefined)).toBe(true);
    expect(svgBackdropSupported("x", [{ brand: "Chromium" }, { brand: "Not A Brand" }])).toBe(true);
    expect(svgBackdropSupported("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/141 Mobile Safari", [{ brand: "Chromium" }])).toBe(false);
    expect(svgBackdropSupported("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", undefined, 5)).toBe(false);
    expect(svgBackdropSupported("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", undefined)).toBe(false);
    expect(svgBackdropSupported("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", undefined)).toBe(false);
  });
});

describe("interrupteur d'adresse (sans rebuild)", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  it("?glass=off mémorise « off » et le verre s'éteint même si le build l'allume ; reset rend la main", async () => {
    const { applyGlassUrlSwitch, glassMode, GLASS_STORAGE_KEY } = await import("../src/glass/glass.js");
    const s = mem();
    applyGlassUrlSwitch("?glass=off", s);
    expect(s.getItem(GLASS_STORAGE_KEY)).toBe("off");
    const env = { build: "1", stored: s.getItem(GLASS_STORAGE_KEY), reducedMotion: false, reducedTransparency: false, svgBackdrop: true };
    expect(glassMode(env)).toBe("off");
    applyGlassUrlSwitch("?glass=reset", s);
    expect(s.getItem(GLASS_STORAGE_KEY)).toBeNull();
    expect(glassMode({ ...env, stored: null })).toBe("refract");
    applyGlassUrlSwitch("?autre=1", s);
    expect(s.getItem(GLASS_STORAGE_KEY)).toBeNull();
  });
});
