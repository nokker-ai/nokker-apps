import { describe, expect, it } from "vitest";
import { ageMinutes, bumpRecent, isNetworkError, trimView } from "../src/offline/cache.js";

describe("cache hors ligne (W6)", () => {
  it("garde les 5 fils les plus récemment ouverts ; le dernier ouvert en tête ; rend ceux qui sortent", () => {
    let o: string[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) o = bumpRecent(o, id).order;
    expect(o).toEqual(["e", "d", "c", "b", "a"]);
    const r = bumpRecent(o, "f");
    expect(r).toEqual({ order: ["f", "e", "d", "c", "b"], dropped: ["a"] });
    expect(bumpRecent(r.order, "c").order).toEqual(["c", "f", "e", "d", "b"]);
  });
  it("200 messages au plus par fil ; la vue reste entière sinon", () => {
    const v = { thread: { id: "t" }, messages: Array.from({ length: 250 }, (_, i) => i) };
    expect(trimView(v).messages).toHaveLength(200);
    expect(trimView(v).messages[0]).toBe(50);
    const small = { messages: [1, 2] };
    expect(trimView(small)).toBe(small);
  });
  it("copie montrée seulement sur une panne de réseau, jamais sur une réponse du serveur", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError({ status: 503 })).toBe(true);
    expect(isNetworkError({ status: 401 })).toBe(false);
    expect(isNetworkError({ status: 404 })).toBe(false);
    expect(ageMinutes(Date.now() - 12 * 60_000)).toBe(12);
  });
});
