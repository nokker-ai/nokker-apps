/**
 * Types de l'étape 5 du noyau (invitation → compte → conditions, connecteurs, appairage Telegram).
 * Routes : `nokker/onboarding/http.py` (C5), `nokker/connectors/http.py` (C2/C3), `nokker/telegram/http.py` (C4).
 * Les erreurs de ces routes sont `{error: "<code>", message?}` (code = chaîne, pas l'objet des autres routes).
 */

/** `GET /v1/onboarding/invitation?t=` — ne consomme rien. */
export interface InvitationInfo {
  valid: boolean;
  lang?: string;
  prenom?: string;
}

/** `GET /v1/onboarding/terms?lang=` — `sha256` est la version que l'acceptation doit citer. */
export interface TermsDocument {
  lang: string;
  sha256: string;
  text: string;
}

/** `POST /v1/onboarding/accept` — public, la clé privée ne quitte jamais l'appareil. */
export interface AcceptInvitationRequest {
  token: string;
  terms_sha256: string;
  public_key_spki: string;
  name: string;
  /** Consentement d'usage des conversations pour améliorer les modèles : facultatif, jamais pré-coché (seul `true` vaut accord). */
  training_consent?: boolean;
}

export interface AcceptInvitationResult {
  account_id: string;
  device_id: string;
  lang: string;
}

/** `POST /v1/auth/email/start` — public. Réponse identique que l'adresse ait un compte ou non (429 si limite). */
export interface EmailLoginStart {
  sent: true;
}

/** `POST /v1/auth/email/verify` — le code prouve la boîte mail : l'appareil naît actif (niveau standard). */
export interface EmailLoginVerifyRequest {
  email: string;
  code: string;
  name: string;
  public_key_spki: string;
}

export interface EmailLoginResult {
  device_id: string;
  user: string;
}

export type ConnectorKind = "mail" | "calendar";
/** `unverified` : enregistré mais pas encore répondu à un essai ; `ok` : a répondu au dernier essai. */
export type ConnectorState = "absent" | "unverified" | "ok";

export interface ConnectorCard {
  kind: ConnectorKind;
  state: ConnectorState;
  /** Réglages publics (compte relié, serveur) — JAMAIS le secret ni l'URL iCal. */
  settings?: Record<string, string | number>;
  connected_at?: string;
  last_ok_at?: string | null;
  /** Présent dans la réponse d'un `PUT`. */
  message?: string;
}

export interface ConnectorsListing {
  connectors: ConnectorCard[];
  presets: { mail: string[]; calendar: string[] };
}

/** Réglages mail : preset (`gmail`, `icloud`, `infomaniak`, `fastmail`) + `address`, ou `custom` + hôtes/ports. */
export type MailSettings =
  | { preset: string; address: string; username?: string }
  | {
      preset: "custom";
      address: string;
      username?: string;
      imap_host: string;
      imap_port: number;
      smtp_host: string;
      smtp_port: number;
    };

/** Agenda : iCal (lecture, secret = URL complète) ou CalDAV (lecture + écriture, secret = mot de passe d'application). */
export type CalendarSettings =
  | { mode: "ical"; label: string }
  | { mode: "caldav"; url: string; username: string };

export interface PutConnectorRequest {
  settings: MailSettings | CalendarSettings;
  /** Mot de passe d'application (mail, CalDAV) ou URL iCal : entre une fois, ne ressort jamais. */
  secret: string;
}

export interface ConnectorTestResult {
  ok: boolean;
  message: string;
  code: string | null;
}

/** `POST /v1/telegram/pairing` — un seul bot partagé ; le code lie ce compte au chat qui l'envoie. */
export interface TelegramPairing {
  code: string;
  link: string;
  /** ISO 8601. */
  expires_at: string;
}
