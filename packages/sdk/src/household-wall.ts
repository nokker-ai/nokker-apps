/**
 * F1 — vue « Foyer » de l'écran mural (noyau p2/f-projets fe06b7e, docs/FAMILY-PROJECTS.md §10 fait foi). Route À PART pour que `/v1/glance` reste
 * léger : `GET /v1/glance/household`, nkg_ d'un MUR seulement, ETag → 304 ; relue toutes les 60 s et juste après une
 * coche. Le noyau filtre (droits du foyer, mode invité) : le mur n'affiche que ce qu'il reçoit.
 *
 *   GET  /v1/glance/household               → 200 GlanceHousehold (ETag) | 304 ; 403 not_wall
 *   POST /v1/glance/tasks/{id}/done {done}  → {task}     nkg_ mur, sans effet externe, « depuis le mur », 30/h ;
 *   POST /v1/glance/shopping/{id}/done {done} → {item}   404 si non partagé avec le mur (ou projet « parents »)
 *   POST /v1/glance/guest {on}              → {guest}    on: true sans authentification (masquer) ; on: false
 *                                                        seulement après le code du propriétaire de l'appareil
 *                                                        (natif) ; expire seul au bout de 4 h.
 */

export interface WallMember {
  id: string;
  /** Prénom seulement. */
  name: string;
  /** Couleur de la personne (#rrggbb). */
  color: string;
  initials: string;
}

/** Créneau des 7 prochains jours ; `title` absent = privé, mode invité ou titres non permis : « occupé ». */
export interface HouseholdEvent {
  id: string;
  member_id: string | null;
  /** ISO 8601 avec décalage ; journée entière : une DATE `YYYY-MM-DD`. */
  start: string;
  end?: string;
  all_day: boolean;
  title?: string;
}

export interface HouseholdTask {
  id: string;
  member_id: string | null;
  title: string;
  done: boolean;
  due?: string;
}

export interface HouseholdMeal {
  /** `YYYY-MM-DD` */
  date: string;
  lunch?: string;
  dinner?: string;
}

export interface ShoppingItem {
  id: string;
  text: string;
  done: boolean;
}

export interface WallWeather {
  /** Toujours `null` aujourd'hui : la source (MétéoSuisse, jeu journalier) ne publie pas la température actuelle. */
  now_c: number | null;
  /** Pictogramme MétéoSuisse (chiffres) ou clear | partly | cloudy | rain | snow | storm | fog (mock). */
  code: string;
  hi_c: number;
  lo_c: number;
  summary: string;
}

export interface WallDeparture {
  stop: string;
  line: string;
  to: string;
  minutes: number;
}

export interface HouseholdProject {
  id: string;
  title: string;
  /** 0–1 */
  progress: number;
  next_due?: string;
  next_step?: string;
}

/** États Home Assistant choisis par le titulaire, lecture seule ; jamais serrure, alarme ni portail. */
export interface WallHaState {
  entity_id: string;
  name: string;
  state: string;
  unit?: string;
  domain: string;
}

export interface GlanceHousehold {
  members: WallMember[];
  /** Mode invité : le noyau a déjà retiré titres, tâches, menus, courses et projets. */
  guest: boolean;

  agenda: HouseholdEvent[];
  tasks: HouseholdTask[];
  meals: HouseholdMeal[];
  shopping: ShoppingItem[];
  /** `null` sans le pack Essentiels : la tuile est masquée. */
  weather: WallWeather | null;
  departures: WallDeparture[];
  projects: HouseholdProject[];
  ha: WallHaState[];
  at?: string;
}

export type GlanceHouseholdRead = { status: 200; household: GlanceHousehold | null; etag: string | null } | { status: 304 };

export const GUEST_MAX_S = 4 * 3600;
