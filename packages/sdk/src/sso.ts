/** SSO OIDC des équipes (LOKKAL §7.24, drapeau `sso` de nokker.ai). Erreurs `{error: {code, message}}`, comme l'équipe. */
import type { ProjectRole } from "./team.js";

/** Rôles qu'un groupe peut donner : jamais `owner` (400 `owner_not_mappable`). */
export type SsoRole = Exclude<ProjectRole, "owner">;
export const SSO_ROLES: SsoRole[] = ["maintainer", "member", "viewer"];
export type SsoTokenAuth = "client_secret_basic" | "client_secret_post";

/** Âge maximal d'une connexion SSO pour un projet « SSO obligatoire » : défaut 12 h, de 300 s à 7 j. */
export const SSO_MAX_AGE = { default: 12 * 3600, min: 300, max: 7 * 86400 } as const;

export interface SsoDomain {
  domain: string;
  verified: boolean;
  verified_at: string | null;
  /** Enregistrement à poser : `_nokker-sso.<domaine>` = `nokker-sso=<jeton>`. */
  txt: { name: string; value: string };
}

export interface SsoConnection {
  id: string;
  name: string;
  issuer: string;
  client_id: string;
  /** Le NOM du secret seulement ; la valeur est au coffre du noyau et ne revient jamais. */
  client_secret: { name: string; set: boolean };
  groups_claim: string;
  token_auth: SsoTokenAuth;
  /** À recopier chez le fournisseur d'identité. */
  redirect_uri: string;
  domains: SsoDomain[];
  projects: string[];
  created_at: string | null;
  updated_at: string | null;
}

export interface SsoConnectionInput {
  name: string;
  issuer: string;
  client_id: string;
  client_secret_name: string;
  groups_claim?: string;
  token_auth?: SsoTokenAuth;
}

export interface SsoMapping {
  group: string;
  role: SsoRole;
}

export interface SsoBinding {
  project_id: string;
  connection: string;
  mappings: SsoMapping[];
  required: boolean;
  max_age_s: number;
  updated_at: string | null;
}

export interface SsoBindingInput {
  connection: string;
  mappings: SsoMapping[];
  required?: boolean;
  max_age_s?: number;
}

export interface SsoAuditEvent {
  at: string | null;
  event: string;
  account: string;
  email: string;
  project_id: string;
  detail: Record<string, unknown>;
}

export interface OidcStartRequest {
  /** `sc_…`, ou à défaut l'e-mail dont le domaine prouvé désigne la connexion. */
  connection?: string;
  email?: string;
  public_key_spki: string;
  name?: string;
  lang?: string;
}

export interface OidcStart {
  authorize_url: string;
  state: string;
  connection: string;
  expires_at: string | null;
}

export interface OidcCallbackRequest {
  state: string;
  code?: string;
  error?: string;
  /** P1363 base64url de `"<state>.oidc"` par la clé du `start`. */
  signature: string;
}

export interface OidcCallbackResult {
  device_id: string;
  user: string;
  projects: { id: string; role: ProjectRole | null }[];
}

/** Codes du `callback` que le client affiche (401, 403, 409). */
export type OidcCallbackError =
  | "invalid_state"
  | "binding_invalid"
  | "idp_error"
  | "token_invalid"
  | "email_unverified"
  | "domain_refused"
  | "account_conflict"
  | "account_inactive";

export const isSsoConnectionId = (s: string): boolean => /^sc_[0-9a-f]{16}$/.test(s);
