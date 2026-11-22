/**
 * V5 — typographie mesurée sans DOM (@chenglou/pretext 1.0.0, MIT) : `prepare()` mesure le texte une fois (canvas), `layout()`
 * rend nombre de lignes et hauteur par de l'arithmétique, sans `getBoundingClientRect` ni reflux. Sert à faire GLISSER la
 * hauteur d'un bloc de texte vers celle qu'il aura (réponse de Nokker qui se compose en flux, titres du mur qui changent)
 * au lieu de la faire sauter. Drapeau éteint dans le code (le Dockerfile web l'allume) : `VITE_NOKKER_PRETEXT=1` ou localStorage `nokker.web.pretext` = "1" ;
 * éteint, rien n'est chargé (import à la demande) ni rendu. Une prédiction fausse (police pas encore chargée, texte riche)
 * est détectée par le composant, qui rend la main au navigateur.
 */
export const PRETEXT_STORAGE_KEY = "nokker.web.pretext";

/** Valeur mémorisée d'abord (« 0 » éteint même si le build l'allume), puis le build. Interrupteur sans rebuild : `?pretext=0` ou
 * `?pretext=1` dans l'adresse, mémorisé dans ce navigateur ; `?pretext=reset` l'efface. */
export function pretextEnabled(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("pretext");
    if (q === "0" || q === "1") localStorage.setItem(PRETEXT_STORAGE_KEY, q);
    else if (q === "reset") localStorage.removeItem(PRETEXT_STORAGE_KEY);
  } catch {
    /* pas d'adresse ou de stockage (recette hors navigateur) */
  }
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PRETEXT_STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (stored === "0") return false;
  if (stored === "1") return true;
  return import.meta.env?.VITE_NOKKER_PRETEXT === "1";
}

/** Texte brut d'un seul paragraphe : pas de saut de ligne, pas de syntaxe Markdown (gras, code, liste, tableau, lien…),
 * seul cas où la mesure du texte brut est la hauteur rendue. */
export function flowEligible(text: string): boolean {
  if (!text.trim() || text.includes("\n")) return false;
  return !/[`*_#>|\[\]]|^\s*[-+]\s|^\s*\d+[.)]\s/.test(text);
}

type Mod = typeof import("@chenglou/pretext");
let mod: Promise<Mod | null> | null = null;

let loaded: Mod | null = null;

/** Charge Pretext à la demande ; null si indisponible (pas de canvas, import refusé). */
export function loadPretext(): Promise<Mod | null> {
  if (!mod) mod = import("@chenglou/pretext").then((m) => (loaded = m), () => null);
  return mod;
}

/** Pretext déjà chargé (sinon null et le chargement est lancé) : permet de mesurer SANS attendre, avant la peinture. */
export function pretextNow(): Mod | null {
  if (!loaded) void loadPretext();
  return loaded;
}

/** Police CSS d'un élément, en notation canvas (sans interligne) : « italic 600 16px Inter, sans-serif ». */
export function canvasFont(cs: Pick<CSSStyleDeclaration, "fontStyle" | "fontWeight" | "fontSize" | "fontFamily">): string {
  return [cs.fontStyle && cs.fontStyle !== "normal" ? cs.fontStyle : "", cs.fontWeight, cs.fontSize, cs.fontFamily].filter(Boolean).join(" ");
}

/** Interligne en px (une valeur « normal » vaut ≈ 1,4 × la taille). */
export function lineHeightPx(cs: Pick<CSSStyleDeclaration, "lineHeight" | "fontSize">): number {
  const lh = parseFloat(cs.lineHeight);
  return Number.isFinite(lh) && lh > 0 ? lh : (parseFloat(cs.fontSize) || 16) * 1.4;
}

const cache = new Map<string, unknown>();

/** Hauteur (px) de `text` rendu sur `width` px dans `font`, interligne `lineHeight` ; null si Pretext n'est pas chargé. */
export function measureHeightNow(text: string, font: string, width: number, lineHeight: number): number | null {
  const m = pretextNow();
  if (!m || !(width > 0)) return null;
  try {
    const key = `${font}|${text}`;
    let p = cache.get(key) as ReturnType<Mod["prepare"]> | undefined;
    if (!p) {
      if (cache.size > 300) cache.clear();
      p = m.prepare(text, font);
      cache.set(key, p);
    }
    return m.layout(p, width, lineHeight).height;
  } catch {
    return null;
  }
}

// Drapeau allumé : on charge la bibliothèque tout de suite (le premier flux de texte ne doit pas l'attendre).
if (typeof window !== "undefined" && pretextEnabled()) void loadPretext();
