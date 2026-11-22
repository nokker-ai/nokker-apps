import { describe, expect, it } from "vitest";
import { isRigUrl, mouthAt, rms, wordAt } from "../src/avatar/rigMouth.js";

const S = { words: ["Bonjour,", "je", "suis"], wtimes: [0, 600, 900], wdurations: [500, 200, 300] };

describe("bouche du rig 2D", () => {
  it("trouve le mot prononcé, et rien entre les mots", () => {
    expect(wordAt(S, 10)).toBe(0);
    expect(wordAt(S, 550)).toBe(-1);
    expect(wordAt(S, 650)).toBe(1);
    expect(wordAt(S, 1300)).toBe(-1);
  });
  it("fermée hors d'un mot, ouverte ou mi-ouverte selon l'amplitude dans un mot", () => {
    expect(mouthAt(S, 550, 0.5)).toBe("closed");
    expect(mouthAt(S, 100, 0.2)).toBe("open");
    expect(mouthAt(S, 100, 0.05)).toBe("half");
  });
  it("sans amplitude utile, la bouche reste vivante dans un mot (alternance)", () => {
    const seen = new Set([0, 100, 300, 450, 650, 750].map((t) => mouthAt(S, t, 0)));
    expect(seen).toEqual(new Set(["open", "half"]));
    expect(mouthAt(S, 100, null)).not.toBe("closed");
  });
  it("RMS d'un tampon temporel", () => {
    expect(rms(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(rms(new Uint8Array([255, 1, 255, 1]))).toBeGreaterThan(0.9);
    expect(rms([])).toBe(0);
  });
  it("une URL qui finit par / désigne un rig 2D", () => {
    expect(isRigUrl("/avatars/nina-v1/")).toBe(true);
    expect(isRigUrl("/avatars/x-v1.gltf")).toBe(false);
  });
});
