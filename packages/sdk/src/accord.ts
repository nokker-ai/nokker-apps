/**
 * ACCORD — appareil physique Autoriser / Refuser, côté app (nokker docs/ACCORD-DEVICE.md §2, `nokker/accord/http.py`).
 * Routes du propriétaire de la machine (jeton local), jamais par la passerelle ; drapeau `local.accord.enabled` éteint
 * par défaut : 404, et l'écran « Appareils » n'existe pas.
 */

/** Un appareil appairé (`Device.to_json`, noyau p2/integ-accord-name). `name` est toujours le nom À MONTRER : celui que la
 * personne a donné, sinon « ACCORD <key8> » (`name_is_default`). `last_seen_at` : dernière connexion de l'appareil
 * (secondes Unix), `null` : jamais connecté. Optionnels pour un noyau plus ancien. */
export interface AccordDevice {
  device_id: string;
  /** 8 premiers hex de SHA-256 de la clé publique de l'appareil : à comparer avec son écran. */
  key8: string;
  /** Secondes Unix. */
  paired_at: number;
  revoked: boolean;
  revoked_at: number | null;
  name?: string | null;
  /** Vrai : le nom montré est le nom par défaut (« ACCORD <key8> »), personne ne l'a changé. */
  name_is_default?: boolean;
  /** Secondes Unix ; `null` : jamais connecté. */
  last_seen_at?: number | null;
}

export interface AccordPairingState {
  /** Fenêtre d'appairage ouverte (« Ajouter un appareil », 2 min). */
  open: boolean;
  closes_in_s: number;
  /** Trois codes faux : appairage bloqué 10 min. */
  locked: boolean;
  locked_for_s: number;
  /** Demandes d'appareils en attente dans la fenêtre : leur key8 (à comparer avec l'écran de l'appareil). */
  requests: { key8: string }[];
}

/** `GET /v1/local/accord` (et `POST …/pair/open`, qui rend le même état). */
export interface AccordStatus {
  enabled: boolean;
  /** SHA-256 du certificat TLS de l'hôte, hex minuscule ; ses 8 premiers caractères sont montrés des deux côtés. */
  host_fp: string;
  host_fp8: string;
  pairing: AccordPairingState;
  devices: AccordDevice[];
}

/** Codes d'erreur de l'appairage (`{error:{code,message}}`) : `bad_code` 400, `pairing_closed` 409, `ambiguous` 409
 * (plusieurs demandes pour un code : la fenêtre se ferme), `pairing_locked` 423 (appairage bloqué 10 min). */
export type AccordPairError = "bad_code" | "pairing_closed" | "pairing_locked" | "ambiguous";
