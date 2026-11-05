/**
 * `GET /v1/capabilities` (core docs/CLIENT-API.md §Capacités, p2/kernel-cloud-polish 6aaccb4) : fonctions actives POUR
 * L'APPELANT, lues une fois après connexion au lieu de sonder les routes (404 en série). Contrat additif : une clé
 * inconnue s'ignore, une clé absente vaut `false` ; `version` ne monte que si un sens change. `operate`, `plan`, `code`,
 * `glance`, `presence` : ajoutés en b33c304 (un noyau qui ne les a pas encore → le web sonde encore ces cinq-là).
 * Les fonctions d'un compte `us_` (packs, code, presence, team, learning…) sont fausses pour une identité interne,
 * dont le propriétaire Lokkal : leurs routes `/v1/…` lui répondraient 403 (ses routes `/v1/local/…` sont à part).
 */
export type CapabilityName =
  | "account"
  | "agents"
  | "approvals"
  | "billing"
  | "cloud_byok"
  | "code"
  | "connectors_multi"
  | "connectors_oauth"
  | "consolidation"
  | "family_calendar"
  | "glance"
  | "guide"
  | "house"
  | "household"
  | "household_paper"
  | "learning"
  | "local"
  | "local_cost"
  | "long_memory"
  | "operate"
  | "packs"
  | "pay"
  | "pay_agent"
  | "plan"
  | "presence"
  | "share"
  | "show_me"
  | "speech"
  | "sso"
  | "steer"
  | "team"
  | "threads"
  | "turn_cost"
  | "who_does_what";

export interface Capabilities {
  version: number;
  mode: "cloud" | "lokkal";
  features: Partial<Record<CapabilityName, boolean>> & Record<string, boolean>;
}
