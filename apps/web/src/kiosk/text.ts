/** Textes de l'écran `/kiosk` (dictionnaire FR/EN propre à l'écran, comme `onboarding/i18n.ts`). */
export const KIOSK_TEXT = {
  fr: {
    personal: "Mode perso",
    demo: "Démo",
    demoHint: "Foyer fictif de démonstration",
    home: "Maison",
    nina: "Nina",
    offline: "Hors ligne : dernière lecture à {0}",
    needKey: "Clé locale du kiosque absente ou refusée : relance le kiosque depuis la machine.",
    off: "Le mode kiosque est éteint sur ce Nokker.",
    onMachine: "Le kiosque ne s'ouvre que sur la machine elle-même.",
    on: "allumé",
    offState: "éteint",
  },
  en: {
    personal: "Personal mode",
    demo: "Demo",
    demoHint: "Fictional demo household",
    home: "Home",
    nina: "Nina",
    offline: "Offline: last read at {0}",
    needKey: "Kiosk local key missing or refused: restart the kiosk from the machine.",
    off: "Kiosk mode is off on this Nokker.",
    onMachine: "The kiosk only opens on the machine itself.",
    on: "on",
    offState: "off",
  },
} as const;
