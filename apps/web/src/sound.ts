/**
 * Signature « toc toc toc » (packages/brand/src/signature.ts) jouée à chaque `bubble.created` visible.
 * Son COUPÉ par défaut sur desktop (DEFAULT_PREFS), interrupteur visible dans l'en-tête ; vibration au même
 * rythme sur mobile (navigator.vibrate, absent d'iOS Safari). Une rafale de bulles = un seul toc (coalesceMs).
 */
import { DEFAULT_PREFS, KNOCKS, androidWaveform, type KnockKind, type SignaturePrefs } from "@nokker-apps/brand";
import { readJson, writeJson } from "./viewState.js";

const coarse = (): boolean => {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
};

export function loadSignaturePrefs(): SignaturePrefs {
  const base = coarse() ? DEFAULT_PREFS.mobile : DEFAULT_PREFS.desktop;
  return { ...base, ...readJson<Partial<SignaturePrefs>>("signature", {}) };
}

export function saveSignaturePrefs(p: SignaturePrefs): void {
  writeJson("signature", p);
}

let lastKnock = 0;
const cache = new Map<string, HTMLAudioElement>();

export function knock(kind: KnockKind, prefs: SignaturePrefs): void {
  const now = Date.now();
  if (now - lastKnock < prefs.coalesceMs) return;
  lastKnock = now;
  if (prefs.sound) {
    try {
      const file = KNOCKS[kind].sound;
      let a = cache.get(file);
      if (!a) {
        a = new Audio(`/sounds/${file}`);
        a.volume = 0.6;
        cache.set(file, a);
      }
      a.currentTime = 0;
      void a.play().catch(() => undefined); // lecture refusée (pas encore d'interaction) : silence
    } catch {
      /* audio indisponible */
    }
  }
  if (prefs.haptics && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(androidWaveform(kind));
    } catch {
      /* vibration refusée */
    }
  }
}
