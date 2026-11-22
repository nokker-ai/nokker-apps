/**
 * Kiosque HDMI d'un Lokkal (noyau `nokker/kiosk.py`, docs/KIOSK.md) : `GET /v1/local/kiosk`, jeton LOCAL du titulaire,
 * sur la machine seulement (passerelle : 403 `kiosk_on_machine` ; cloud ou drapeau éteint : 404), lecture seule,
 * 6 lectures par minute (429 `kiosk_rate`). Contenu 100 % local : ni agenda, ni mail, ni carte.
 */
import type { GlanceHousehold, WallDeparture, WallHaState, WallWeather } from "./household-wall.js";

export interface KioskView {
  /** Heure de la machine, ISO avec décalage. */
  now: string;
  tz: string;
  /** `null` sans le pack Essentiels ou sans lieu réglé. */
  weather: WallWeather | null;
  departures: WallDeparture[];
  /** Entités listées dans `kiosk.ha_entities`, filtrées par le noyau (jamais serrure, alarme, garage, portail). */
  ha: WallHaState[];
  /** Emplacement de la présentatrice Nina. */
  presenter: { slot: boolean };
  /** Mode nuit de l'écran (22:00–07:00 : horloge seule). `false` : `kiosk.night: false` dans la config. Absent : vrai. */
  night?: boolean;
  /** Écran V7 publié sur le mur (le noyau sert la page sous sa propre CSP, sans script) ; absent ou `null` : aucune tuile. */
  screen?: KioskScreen | null;
  /** Foyer DÉMO (config `kiosk.household_demo`, valeurs fictives) : membres, agenda, tâches, menus, courses, projets. Absent : listes vides. */
  household?: KioskHousehold | null;
}

/** Forme de la vue Foyer du mur SANS météo, départs ni domotique (ceux du kiosque restent les siens) ; toujours marqué démo. */
export type KioskHousehold = Omit<GlanceHousehold, "weather" | "departures" | "ha" | "at"> & { demo: true };

export interface KioskScreen {
  id: string;
  version: number;
  /** Titre de l'écran (le seul texte de la tuile) ; `titre` : nom français éventuel du champ, lu en repli. */
  title?: string;
  titre?: string;
  /** Adresse de la page, relative à la machine ou absolue. */
  frame_url: string;
}
