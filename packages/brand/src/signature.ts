// Signature Nokker : « toc toc toc » du heurtoir (« Knocks for you »). UNE définition, déclinée en son et en vibration
// sur chaque plateforme. Décision le 18.10.2026 : son DÉSACTIVABLE (coupé par défaut sur desktop, au travail),
// vibration sur smartphone, très identifiable, au même rythme que le son.

export type KnockKind = "bubble" | "notification" | "discreet";

/** Coups : instant (ms depuis le début) et intensité 0..1. */
export interface KnockPattern {
  hits: { at: number; intensity: number; sharpness: number }[];
  sound: string; // fichier de son (assets), joué seulement si le son est activé
}

export const KNOCKS: Record<KnockKind, KnockPattern> = {
  bubble: {
    // le 18.10 : trois coups ÉGAUX et FORTS au rythme exact du son (130 ms), jamais dégressifs.
    hits: [{ at: 0, intensity: 1.0, sharpness: 0.8 }, { at: 130, intensity: 1.0, sharpness: 0.8 },
           { at: 260, intensity: 1.0, sharpness: 0.8 }],
    sound: "nokker-toc-A-bulle.wav",
  },
  notification: {
    hits: [{ at: 0, intensity: 1.0, sharpness: 0.9 }, { at: 160, intensity: 0.9, sharpness: 0.85 },
           { at: 320, intensity: 0.8, sharpness: 0.8 }],
    sound: "nokker-toc-B-notification.wav",
  },
  discreet: {
    hits: [{ at: 0, intensity: 0.8, sharpness: 0.5 }, { at: 110, intensity: 0.6, sharpness: 0.4 }],
    sound: "nokker-toc-C-discret.wav",
  },
};

export interface SignaturePrefs {
  sound: boolean;   // défaut : false sur desktop, true sur mobile (et toujours soumis au mode silencieux)
  haptics: boolean; // défaut : true sur mobile
  /** Plusieurs bulles en rafale : un seul toc par fenêtre. */
  coalesceMs: number;
}

export const DEFAULT_PREFS: Record<"desktop" | "mobile", SignaturePrefs> = {
  desktop: { sound: false, haptics: false, coalesceMs: 1500 },
  mobile: { sound: false, haptics: true, coalesceMs: 1500 },
};

/** Motif Android (VibrationEffect.createWaveform / navigator.vibrate) : alternance pause/vibration en ms. */
export function androidWaveform(kind: KnockKind): number[] {
  const out: number[] = [];
  let t = 0;
  for (const h of KNOCKS[kind].hits) {
    const dur = Math.round(18 + 22 * h.intensity);
    out.push(h.at - t, dur);
    t = h.at + dur;
  }
  return out;
}

/** Fichier Core Haptics (AHAP) pour l'app iOS native : un événement HapticTransient par coup. */
export function ahap(kind: KnockKind): object {
  return {
    Version: 1.0,
    Pattern: KNOCKS[kind].hits.map((h) => ({
      Event: {
        Time: h.at / 1000,
        EventType: "HapticTransient",
        EventParameters: [
          { ParameterID: "HapticIntensity", ParameterValue: h.intensity },
          { ParameterID: "HapticSharpness", ParameterValue: h.sharpness },
        ],
      },
    })),
  };
}
