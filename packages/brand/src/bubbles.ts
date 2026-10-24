// Couleurs, icônes et libellés des bulles — côté client UNIQUEMENT (BUBBLES.md §2 : « couleurs côté client
// (packages/brand), jamais dans l'API »). Couleur + icône + libellé ensemble : la couleur n'est jamais le seul signal.

export type BubbleKindName = "monitor" | "search" | "notify" | "timer" | "script" | "media" | "agent_draft" | "approval";

export interface BubbleKindTheme {
  label: string;
  /** Couleur vive, pour fond SOMBRE (thème sombre du web, terminal de la CLI). */
  color: string;
  /** Même couleur en « r,g,b » pour composer des rgba() */
  rgb: string;
  /** Couleur profonde pour fond CLAIR (thème par défaut du web, le 18.10.2026 : « gris clair, ça fera ressortir
   * les couleurs ») — contraste AA (≥ 4,5:1) sur blanc et sur le gris des panneaux. */
  light: string;
  lightRgb: string;
  /** Nom d'icône (le client fournit le dessin) */
  icon: "disk" | "search" | "bell" | "timer" | "terminal" | "play" | "bot" | "shield";
}

export const BUBBLE_THEME: Record<BubbleKindName, BubbleKindTheme> = {
  monitor: { label: "Monitoring", color: "#5FD4C8", rgb: "95,212,200", light: "#0B6E67", lightRgb: "11,110,103", icon: "disk" },
  search: { label: "Recherche web", color: "#B49CFF", rgb: "180,156,255", light: "#6B4FD8", lightRgb: "107,79,216", icon: "search" },
  notify: { label: "Notification", color: "#F2A35E", rgb: "242,163,94", light: "#965200", lightRgb: "150,82,0", icon: "bell" },
  timer: { label: "Timer", color: "#5BD39A", rgb: "91,211,154", light: "#0F7340", lightRgb: "15,115,64", icon: "timer" },
  script: { label: "Script", color: "#6FA8FF", rgb: "111,168,255", light: "#1F5FD1", lightRgb: "31,95,209", icon: "terminal" },
  media: { label: "Aperçu", color: "#FF8BB5", rgb: "255,139,181", light: "#B02A6F", lightRgb: "176,42,111", icon: "play" },
  agent_draft: { label: "Nouvel agent", color: "#5FD4C8", rgb: "95,212,200", light: "#0B6E67", lightRgb: "11,110,103", icon: "bot" },
  approval: { label: "Approbation", color: "#FF6F61", rgb: "255,111,97", light: "#C8313A", lightRgb: "200,49,58", icon: "shield" },
};

/** Deck Crew (SOKKAN) : bleu = au repos, vert = armé, orange = en marche, rouge = en erreur. `light*` : sur fond clair. */
export const AGENT_STATUS_THEME = {
  idle: { label: "Au repos", color: "#6FA8FF", rgb: "111,168,255", light: "#1F5FD1", lightRgb: "31,95,209" },
  armed: { label: "Armé", color: "#5BD39A", rgb: "91,211,154", light: "#0F7340", lightRgb: "15,115,64" },
  running: { label: "En marche", color: "#F2A34A", rgb: "242,163,74", light: "#A85400", lightRgb: "168,84,0" },
  error: { label: "En erreur", color: "#FF6B6B", rgb: "255,107,107", light: "#C62828", lightRgb: "198,40,40" },
} as const;

/**
 * Thème de l'interface (tokens), clair par défaut — fond gris clair qui fait ressortir les bulles. Le sombre reste
 * disponible sur réglage. Couleurs de la marque (kit v1, docs/nokker/kit) : corail #E2474F / #FF6F61, encre #0b0b0c,
 * papier #f4f2ee. L'accent des actions est un corail approfondi (#C8313A) pour tenir l'AA avec un texte blanc.
 */
export const NOKKER_TOKENS = {
  light: {
    bg: "#E9EBEF",
    panel: "#F4F5F7",
    drawer: "#DFE2E7",
    surface: "#FFFFFF",
    text: "#1C1F24",
    strong: "#0B0B0C",
    soft: "#3D4450",
    muted: "#5B6472",
    accent: "#C8313A",
    accentHover: "#B02A33",
    brandCoral: "#E2474F",
  },
  dark: {
    bg: "#0A0D14",
    panel: "#0D111A",
    drawer: "#0D111A",
    surface: "#10141D",
    text: "#E7EBF3",
    strong: "#F3F5F9",
    soft: "#C9D1E0",
    muted: "#9AA5B8",
    accent: "#FF6F61",
    accentHover: "#FF8A7E",
    brandCoral: "#FF6F61",
  },
  fontBrand: "'Cinzel', 'Times New Roman', serif",
  fontBody: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/** Fichiers du kit de marque copiés dans `packages/brand/assets/` (source unique pour tous les clients). */
export const BRAND_ASSETS = {
  emblemLight: "assets/nokker-emblem-light.svg",
  emblemDark: "assets/nokker-emblem-dark.svg",
  emblemSmallLight: "assets/nokker-emblem-small-light.svg",
  emblemSmallDark: "assets/nokker-emblem-small-dark.svg",
  lockupLight: "assets/lockup/nokker-horizontal-light-transparent.svg",
  lockupDark: "assets/lockup/nokker-horizontal-dark-transparent.svg",
  favicon: "assets/icon/favicon.svg",
  appIcon192: "assets/icon/nokker-app-192.png",
  appIcon512: "assets/icon/nokker-app-512.png",
  maskable192: "assets/icon/nokker-maskable-192.png",
  maskable512: "assets/icon/nokker-maskable-512.png",
  appleTouch: "assets/icon/apple-touch-icon.png",
} as const;

/** @deprecated palette sombre des premières maquettes — voir `NOKKER_TOKENS`. */
export const NOKKER_UI = {
  bg: "#0A0D14",
  panel: "#0D111A",
  surface: "#10141D",
  raised: "#141A25",
  popover: "#151B27",
  text: "#E7EBF3",
  textStrong: "#F3F5F9",
  textSoft: "#C9D1E0",
  muted: "#9AA5B8",
  brass: "#E3B06A",
  brassHover: "#F3C98A",
  cyan: "#5FD4C8",
  fontDisplay: "'Cinzel', serif",
  fontBody: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;
