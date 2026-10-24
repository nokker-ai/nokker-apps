import { describe, expect, it } from "vitest";
import { arrange, overlap, placeNew } from "../src/placement.js";

const bounds = { x: 290, y: 80, w: 1130, h: 720 };

describe("placeNew — bulles flottantes", () => {
  it("pose la première bulle en haut à droite, hors de la dernière réponse et de la saisie", () => {
    const forbidden = [
      { x: 300, y: 650, w: 650, h: 60 },
      { x: 300, y: 730, w: 650, h: 60 },
    ];
    const p = placeNew({ area: { w: 1440, h: 900 }, bounds, size: { w: 420, h: 300 }, forbidden, others: [], index: 0 });
    expect(p).toEqual({ x: 1000, y: 80 });
    for (const f of forbidden) expect(overlap({ ...p, w: 420, h: 300 }, f)).toBe(0);
  });

  it("cascade : la suivante se décale et chevauche au plus partiellement, sans couvrir le chat si possible", () => {
    const first = { x: 1000, y: 80, w: 420, h: 300 };
    const chat = { x: 300, y: 80, w: 650, h: 640 };
    const p = placeNew({ area: { w: 1440, h: 900 }, bounds, size: { w: 420, h: 300 }, forbidden: [], others: [first], soft: [chat], index: 1 });
    expect(overlap({ ...p, w: 420, h: 300 }, first)).toBeLessThan(420 * 300);
    expect(overlap({ ...p, w: 420, h: 300 }, chat)).toBe(0);
  });
});

describe("arrange — Ranger", () => {
  it("empile depuis la droite et ouvre une colonne quand la hauteur manque", () => {
    const out = arrange(
      [
        { id: "a", w: 420, h: 300 },
        { id: "b", w: 420, h: 300 },
        { id: "c", w: 420, h: 300 },
      ],
      bounds,
    );
    expect(out.a).toEqual({ x: 1000, y: 80 });
    expect(out.b).toEqual({ x: 1000, y: 394 });
    expect(out.c!.x).toBe(1000 - 420 - 14);
    expect(out.c!.y).toBe(80);
  });
});
