/**
 * Fond du mur en WebGL (lot V1), chargé à la demande : le paquet de shaders n'entre jamais dans le bundle principal.
 * Un seul contexte WebGL. Le dégradé avance par petites touches (~8 images/s, à peine perceptibles vu la lenteur) au
 * lieu de 60 : l'écran reste allumé jour et nuit. Pause quand l'onglet est masqué. Paper Shaders, Apache-2.0
 * (https://shaders.paper.design).
 */
import { ShaderFitOptions, ShaderMount, getShaderColorFromString, meshGradientFragmentShader } from "@paper-design/shaders";

export interface WallShader {
  setColors(colors: string[]): void;
  dispose(): void;
}

const STEP_MS = 125;
/** Avance du temps du shader par seconde réelle : une dérive très lente. */
const DRIFT = 0.06;

function uniformsFor(colors: string[]): Record<string, number | number[] | number[][]> {
  return {
    u_colors: colors.map((c) => getShaderColorFromString(c)),
    u_colorsCount: colors.length,
    u_distortion: 0.7,
    u_swirl: 0.15,
    u_grainMixer: 0,
    u_grainOverlay: 0,
    u_fit: ShaderFitOptions.cover,
    u_scale: 1,
    u_rotation: 0,
    u_offsetX: 0,
    u_offsetY: 0,
    u_originX: 0.5,
    u_originY: 0.5,
    u_worldWidth: 0,
    u_worldHeight: 0,
  };
}

/**
 * La bibliothèque injecte une balise <style> à son premier montage, ce que la CSP du web (style-src 'self') refuse avec
 * une erreur en console. On lui fait croire que la balise existe déjà (le document qu'elle voit répond à cette seule
 * requête) ; les règles équivalentes sont dans theme.css (`.nk-wall-gl`).
 */
function withoutInjectedStyle<T>(host: HTMLElement, make: () => T): T {
  const real = host.ownerDocument;
  const doc = new Proxy(real, {
    get(target, key) {
      if (key === "querySelector") return (sel: string) => (sel === "style[data-paper-shader]" ? host : target.querySelector(sel));
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  Object.defineProperty(host, "ownerDocument", { value: doc, configurable: true });
  try {
    return make();
  } finally {
    delete (host as { ownerDocument?: Document }).ownerDocument;
  }
}

/** Monte le shader dans `host` ; lève une erreur si WebGL manque (l'appelant garde le fond CSS). */
export function mountWallShader(host: HTMLElement, colors: string[], onLost: () => void): WallShader {
  // Vitesse 0 : pas de boucle à 60 images/s ; on fixe nous-mêmes l'instant à rendre.
  const mount = withoutInjectedStyle(host, () => new ShaderMount(host, meshGradientFragmentShader, uniformsFor(colors), { alpha: false, antialias: false, powerPreference: "low-power" }, 0, 0, 1, 1280 * 720));
  const canvas = mount.canvasElement;
  const lost = (e: Event): void => {
    e.preventDefault();
    stop();
    onLost();
  };
  canvas.addEventListener("webglcontextlost", lost);
  // Départ à un instant différent à chaque montage : jamais deux fois la même image au même endroit.
  let t = (Date.now() % 600_000) * DRIFT;
  let timer: number | null = null;
  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    t += (now - last) * DRIFT;
    last = now;
    mount.setFrame(t);
  };
  const start = (): void => {
    if (timer !== null || document.hidden) return;
    last = performance.now();
    timer = window.setInterval(tick, STEP_MS);
  };
  const stop = (): void => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const vis = (): void => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", vis);
  mount.setFrame(t);
  start();
  return {
    setColors: (c) => mount.setUniforms({ u_colors: c.map((x) => getShaderColorFromString(x)), u_colorsCount: c.length }),
    dispose: () => {
      stop();
      document.removeEventListener("visibilitychange", vis);
      canvas.removeEventListener("webglcontextlost", lost);
      mount.dispose();
      canvas.remove();
    },
  };
}
