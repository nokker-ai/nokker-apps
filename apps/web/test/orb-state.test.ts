import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOCK_FLASH_MS, ORB_KEY, __resetOrb, flashKnockOrb, getKnockFlash, getWallVoiceState, installWallOrbHook, isOrbState, orbEnabled, setWallVoiceState } from "../src/voice/orbState.js";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  clear: () => mem.clear(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
  __resetOrb();
});

describe("orbEnabled", () => {
  it("is on by default", () => {
    expect(orbEnabled()).toBe(true);
  });
  it("is off with localStorage nokker.web.orb = 0 (raw or JSON)", () => {
    localStorage.setItem(ORB_KEY, "0");
    expect(orbEnabled()).toBe(false);
    localStorage.setItem(ORB_KEY, '"0"');
    expect(orbEnabled()).toBe(false);
    localStorage.setItem(ORB_KEY, "1");
    expect(orbEnabled()).toBe(true);
  });
  it("is off with VITE_NOKKER_ORB=0", () => {
    vi.stubEnv("VITE_NOKKER_ORB", "0");
    expect(orbEnabled()).toBe(false);
  });
});

describe("wall voice state", () => {
  it("is hidden by default and follows setWallVoiceState", () => {
    expect(getWallVoiceState()).toBe("off");
    setWallVoiceState("speaking");
    expect(getWallVoiceState()).toBe("speaking");
    setWallVoiceState("bogus" as never);
    expect(getWallVoiceState()).toBe("off");
  });
  it("reads off when the flag is off", () => {
    setWallVoiceState("listening");
    localStorage.setItem(ORB_KEY, "0");
    expect(getWallVoiceState()).toBe("off");
  });
  it("test hook: window function and ?orb= query", () => {
    const w = { location: { search: "?orb=speaking" } } as unknown as Window;
    const undo = installWallOrbHook(w);
    expect(getWallVoiceState()).toBe("speaking");
    (w as unknown as { __nokkerWallOrb: (s: string) => void }).__nokkerWallOrb("thinking");
    expect(getWallVoiceState()).toBe("thinking");
    undo();
    expect((w as unknown as { __nokkerWallOrb?: unknown }).__nokkerWallOrb).toBeUndefined();
    expect(isOrbState("muted")).toBe(true);
    expect(isOrbState("loud")).toBe(false);
  });
});

describe("knock flash", () => {
  it("does nothing when the orb is off", () => {
    localStorage.setItem(ORB_KEY, "0");
    flashKnockOrb();
    // no timers armed, nothing to assert beyond not throwing
    expect(orbEnabled()).toBe(false);
  });
  it("goes listening, idle, off", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const probe = getKnockFlash;
    seen.push(probe());
    flashKnockOrb();
    seen.push(probe());
    vi.advanceTimersByTime(KNOCK_FLASH_MS.listening + 1);
    seen.push(probe());
    vi.advanceTimersByTime(KNOCK_FLASH_MS.idle + 1);
    seen.push(probe());
    expect(seen).toEqual(["off", "listening", "idle", "off"]);
  });
});
