/**
 * V4 « Verre liquide » : surfaces en verre (bulles, cartes, barre de saisie, vignette de Nina) — flou, saturation, bord
 * spéculaire dont la lumière tourne comme la flamme du glow V1, et, dans Chromium, une légère réfraction (filtre SVG sur
 * le fond). CSS/SVG natif, AUCUNE dépendance : les bibliothèques « HTML-in-canvas » (liquid-dom, Canvas UI) exigent l'API
 * expérimentale `drawElementImage` (drapeau Chrome 140+, essai d'origine 148-150) et ne sont pas utilisables en production.
 *
 * Opt-in dans le code (le Dockerfile web l'allume, VITE_NOKKER_GLASS=0 l'éteint) : `VITE_NOKKER_GLASS=1` ou localStorage `nokker.web.glass` = "1" (la recette peut forcer un
 * rendu avec "refract" ou "blur"). Trois rendus, du plus riche au plus sobre, avec REPLI AUTOMATIQUE mesuré :
 *  - "refract" : flou + réfraction SVG (Chromium seulement) ;
 *  - "blur"    : flou + saturation + bord spéculaire (`backdrop-filter` partout, iOS Safari compris) ;
 *  - "off"     : rien (mouvement ou transparence réduits côté système, ou appareil trop lent).
 * Garde de performance : `measureFps` relève la cadence réelle sur ~1,5 s ; sous `FPS_FLOOR` (50 i/s) le rendu descend d'un cran.
 */
export type GlassMode = "off" | "blur" | "refract";

export const GLASS_STORAGE_KEY = "nokker.web.glass";
export const GLASS_CLASS = "nk-glass";
/** Cadence minimale pour garder un rendu ; au-dessous, on descend d'un cran. */
export const FPS_FLOOR = 50;
/** Dernier cran : si même « blur » est sous ce plancher, le verre s'éteint. */
export const FPS_OFF = 30;

export interface GlassEnv {
  /** Drapeau de build ("1") et valeur du stockage local ("1" | "refract" | "blur" | null). */
  build?: string;
  stored?: string | null;
  reducedMotion: boolean;
  reducedTransparency: boolean;
  /** Chromium (Chrome, Edge, Android WebView…), hors iOS : le filtre SVG de fond y fonctionne. */
  svgBackdrop: boolean;
}

/** Rendu de DÉPART d'après le drapeau et le système (avant toute mesure). */
export function glassMode(e: GlassEnv): GlassMode {
  const asked = (e.stored ?? "").trim() || (e.build ?? "").trim();
  if (asked !== "1" && asked !== "refract" && asked !== "blur") return "off";
  if (e.reducedTransparency) return "off";
  if (asked === "blur") return "blur";
  return e.svgBackdrop ? "refract" : "blur";
}

/** Un cran plus sobre selon la cadence mesurée (i/s) ; la même valeur si elle tient. */
export function downgrade(mode: GlassMode, fps: number): GlassMode {
  if (mode === "off") return "off";
  if (mode === "refract") return fps < FPS_FLOOR ? "blur" : "refract";
  return fps < FPS_OFF ? "off" : "blur";
}

/** Chromium hors iOS (là où `backdrop-filter: url(#filtre)` s'applique). */
export function svgBackdropSupported(ua: string, brands: readonly { brand: string }[] | undefined, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return false; // tout navigateur iOS = WebKit
  if (brands?.some((b) => /Chromium/.test(b.brand))) return true;
  return /\bChrome\/\d+/.test(ua) && !/\bEdgA?\/|OPR\//.test(ua) ? true : /\bEdg\/\d+/.test(ua);
}

/** Cadence médiane (i/s) d'une série d'intervalles entre images (ms). */
export function fpsOf(intervalsMs: readonly number[]): number {
  if (!intervalsMs.length) return 0;
  const s = [...intervalsMs].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)]!;
  return med > 0 ? 1000 / med : 0;
}

/** Interrupteur sans rebuild : `?glass=off` (ou 0) éteint le verre, `?glass=on` (ou `blur`, `refract`) l'allume ; la valeur est
 * mémorisée dans ce navigateur (localStorage), `?glass=reset` l'efface et rend la main au build. */
