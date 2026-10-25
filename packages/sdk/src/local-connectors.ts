/**
 * Boîte mail posée DANS Lokkal (LOKKAL §7.25), pour le propriétaire local : jeton local seulement (par la passerelle,
 * tout répond 403, lecture comprise). Le mot de passe est désigné par le NOM d'un secret du coffre local (§7.10) ;
 * une valeur, un nom absent du coffre ou un champ `password` → 400, sans répéter ce qui a été envoyé.
 * Erreurs au format des connecteurs : `{error: <code>, message}`.
 */
import type { ConnectorCard, MailSettings } from "./onboarding.js";

export interface LocalMailCard extends ConnectorCard {
  kind: "mail";
  locality: "local";
  /** NOM du secret du coffre local qui porte le mot de passe (jamais sa valeur). */
  secret?: string;
}

export interface LocalConnectorsListing {
  connectors: LocalMailCard[];
  presets: { mail: string[] };
}

export interface PutLocalMailRequest {
  settings: MailSettings;
  /** `NOM` ou `secret:NOM` d'un secret déjà rangé dans le coffre local. */
  secret: string;
}

/** Codes des connecteurs (`nokker/connectors/http.py`) et statut HTTP associé. */
export const LOCAL_CONNECTOR_STATUS: Record<string, number> = {
  bad_settings: 400,
  port_not_allowed: 400,
  host_blocked: 400,
  unsupported: 400,
  not_configured: 404,
  auth_failed: 422,
  unreachable: 502,
  tls_failed: 502,
  protocol_error: 502,
  key_missing: 503,
};
