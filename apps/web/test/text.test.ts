import { describe, expect, it } from "vitest";
import { canAddText, clock, textAttachment, textPlugin, textRefusal } from "../src/platform/text.js";

describe("texte reconnu sur l'appareil (P9)", () => {
  it("pièce du contrat : nom propre et coupé à 80, texte à 20 000, source selon le geste", () => {
    const a = textAttachment("device_ocr", `Texte lu sur ${"é".repeat(100)}\n.png`, "x".repeat(25_000));
    expect([...a.name]).toHaveLength(80);
    expect(a.name).not.toMatch(/\n/);
    expect(a.text).toHaveLength(20_000);
    expect(textAttachment("device_dictation", "Dictée (0:42)", "pain", { duration_s: 42 })).toEqual({ kind: "text", source: "device_dictation", name: "Dictée (0:42)", text: "pain", duration_s: 42 });
    expect(textAttachment("device_stt", "   ", "t").name).toBe("texte");
  });
  it("4 pièces au plus ; durée lisible ; refus lisibles ; plugin seulement dans la coque", () => {
    expect(canAddText(new Array(3).fill(textAttachment("device_ocr", "a", "b")))).toBe(true);
    expect(canAddText(new Array(4).fill(textAttachment("device_ocr", "a", "b")))).toBe(false);
    expect(clock(72)).toBe("1:12");
    expect(textRefusal({ message: "unavailable_on_device" })).toBe("unavailable_on_device");
    expect(textRefusal(new Error("denied"))).toBe("denied");
    expect(textRefusal("boom")).toBe("failed");
    expect(textPlugin({})).toBeUndefined();
  });
});