export function applyGlassUrlSwitch(search: string, store: Pick<Storage, "getItem" | "setItem" | "removeItem">): void {
  const v = new URLSearchParams(search).get("glass");
  if (!v) return;
  if (v === "off" || v === "0") store.setItem(GLASS_STORAGE_KEY, "off");
  else if (v === "on" || v === "1") store.setItem(GLASS_STORAGE_KEY, "1");
  else if (v === "blur" || v === "refract") store.setItem(GLASS_STORAGE_KEY, v);
  else if (v === "reset") store.removeItem(GLASS_STORAGE_KEY);
}

function readStored(): string | null {
  try {
    applyGlassUrlSwitch(location.search, localStorage);
    return localStorage.getItem(GLASS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function media(q: string): boolean {
  try {
    return window.matchMedia(q).matches;
  } catch {
    return false;
  }
}

export function currentGlassMode(): GlassMode {
  let build: string | undefined;
  try {
    build = import.meta.env?.VITE_NOKKER_GLASS as string | undefined;
  } catch {
    build = undefined;
  }
  const brands = (navigator as unknown as { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  return glassMode({
    build,
    stored: readStored(),
    reducedMotion: media("(prefers-reduced-motion: reduce)"),
    reducedTransparency: media("(prefers-reduced-transparency: reduce)"),
    svgBackdrop: svgBackdropSupported(navigator.userAgent, brands, navigator.maxTouchPoints ?? 0),
  });
}

/** Relève ~`frames` intervalles entre images (après un court temps de chauffe), en i/s ; `override` (recette) court-circuite. */
export function measureFps(frames = 90, warmupMs = 500, override?: number): Promise<number> {
  if (override !== undefined && Number.isFinite(override)) return Promise.resolve(override);
  return new Promise((resolve) => {
    const iv: number[] = [];
    let last = 0;
    const t0 = performance.now();
    const tick = (now: number): void => {
      if (now - t0 > warmupMs && last) iv.push(now - last);
      last = now;
      if (iv.length >= frames || now - t0 > 6000) return resolve(fpsOf(iv));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Le filtre SVG de réfraction (un seul, caché) : un bruit fractal qui déplace très légèrement le fond sous le verre. */
function ensureRefractFilter(): void {
  if (document.getElementById("nk-glass-defs")) return;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("id", "nk-glass-defs");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  svg.innerHTML =
    '<filter id="nk-glass-refract" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.008 0.013" numOctaves="2" seed="3" result="noise"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="noise" scale="26" xChannelSelector="R" yChannelSelector="G"/></filter>';
  document.body.appendChild(svg);
}

/** Badge d'essai (`?glassdebug=1`) : le rendu choisi et la cadence (texte technique, en anglais), lisibles sans outils (iPhone). Rien sans ce paramètre. */
function debugBadge(): { set(text: string): void } | null {
  if (new URLSearchParams(location.search).get("glassdebug") !== "1") return null;
  const el = document.createElement("div");
  el.setAttribute("data-glass-debug", "");
  el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:4px 8px;border-radius:8px;background:rgba(0,0,0,.72);color:#fff;font:600 12px/1.3 ui-monospace,monospace;pointer-events:none";
  document.body.appendChild(el);
  return { set: (t) => (el.textContent = t) };
}

/** Pose le rendu sur <html> (`nk-glass` + `data-glass`), puis le mesure et le descend d'un cran si besoin. */
export async function installGlass(root: HTMLElement = document.documentElement): Promise<GlassMode> {
  let mode = currentGlassMode();
  const start = mode;
  const apply = (m: GlassMode): void => {
    if (m === "refract") ensureRefractFilter();
    root.classList.toggle(GLASS_CLASS, m !== "off");
    if (m === "off") root.removeAttribute("data-glass");
    else root.setAttribute("data-glass", m);
  };
  const badge = debugBadge();
  badge?.set(`glass: ${mode} · measuring…`);
  apply(mode);
  if (mode === "off") {
    badge?.set("glass: off");
    return mode;
  }
  const q = new URLSearchParams(location.search).get("glassfps");
  const override = q === null ? undefined : Number(q);
  for (let step = 0; step < 2 && mode !== "off"; step++) {
    const fps = await measureFps(90, 500, override);
    const next = downgrade(mode, fps);
    root.setAttribute("data-glass-fps", String(Math.round(fps)));
    badge?.set(`glass: ${next} · ${Math.round(fps)} fps${next === start ? "" : ` (started as ${start})`}`);
    if (next === mode) break;
    mode = next;
    apply(mode);
  }
  return mode;
}
