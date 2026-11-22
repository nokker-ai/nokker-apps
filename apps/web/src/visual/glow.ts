/**
 * Lot V1 « Glow » : la lueur vivante de l'identité (corail → braise). UN seul interrupteur pour tout le lot :
 * `glowEnabled()`, allumé par défaut, éteint par `VITE_NOKKER_GLOW=0` à la build ou `localStorage["nokker.web.glow"] = "0"`
 * sur l'appareil. Éteint, rien ne change : pas de classe sur <html>, pas de fond animé sur le mur, aucun module chargé.
 *
 * Trois rendus, choisis à l'exécution (`glowMode`) :
 * - "static" : `prefers-reduced-motion: reduce` → lueur fixe et discrète, aucune animation ;
 * - "css"    : sans WebGL, ou WebKit d'Apple (Safari, iOS, coque native iOS) → version CSS seule ;
 * - "webgl"  : le fond du mur passe par un shader (module chargé à la demande, un seul contexte WebGL).
 * Le bord des bulles et le faisceau du prompt restent en CSS partout : aucun contexte WebGL par bulle.
 */

export const GLOW_STORAGE_KEY = "nokker.web.glow";
export const GLOW_CLASS = "nk-glow";

export type GlowMode = "off" | "static" | "css" | "webgl";

/** Règle du drapeau, en fonction pure : "0" à la build OU sur l'appareil éteint tout ; le reste allume. */
export function glowFlag(buildValue: string | undefined, storedValue: string | null | undefined): boolean {
  if ((buildValue ?? "").trim() === "0") return false;
  if ((storedValue ?? "").trim() === "0") return false;
  return true;
}

function readStored(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(GLOW_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readBuild(): string | undefined {
  try {
    return import.meta.env?.VITE_NOKKER_GLOW as string | undefined;
  } catch {
    return undefined;
  }
}

/** L'interrupteur unique du lot V1. */
export function glowEnabled(): boolean {
  return glowFlag(readBuild(), readStored());
}

/** WebKit d'Apple (Safari macOS, tout navigateur iOS/iPadOS, coque native iOS) : on reste en CSS. */
export function isAppleWebKit(ua: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS se présente comme un Mac ; un Mac n'a pas d'écran tactile.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return true;
  return /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua);
}

export interface GlowEnv {
  enabled: boolean;
  reducedMotion: boolean;
  webgl: boolean;
  appleWebKit: boolean;
}

/** Choix du rendu, en fonction pure. */
export function glowMode(env: GlowEnv): GlowMode {
  if (!env.enabled) return "off";
  if (env.reducedMotion) return "static";
  if (!env.webgl || env.appleWebKit) return "css";
  return "webgl";
}

let webglCache: boolean | null = null;

/** Sonde WebGL2 une seule fois (contexte rendu aussitôt) ; jamais d'exception. */
export function hasWebGL(doc: Pick<Document, "createElement"> | undefined = typeof document === "undefined" ? undefined : document, allowSoftware = false): boolean {
  if (webglCache !== null) return webglCache;
  let ok = false;
  try {
    const c = doc?.createElement("canvas") as HTMLCanvasElement | undefined;
    // Un rendu logiciel (pas de GPU) ferait chauffer un écran allumé jour et nuit : CSS à la place.
    const gl = (c?.getContext("webgl2", { failIfMajorPerformanceCaveat: !allowSoftware }) ?? null) as WebGL2RenderingContext | null;
    ok = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    ok = false;
  }
  webglCache = ok;
  return ok;
}

/** Tests seulement. */
export function resetGlowProbeForTests(): void {
  webglCache = null;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Rendu courant de l'appareil. La sonde WebGL n'est faite que si elle peut servir. */
export function currentGlowMode(): GlowMode {
  const enabled = glowEnabled();
  if (!enabled) return "off";
  const reducedMotion = prefersReducedMotion();
  const appleWebKit = typeof navigator === "undefined" ? false : isAppleWebKit(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  // Recette : "gl" sur l'appareil accepte un WebGL logiciel (navigateur sans GPU) ; sinon on le refuse.
  const webgl = reducedMotion || appleWebKit ? false : hasWebGL(undefined, readStored() === "gl");
  return glowMode({ enabled, reducedMotion, webgl, appleWebKit });
}

/** Pose la classe qui allume les styles du lot sur <html> ; drapeau éteint → rien. */
export function installGlow(root: HTMLElement | undefined = typeof document === "undefined" ? undefined : document.documentElement): boolean {
  if (!root || !glowEnabled()) return false;
  root.classList.add(GLOW_CLASS);
  return true;
}

/** "#rrggbb" / "#rgb" → [r, g, b] ; null si illisible. */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Mélange `amount` (0–1) de `tint` dans `base`, en RGB ; rend "#rrggbb". */
export function mixHex(base: string, tint: string, amount: number): string {
  const a = parseHex(base) ?? [0, 0, 0];
  const b = parseHex(tint) ?? a;
  const t = Math.min(1, Math.max(0, amount));
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
