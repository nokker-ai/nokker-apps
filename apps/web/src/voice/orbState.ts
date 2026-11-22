/**
 * Voice orb: states, the single flag, and the tiny state APIs.
 *  - `orbEnabled()`: ON by default; OFF with the build flag `VITE_NOKKER_ORB=0` or `localStorage["nokker.web.orb"] = "0"`.
 *    OFF: nothing is rendered, the UI is exactly what it was without the orb.
 *  - Wall: the wall voice (three knocks, household voice) is not built yet. The later code only has to call
 *    `setWallVoiceState("listening" | "thinking" | "speaking" | "idle" | "muted")`; `"off"` (default) hides the slot.
 *    Test/dev hook: `window.__nokkerWallOrb(state)` and the page query `?orb=<state>` force a state.
 *  - Knock: `flashKnockOrb()` shows the orb briefly (listening, then idle) when three knocks were heard.
 * Visual only: no audio, no network, no microphone here.
 */
import { useSyncExternalStore } from "react";

export type OrbState = "off" | "idle" | "listening" | "thinking" | "speaking" | "muted";
export const ORB_STATES: readonly OrbState[] = ["off", "idle", "listening", "thinking", "speaking", "muted"];
export const isOrbState = (s: unknown): s is OrbState => typeof s === "string" && (ORB_STATES as readonly string[]).includes(s);

export const ORB_KEY = "nokker.web.orb";

export function orbEnabled(): boolean {
  try {
    if (import.meta.env.VITE_NOKKER_ORB === "0") return false;
  } catch {
    /* no build env */
  }
  try {
    const v = localStorage.getItem(ORB_KEY);
    if (v === "0" || v === '"0"') return false;
  } catch {
    /* storage unavailable */
  }
  return true;
}

/** Tiny external store (one value, subscribers). */
function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: T): void {
      if (Object.is(next, value)) return;
      value = next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void): () => void {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

// --- Wall slot ---------------------------------------------------------------------------------------------------
const wall = store<OrbState>("off");
/** The wall voice code calls this; `"off"` hides the slot. Ignored when the orb flag is off. */
export function setWallVoiceState(s: OrbState): void {
  wall.set(isOrbState(s) ? s : "off");
}
export function getWallVoiceState(): OrbState {
  return orbEnabled() ? wall.get() : "off";
}
export function useWallVoiceState(): OrbState {
  const s = useSyncExternalStore(wall.subscribe, wall.get, () => "off" as OrbState);
  return orbEnabled() ? s : "off";
}
/** Dev/test hook: `window.__nokkerWallOrb("speaking")`, and `?orb=speaking` in the page address. */
export function installWallOrbHook(w: Window = window): () => void {
  (w as unknown as { __nokkerWallOrb?: (s: string) => void }).__nokkerWallOrb = (s) => setWallVoiceState(isOrbState(s) ? s : "off");
  try {
    const q = new URLSearchParams(w.location.search).get("orb");
    if (isOrbState(q)) setWallVoiceState(q);
  } catch {
    /* no location */
  }
  return () => {
    delete (w as unknown as { __nokkerWallOrb?: unknown }).__nokkerWallOrb;
  };
}

// --- Knock flash ---------------------------------------------------------------------------------------------------
const flash = store<OrbState>("off");
let timers: ReturnType<typeof setTimeout>[] = [];
export const KNOCK_FLASH_MS = { listening: 2200, idle: 700 } as const;
/** Three knocks heard: the orb shows « listening » briefly, then « idle », then goes away. */
export function flashKnockOrb(): void {
  if (!orbEnabled()) return;
  timers.forEach((t) => clearTimeout(t));
  flash.set("listening");
  timers = [
    setTimeout(() => flash.set("idle"), KNOCK_FLASH_MS.listening),
    setTimeout(() => flash.set("off"), KNOCK_FLASH_MS.listening + KNOCK_FLASH_MS.idle),
  ];
}
export const getKnockFlash = (): OrbState => flash.get();
export function useKnockFlash(): OrbState {
  return useSyncExternalStore(flash.subscribe, flash.get, () => "off" as OrbState);
}

/** Tests: back to the initial state. */
export function __resetOrb(): void {
  timers.forEach((t) => clearTimeout(t));
  timers = [];
  wall.set("off");
  flash.set("off");
}
