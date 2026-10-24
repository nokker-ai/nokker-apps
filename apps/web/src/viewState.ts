/**
 * État de VUE du client (BUBBLES.md §2 : position et réduit ne sont pas dans l'API) : localStorage,
 * chaque accès protégé (navigation privée, stockage bloqué, aperçu) — l'interface marche sans.
 */
const PREFIX = "nokker.web.";

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : on garde l'état en mémoire seulement */
  }
}

export interface BubbleView {
  collapsed?: boolean;
  /** Bulle partagée masquée localement (lecture seule : on ne la ferme pas pour les autres). */
  hidden?: boolean;
}

export type BubbleViews = Record<string, BubbleView>;

export function loadViews(): BubbleViews {
  return readJson<BubbleViews>("bubbleViews", {});
}

export function saveViews(v: BubbleViews): void {
  // On borne la taille : les bulles fermées depuis longtemps n'ont plus besoin de leur position.
  const entries = Object.entries(v).slice(-200);
  writeJson("bubbleViews", Object.fromEntries(entries));
}

/** Positions libres des bulles, PAR FIL (une bulle copiée ailleurs y trouve sa propre place) :
 * `positions[threadId][bubbleId] = {x, y}` en px relatifs au calque des bulles. */
export type BubblePositions = Record<string, Record<string, { x: number; y: number }>>;

export function loadPositions(): BubblePositions {
  return readJson<BubblePositions>("bubblePositions", {});
}

export function savePositions(p: BubblePositions): void {
  const threads = Object.entries(p).slice(-30).map(([t, m]) => [t, Object.fromEntries(Object.entries(m).slice(-60))] as const);
  writeJson("bubblePositions", Object.fromEntries(threads));
}
