/** Textes de la page `/nina-live` (dictionnaire FR/EN propre à l'écran, comme `onboarding/i18n.ts`). */
export const NINA_LIVE_TEXT = {
  fr: { talk: "Parler à Nina", stop: "Couper le micro", sound: "Activer le son", fallback: "Nina en direct indisponible : version légère.",
    ninaSpeaks: "Nina parle…", yourTurn: "À toi", listening: "Nina t'écoute", holdHint: "À toi : maintiens le bouton (ou Espace) pour parler", hold: "Maintenir pour parler" },
  en: { talk: "Talk to Nina", stop: "Mute the mic", sound: "Turn sound on", fallback: "Live Nina unavailable: light version.",
    ninaSpeaks: "Nina is speaking…", yourTurn: "Your turn", listening: "Nina is listening", holdHint: "Your turn: hold the button (or Space) to talk", hold: "Hold to talk" },
} as const;
