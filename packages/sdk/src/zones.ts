/**
 * Zones du membre et scénarios d'arrivée / départ (nokker docs/LOKKAL-PHONE.md §4.2, lot P6 ; contrat de la phase S
 * accepté par dev le 06.11). Le noyau ne connaît que le NOM et l'id d'une zone, jamais ses coordonnées (elles restent
 * sur l'appareil) ; il reçoit les transitions et lance les scénarios du membre avec les ACL du foyer.
 *
 *   GET  /v1/me/zones                      → {zones: [Zone]}
 *   PUT  /v1/me/zones {zones: [Zone]}       → {zones} ; 18 au plus, nom de 1 à 40 caractères ; 400 sinon
 *   POST /v1/me/zones/{id}/event {event_id, event, at} → 202 {queued, scenarios} ; 200 {duplicate: true} (même event_id) ;
 *        409 out_of_order (plus vieille que la dernière transition de la zone) ; 404 zone inconnue.
 *        Plus de 30 min : présence seulement, scénarios `skipped` (raison `stale`). Serrure ou alarme : `card`.
 *   GET  /v1/home/scenarios                → {scenarios: [{id, name, strong}], bridge: "home-bridge"|"home-node"|null}
 * Phase S : authentification par la session de l'app ; jeton du nœud téléphone au lot P7.
 */

export interface Zone {
  id: string; // zn_…
  name: string;
  on_enter: string[];
  on_exit: string[];
  /** La zone « maison » du membre (une seule ; 400 si deux). Toute autre clé que id, name, on_enter, on_exit, home : 400. */
  home?: boolean;
}

export interface ZoneEventRequest {
  event_id: string;
  event: "enter" | "exit";
  at: string;
}

export interface ZoneScenarioOutcome {
  id: string;
  status: "started" | "card" | "skipped";
  /** `stale` (> 30 min), `not_allowed` (ACL du foyer), `no_bridge`… */
  reason?: string;
}

export interface ZoneEventResult {
  queued?: boolean;
  duplicate?: boolean;
  scenarios?: ZoneScenarioOutcome[];
}

export interface HomeScenario {
  id: string;
  name: string;
  /** Serrure, alarme… : jamais lancé directement, une carte forte est proposée. */
  strong: boolean;
}

export interface HomeScenarios {
  scenarios: HomeScenario[];
  bridge: "home-bridge" | "home-node" | null;
}

export const ZONES_MAX = 18;
export const ZONE_NAME_MAX = 40;
export const ZONE_STALE_MS = 30 * 60_000;
