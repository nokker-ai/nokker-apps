import { afterEach, describe, expect, it } from "vitest";
import { availableViews, avatarUrlOf, morning, pickView, readWallView, saveWallView, stepView } from "../src/glance/views.js";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), clear: () => mem.clear() };
afterEach(() => mem.clear());

describe("wall views (Foyer / Screen / classic)", () => {
  it("Foyer by default, Screen when published, the old content only as a fallback", () => {
    expect(availableViews({ foyer: true, screen: false })).toEqual(["foyer"]);
    expect(availableViews({ foyer: true, screen: true })).toEqual(["foyer", "screen"]);
    expect(availableViews({ foyer: false, screen: false })).toEqual(["classic"]);
  });
  it("the remembered choice wins while it exists; night is always the old screen", () => {
    const a = availableViews({ foyer: true, screen: true });
    expect(pickView(a, null, false)).toBe("foyer");
    expect(pickView(a, "screen", false)).toBe("screen");
    expect(pickView(["foyer"], "screen", false)).toBe("foyer");
    expect(pickView(a, "screen", true)).toBe("classic");
    saveWallView("screen");
    expect(readWallView()).toBe("screen");
  });
  it("swipe goes to the neighbour, without wrapping", () => {
    const a = availableViews({ foyer: true, screen: true });
    expect(stepView(a, "foyer", 1)).toBe("screen");
    expect(stepView(a, "screen", 1)).toBe("screen");
    expect(stepView(a, "screen", -1)).toBe("foyer");
  });
  it("avatar file and morning window", () => {
    expect(avatarUrlOf({ id: "nina", version: 1 })).toBe("/avatars/nina-v1/");
    expect(morning(new Date(2026, 10, 9, 7, 30))).toBe(true);
    expect(morning(new Date(2026, 10, 9, 14, 0))).toBe(false);
  });
});
