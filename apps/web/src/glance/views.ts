/**
 * Vues de l'écran mural (dev 07.11) : « Foyer » (F1) par défaut, « Écran » quand un écran est publié (V7), l'ancien
 * contenu fixe en repli quand aucune des deux n'existe. On passe de l'une à l'autre par glissement (ou par les points,
 * au clavier et pour l'accessibilité) ; le choix est mémorisé sur CET appareil (le mur). La nuit : toujours l'ancien
 * écran, sombre et minimal.
 */
export type WallViewId = "foyer" | "screen" | "classic";

const KEY = "nokker.web.wall.view";

export function availableViews(o: { foyer: boolean; screen: boolean }): WallViewId[] {
  const v: WallViewId[] = [];
  if (o.foyer) v.push("foyer");
  if (o.screen) v.push("screen");
  if (!v.length) v.push("classic");
  return v;
}

export function readWallView(): WallViewId | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "foyer" || v === "screen" || v === "classic" ? v : null;
  } catch {
    return null;
  }
}

export function saveWallView(v: WallViewId): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* stockage indisponible : le choix vaut pour la session */
  }
}

/** La vue montrée : le choix mémorisé s'il est encore disponible, sinon la première (Foyer d'abord). */
export function pickView(avail: WallViewId[], wanted: WallViewId | null, night: boolean): WallViewId {
  if (night) return "classic";
  return wanted && avail.includes(wanted) ? wanted : avail[0]!;
}

/** Glissement horizontal : la vue voisine (bornée, sans boucle). */
export function stepView(avail: WallViewId[], cur: WallViewId, dir: 1 | -1): WallViewId {
  const i = avail.indexOf(cur);
  if (i < 0) return avail[0]!;
  return avail[Math.max(0, Math.min(avail.length - 1, i + dir))]!;
}

/** Heure du matin où l'annonce peut se jouer d'elle-même (une fois par brief). */
export const morning = (d: Date): boolean => d.getHours() >= 6 && d.getHours() < 11;

/** Rig 2D de Nina (calques WebP, sans WebGL) : le dossier versionné, l'URL finit par « / ». */
export const avatarUrlOf = (a: { id: string; version: number }): string => `/avatars/${a.id}-v${a.version}/`;
