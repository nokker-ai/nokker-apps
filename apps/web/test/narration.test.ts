import { describe, expect, it } from "vitest";
import { MAX_QUEUE, b64ToBlob, narrationText, pendingPoints } from "../src/browser/narration.js";

const P = (seq: number, why = "", label = "") => ({ seq, why, label });

describe("narration vocale de /present", () => {
  it("le texte dit est celui du noyau : le why, sinon le libellé", () => {
    expect(narrationText(P(1, "4 voyageurs, balcon", "Appartement Lac"))).toBe("4 voyageurs, balcon");
    expect(narrationText(P(2, "", "Appartement Lac"))).toBe("Appartement Lac");
    expect(narrationText(P(3, "  ", ""))).toBe("");
  });

  it("les points à dire : jamais deux fois, jamais sans texte, du plus ancien au plus récent", () => {
    const pts = [P(1, "a"), P(2, "", ""), P(3, "c")];
    expect(pendingPoints(pts, new Set()).map((p) => p.seq)).toEqual([1, 3]);
    expect(pendingPoints(pts, new Set([1])).map((p) => p.seq)).toEqual([3]);
    expect(pendingPoints(pts, new Set([1, 3]))).toEqual([]);
  });

  it("si Nina désigne plus vite qu'elle ne parle, on saute les plus anciens (file bornée)", () => {
    const pts = [P(1, "a"), P(2, "b"), P(3, "c"), P(4, "d")];
    expect(MAX_QUEUE).toBe(2);
    expect(pendingPoints(pts, new Set()).map((p) => p.seq)).toEqual([3, 4]);
  });

  it("MP3 base64 → Blob du bon type et de la bonne taille", async () => {
    const b = b64ToBlob(btoa("ID3-test"), "audio/mpeg");
    expect(b.type).toBe("audio/mpeg");
    expect(b.size).toBe(8);
  });
});
