/**
 * Local pointing: an arrow placed on an interface element WITHOUT a `pointer` bubble (the core is not involved) — used
 * by the Guide's « Show me » button. The overlay draws it like a bubble's pointer; it fades after a while.
 */
export interface LocalPoint {
  ui: string;
  n: number;
}

const SHOWN_MS = 15000;
let current: LocalPoint | null = null;
let counter = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/** Points at the element marked `data-show-me="<ui>"`. */
export function pointLocally(ui: string): void {
  counter += 1;
  current = { ui, n: counter };
  if (timer) clearTimeout(timer);
  timer = setTimeout(clearLocalPoint, SHOWN_MS);
  emit();
}

export function clearLocalPoint(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (current) {
    current = null;
    emit();
  }
}

export function getLocalPoint(): LocalPoint | null {
  return current;
}

export function subscribeLocalPoint(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
