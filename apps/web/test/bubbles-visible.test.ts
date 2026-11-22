import { describe, expect, it } from "vitest";
import { visibleBubbles } from "../src/bubbles/visible.js";

describe("bulles masquées (maison connectée)", () => {
  it("écarte home et home_watch, garde le reste dans le même ordre", () => {
    const list = [{ id: "a", kind: "notify" }, { id: "b", kind: "home" }, { id: "c", kind: "timer" }, { id: "d", kind: "home_watch" }, { id: "e", kind: "browser" }];
    expect(visibleBubbles(list).map((b) => b.id)).toEqual(["a", "c", "e"]);
  });
  it("une liste sans bulle de maison est rendue à l'identique, une liste vide reste vide", () => {
    const list = [{ kind: "monitor" }, { kind: "search" }];
    expect(visibleBubbles(list)).toEqual(list);
    expect(visibleBubbles([])).toEqual([]);
  });
});
