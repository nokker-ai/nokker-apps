/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NOKKER_SERVER_URL?: string;
  readonly VITE_NOKKER_AUTH?: string;
  /** Le Guide (core docs/GUIDE.md): "1" turns on « Discover », the Guide panel and `/guide`. Off by default. */
  readonly VITE_NOKKER_GUIDE?: string;
  /** Kiosque HDMI d'un Lokkal (`/kiosk`), éteint par défaut. */
  readonly VITE_NOKKER_KIOSK?: string;
  /** "0" : no voice orb (the UI is as without it). On by default. */
  readonly VITE_NOKKER_ORB?: string;
  /** Drapeau `onboarding_avatar` : "1" ajoute l'étape « Ton Nokker » (nom, voix, avatar 3D) au parcours d'invitation. Éteint par défaut. */
  readonly VITE_NOKKER_ONBOARDING_AVATAR?: string;
  readonly VITE_NOKKER_NINA_LIVE?: string;
  readonly VITE_NOKKER_PRETEXT?: string;
  readonly VITE_NOKKER_GLASS?: string;
  readonly VITE_NOKKER_PRESENT_LIVE?: string;
  /** "1" : se comporter comme servi par la passerelle (recette contre le mock). */
  readonly VITE_NOKKER_GATEWAY?: string;
  /** Page d'autorisation de nokker.ai (défaut https://app.nokker.ai/gateway/authorize). */
  readonly VITE_NOKKER_AUTHORIZE_URL?: string;
  /** Build pour un magasin (LOKKAL-PHONE §6.3) : "ios" | "android" → aucun achat ni lien d'achat dans l'app. */
  readonly VITE_NOKKER_STORE_BUILD?: string;
  /** Lot V1 « Glow » : "0" éteint toute la lueur animée (bord des bulles, faisceau du prompt, fond du mur). Allumé par défaut. */
  readonly VITE_NOKKER_GLOW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
