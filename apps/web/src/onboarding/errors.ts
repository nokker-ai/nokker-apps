import { NokkerApiError } from "@nokker-apps/sdk";
import type { Key } from "./i18n.js";

/** Code d'erreur d'une route d'onboarding/connecteur : corps `{error: "<code>", message?}` (chaîne), à ne pas
 * confondre avec l'objet `{error:{message}}` des autres routes. */
export function errorCode(err: unknown): string {
  if (err instanceof NokkerApiError) {
    const e = (err.body as { error?: unknown } | undefined)?.error;
    if (typeof e === "string" && e) return e;
    // Forme objet `{error:{message:"strong_device_required"}}` (routes d'approbation) : seul un code snake_case compte.
    const m = (e as { message?: unknown } | null | undefined)?.message;
    if (typeof m === "string" && /^[a-z][a-z0-9_]*$/.test(m)) return m;
    if (err.status === 429) return "rate";
    if (err.status === 401) return "unauthorized";
    if (err.status === 504 || err.status === 408) return "timeout";
    if (err.status === 503) return "front_unavailable";
    return "http_" + err.status;
  }
  if (err instanceof Error && err.message === "insecure_context") return "insecure_context";
  if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) return "passkey";
  if (err instanceof TypeError) return "network";
  return "unknown";
}

const KEYS: Record<string, Key> = {
  auth_failed: "errAuthFailed",
  host_blocked: "errHostBlocked",
  port_not_allowed: "errPortNotAllowed",
  unreachable: "errUnreachable",
  tls_failed: "errTlsFailed",
  timeout: "errTimeout",
  rate: "errRate",
  rate_limited: "errRate",
  too_many_requests: "errRate",
  bad_settings: "errBadSettings",
  not_configured: "errNotConfigured",
  terms_mismatch: "errTermsMismatch",
  invalid_key: "errInvalidKey",
  invalid_token: "errInvalidToken",
  unauthorized: "errUnauthorized",
  insecure_context: "errInsecure",
  passkey: "errPasskey",
  network: "errNetwork",
  account_exists: "errAccountExists",
  front_unavailable: "errFrontUnavailable",
  internal: "errInternal",
  key_missing: "errKeyMissing",
  protocol_error: "errProtocol",
  unsupported: "errUnsupported",
  strong_device_required: "errStrongDevice",
  already_subscribed: "errAlreadySubscribed",
  no_customer: "errNoCustomer",
  account_deleting: "errAccountDeleting",
  no_default_model: "lkErrNoDefault",
  bad_default: "lkErrNoDefault",
};

/** Clé de traduction à afficher pour une erreur : jamais le texte brut du serveur ni une trace. */
export function keyForCode(code: string | null | undefined): Key {
  return (code && KEYS[code]) || "errGeneric";
}

export function errorKey(err: unknown): Key {
  return keyForCode(errorCode(err));
}

/** Échec du GET invitation : seul un jeton refusé (410 / invalid_token) est « introuvable ou expiré » ; le reste
 * (429, 503, réseau…) est un problème de service, pas de lien. */
export function invitationFailure(err: unknown): "invalid" | "unreachable" {
  if (err instanceof NokkerApiError && (err.status === 410 || errorCode(err) === "invalid_token")) return "invalid";
  return "unreachable";
}

/** Erreur d'une route `/v1/local/*` du noyau Lokkal : `{error:{message}}` sans code, donc on lit le statut HTTP (400 entrée
 * refusée, 401 jeton, 403 Host, 502 service de lien nokker.ai, 503 coffre sans clé). Le texte du noyau n'est jamais affiché. */
export function localErrorKey(err: unknown): Key {
  if (err instanceof NokkerApiError) {
    if (err.status === 400) return "lkErrInput";
    if (err.status === 401) return "errUnauthorized";
    if (err.status === 403) return "lkErrHost";
    if (err.status === 502) return "lkErrUpstream";
    if (err.status === 503) return "lkErrVault";
    return "errGeneric";
  }
  return err instanceof TypeError ? "errNetwork" : "errGeneric";
}

/** Texte d'erreur de `models/test` : « HTTP 401/403 » = clé refusée ; le reste (nom d'exception httpx, autre HTTP) = injoignable. */
export function testErrorKind(error: string | null | undefined): "invalid_key" | "url" | "unreachable" {
  const e = error ?? "";
  if (/^HTTP (401|403)$/.test(e)) return "invalid_key";
  if (e.startsWith("base_url")) return "url";
  return "unreachable";
}
