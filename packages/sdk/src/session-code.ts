/**
 * Accès à la machine SANS jeton dans l'URL (contrat dev du 18.11.2026 ; côté noyau).
 * Un lien d'ouverture porte `#code=<code>` : un code à usage unique (60 s, une seule fois), échangé contre un jeton de
 * SESSION distinct du jeton local (opaque, haché côté noyau, 30 jours glissants, révocable). Une fuite du lien ne
 * livre donc ni le jeton local ni, après usage ou 60 s, aucun accès.
 */

/** `POST /v1/local/session-code` (jeton local seulement). */
export interface SessionCode {
  code: string;
  /** Secondes de validité (60). */
  expires_in: number;
}

/** Portée d'un jeton de session : `owner` (tout, sauf la gestion des accès), `kiosk` (/kiosk : GET /v1/local/kiosk,
 * /v1/capabilities, /healthz), `present` (/present : propriétaire sans gestion, aucune décision de carte, 12 h fixes).
 * Hors portée : 403 `scope_kiosk` | `scope_present`. Un noyau plus ancien ne la dit pas : `owner`. */
export type AccessScope = "owner" | "kiosk" | "present";

/** `POST /v1/local/session-code/exchange {code}` (sans Authorization). */
export interface SessionExchange {
  token: string;
  /** Durée du jeton de session, en secondes : 30 jours glissants (`owner`, `kiosk`), 12 h fixes (`present`). */
  expires_in: number;
  /** Portée du code mint ; absent d'un noyau plus ancien (= `owner`). */
  scope?: AccessScope;
}

/** Portée d'une réponse d'échange (absente : propriétaire). */
export const scopeOfExchange = (r: { scope?: unknown }): AccessScope => (r.scope === "kiosk" || r.scope === "present" ? r.scope : "owner");

/** `GET /v1/local/access-sessions` (jeton local seulement) : les sessions d'accès (jamais leur jeton). Dates en epoch secondes. */
export interface AccessSession {
  /** `as_` + 16 hex. */
  id: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  /** User-Agent abrégé (60 caractères). */
  agent: string;
}

/** Erreurs de l'échange : 410 `code_used` | `code_expired`, 429 `rate_limited`, 400 code mal formé. */
export type SessionCodeError = "code_used" | "code_expired" | "rate_limited" | "bad_code";
