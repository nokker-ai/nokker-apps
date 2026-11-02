/**
 * « Knock to call »: knock three times on the table and Nokker answers. Browser module of the core (web/knock/,
 * served as-is from /knock/: knock.js, knock-worklet.js and the weights cnn.json, triple.json).
 *
 * Product rules (core docs KNOCK.md §3 and §7):
 * - OFF by default; once switched on, the microphone is asked on a gesture of the person (a click), never on load;
 * - while the listener is not `off`, the interface shows it (indicator in the top bar) and offers « Mute »;
 * - the sound never leaves the AudioWorklet: nothing is sent, nothing is stored but the calibrated SETTINGS
 *   (measurements, `nokker.web.knock.settings`);
 * - on the web, a knock only CALLS (focus on the composer): it never approves a card.
 *
 * One listener for the whole app: the setting card (My account) and the indicator (top bar) read the same snapshot.
 */
import { readJson, writeJson } from "../viewState.js";

export type KnockState = "off" | "starting" | "listening" | "muted" | "calibrating" | "error";

export interface KnockSnapshot {
  /** The person switched « Knock to call » on (kept across reloads). */
  enabled: boolean;
  state: KnockState;
  /** Last start error, in plain words (permission refused, no microphone…). */
  error: "denied" | "nomic" | "failed" | null;
  /** Calibrated settings are kept (measurements only). */
  calibrated: boolean;
  /** Outcome of the last calibration. */
  lastCalibration: "ok" | "none" | null;
}

/** Why the browser cannot listen; null when it can. */
export type KnockUnsupported = "insecure" | "nomedia" | "noworklet";

/** Subset of the module's `KnockListener` used here. */
interface Listener {
  state: string;
  start(): Promise<void>;
  stop(): void;
  mute(muted: boolean): void;
  calibrate(seconds?: number): Promise<Record<string, unknown> | null>;
  finishCalibration(): void;
  setSettings(settings: Record<string, unknown> | null): void;
}
type ListenerCtor = new (opts: {
  workletUrl: string;
  settingsKey: string;
  onKnock: (ev: { t: number; confidence?: number }) => void;
  onState: (s: string) => void;
}) => Listener;

const PREF = "knock";
/** localStorage key of the calibrated settings (viewState prefix + `knock.settings`). */
export const SETTINGS_KEY = "nokker.web.knock.settings";
const base = (): string => (import.meta.env?.BASE_URL ?? "/").replace(/\/?$/, "/");

export function knockUnsupported(w: Window & typeof globalThis = window): KnockUnsupported | null {
  if (w.isSecureContext === false) return "insecure";
  if (!w.navigator?.mediaDevices?.getUserMedia) return "nomedia";
  if (typeof w.AudioContext !== "function" || typeof w.AudioWorkletNode !== "function") return "noworklet";
  return null;
}

function hasSettings(): boolean {
  try {
    return !!localStorage.getItem(SETTINGS_KEY);
  } catch {
    return false;
  }
}

let snap: KnockSnapshot = { enabled: !!readJson<{ enabled?: boolean }>(PREF, {}).enabled, state: "off", error: null, calibrated: hasSettings(), lastCalibration: null };
const subs = new Set<() => void>();
const knockSubs = new Set<() => void>();
let listener: Listener | null = null;

function set(patch: Partial<KnockSnapshot>): void {
  snap = { ...snap, ...patch };
  subs.forEach((f) => f());
}

export const knockStore = {
  subscribe(f: () => void): () => void {
    subs.add(f);
    return () => subs.delete(f);
  },
  get: (): KnockSnapshot => snap,
};

/** Called on each recognised « knock knock knock ». */
export function onKnock(f: () => void): () => void {
  knockSubs.add(f);
  return () => knockSubs.delete(f);
}

let ctor: Promise<ListenerCtor> | null = null;
function loadModule(): Promise<ListenerCtor> {
  // Served as a static file (public/knock/), not bundled: same files as the core's, weights fetched by the module.
  ctor ??= import(/* @vite-ignore */ `${base()}knock/knock.js`).then((m: { KnockListener: ListenerCtor }) => m.KnockListener);
  return ctor;
}

function errorOf(e: unknown): KnockSnapshot["error"] {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "nomic";
  return "failed";
}

/** Start listening. MUST run inside a click handler (the browser asks for the microphone on a gesture). */
export async function startKnock(): Promise<void> {
  if (knockUnsupported()) return;
  if (listener && listener.state !== "off" && listener.state !== "error") return;
  set({ error: null, state: "starting" });
  try {
    const Ctor = await loadModule();
    listener ??= new Ctor({
      workletUrl: `${base()}knock/knock-worklet.js`,
      settingsKey: SETTINGS_KEY,
      onState: (s) => set({ state: s as KnockState }),
      onKnock: () => knockSubs.forEach((f) => f()),
    });
    await listener.start();
  } catch (e) {
    listener?.stop();
    set({ state: "off", error: errorOf(e) });
  }
}

export function stopKnock(): void {
  listener?.stop();
  set({ state: "off" });
}

/** Switch « Knock to call » on (starts listening: call from a click) or off (frees the microphone). */
export async function setKnockEnabled(on: boolean): Promise<void> {
  writeJson(PREF, { enabled: on });
  set({ enabled: on, lastCalibration: null });
  if (on) await startKnock();
  else stopKnock();
}

export function muteKnock(muted: boolean): void {
  if (!listener) return;
  listener.mute(muted);
  // The module reports `muted` / `listening` through onState; say it at once in case the worklet is slow.
  set({ state: muted ? "muted" : "listening" });
}

/** « Knock three times » within `seconds`; keeps the measured settings (never the sound). */
export async function calibrateKnock(seconds = 30): Promise<void> {
  if (!listener || snap.state === "off") return;
  set({ lastCalibration: null });
  const r = await listener.calibrate(seconds);
  set({ calibrated: hasSettings(), lastCalibration: r ? "ok" : "none" });
}

export function finishKnockCalibration(): void {
  listener?.finishCalibration();
}

/** Forget the calibrated settings (the next start uses the defaults). */
export function forgetKnockCalibration(): void {
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* storage unavailable */
  }
  listener?.setSettings(null); // back to the defaults at once
  set({ calibrated: false, lastCalibration: null });
}

/** The « yes? » answer: a short static chime (no speech synthesis). */
let yes: HTMLAudioElement | null = null;
export function playYes(): void {
  try {
    yes ??= new Audio(`${base()}sounds/nokker-yes.wav`);
    yes.volume = 0.7;
    yes.currentTime = 0;
    void yes.play().catch(() => undefined);
  } catch {
    /* audio unavailable */
  }
}

/** Test hook: reset the module state. */
export function __resetKnock(): void {
  listener = null;
  ctor = null;
  snap = { enabled: !!readJson<{ enabled?: boolean }>(PREF, {}).enabled, state: "off", error: null, calibrated: hasSettings(), lastCalibration: null };
}
