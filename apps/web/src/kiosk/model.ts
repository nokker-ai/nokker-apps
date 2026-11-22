import type { GlanceHousehold, KioskView } from "@nokker-apps/sdk";

export interface KioskTile {
  key: string;
  title: string;
  url: string;
}

export const TILE_REFRESH_MS = 60_000;

/** Échelle qui fait tenir un écran de 1920×1080 en entier dans une cellule (jamais agrandi au-delà de 1) ; 0 si la cellule est vide. */
export function fitScale(w: number, h: number, sw = 1920, sh = 1080): number {
  if (!(w > 0) || !(h > 0)) return 0;
  return Math.min(1, w / sw, h / sh);
}

/** Tuile à AFFICHER : l'écran change (id ou version) → tout de suite ; même écran → l'adresse la plus récente au plus une
 * fois par minute (chaque lecture refait le rendu de l'heure et donne une nouvelle adresse : recharger à chaque tick clignote). */
export function nextTile(shown: (KioskTile & { at: number }) | null, tile: KioskTile | null, nowMs: number): (KioskTile & { at: number }) | null {
  if (!tile) return null;
  if (!shown || shown.key !== tile.key || nowMs - shown.at >= TILE_REFRESH_MS) return { ...tile, at: nowMs };
  return shown;
}

/** La tuile « écran publié » : absente (null) sans écran ou sans adresse de page lisible ; jamais une erreur. */
export function kioskScreen(v: Pick<KioskView, "screen"> | null, resolve: (u: string) => string | null): KioskTile | null {
  const s = v?.screen;
  if (!s || typeof s.frame_url !== "string" || !s.frame_url) return null;
  const url = resolve(s.frame_url);
  if (!url) return null;
  return { key: `${String(s.id)}@${String(s.version)}`, title: String(s.title ?? s.titre ?? ""), url };
}

/** La vue du kiosque dans la forme de la vue Foyer du mur : météo, départs et domotique sont ceux du kiosque ; membres,
 * agenda, tâches, menus, courses et projets viennent du foyer DÉMO quand le noyau en annonce un (sinon listes vides). */
export function asHousehold(v: KioskView): GlanceHousehold {
  const h = v.household;
  const list = <T,>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);
  return { members: list(h?.members), guest: h?.guest === true, agenda: list(h?.agenda), tasks: list(h?.tasks), meals: list(h?.meals),
    shopping: list(h?.shopping), projects: list(h?.projects), weather: v.weather, departures: v.departures, ha: v.ha, at: v.now };
}

/** Le foyer affiché est une démo (valeurs fictives) : à marquer, jamais présenté comme le vrai foyer. */
export function isDemoHousehold(v: Pick<KioskView, "household"> | null): boolean {
  return v?.household?.demo === true;
}

/** Mode nuit de l'écran : seulement si le noyau ne l'a pas coupé (`night: false`) ET qu'on est entre 22:00 et 07:00. */
export function kioskNight(v: Pick<KioskView, "night"> | null, nightNow: boolean): boolean {
  return nightNow && v?.night !== false;
}
