/**
 * Placement des bulles flottantes (18.10.2026 : « flottantes, pas de colonne »). Fonctions pures, sans DOM :
 * le calque mesure les rectangles et appelle ces fonctions.
 *
 * - `placeNew` : une nouvelle bulle se pose en CASCADE (ancre qui descend et recule de 28×34 px à chaque bulle) dans
 *   une zone libre : on évite d'abord les zones interdites (dernière réponse de Nina, saisie, barre du haut, tiroir),
 *   puis on limite le recouvrement des autres bulles — le chevauchement reste permis (l'ordre z se règle au clic).
 * - `arrange` : « Ranger » — colonnes depuis le bord droit, hauteurs réelles, plus récentes en haut à droite.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export interface PlaceInput {
  /** Taille du calque. */
  area: { w: number; h: number };
  /** Zone utilisable (hors tiroir et barre du haut). */
  bounds: Rect;
  /** Taille de la bulle à poser. */
  size: { w: number; h: number };
  /** Rectangles à ne pas couvrir (dernière réponse, saisie). */
  forbidden: Rect[];
  /** Bulles déjà posées. */
  others: Rect[];
  /** À couvrir le moins possible, mais permis (colonne du chat : la bulle translucide le laisse lire). */
  soft?: Rect[];
  /** Rang de la bulle dans la cascade (nombre de bulles déjà posées dans ce fil). */
  index: number;
}

export function placeNew(p: PlaceInput): { x: number; y: number } {
  const { bounds, size } = p;
  const maxX = Math.max(bounds.x, bounds.x + bounds.w - size.w);
  const maxY = Math.max(bounds.y, bounds.y + bounds.h - Math.min(size.h, bounds.h));
  const step = p.index % 8;
  const anchor = { x: maxX - 28 * step, y: bounds.y + 34 * step };
  let best = { x: anchor.x, y: anchor.y, score: Number.POSITIVE_INFINITY };
  for (let y = bounds.y; y <= maxY; y += 24) {
    for (let x = maxX; x >= bounds.x; x -= 24) {
      const r = { x, y, w: size.w, h: size.h };
      let score = 0;
      for (const f of p.forbidden) score += overlap(r, f) * 12;
      for (const o of p.others) score += overlap(r, o) * 1;
      for (const o of p.soft ?? []) score += overlap(r, o) * 2.5;
      score += (Math.abs(x - anchor.x) + Math.abs(y - anchor.y)) * 40;
      if (score < best.score) best = { x, y, score };
    }
  }
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

/** Range en colonnes depuis la droite ; `items` déjà triés (le premier = le plus récent, en haut à droite). */
export function arrange(items: { id: string; w: number; h: number }[], bounds: Rect, gap = 14): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  let colRight = bounds.x + bounds.w;
  let y = bounds.y;
  let colW = 0;
  for (const it of items) {
    if (y > bounds.y && y + it.h > bounds.y + bounds.h) {
      colRight -= colW + gap;
      y = bounds.y;
      colW = 0;
    }
    const x = Math.max(bounds.x, colRight - it.w);
    out[it.id] = { x: Math.round(x), y: Math.round(y) };
    y += it.h + gap;
    colW = Math.max(colW, it.w);
  }
  return out;
}
