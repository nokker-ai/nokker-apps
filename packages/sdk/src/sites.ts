/**
 * Sites connectés — contrat du noyau (nokker docs/CONNECTED-SITES.md §15, branche p2/connected-sites bb936b3,
 * `nokker/sites/http.py`). Routes Lokkal `/v1/local/sites*` (jeton local ; relayées par la passerelle pour le
 * propriétaire, mêmes formes). Fonction éteinte : GET rend 200 {enabled: false, reason, message}, les autres routes 409
 * avec le même corps ; profil mineur : 403 `minor` partout. Un noyau sans ces routes (cloud) : 404.
 *
 *   GET    /v1/local/sites                         → {enabled, sites: [SiteCard], catalog, consent_version, consents}
 *   POST   /v1/local/sites                         {site | url, username, label?, answer_here?} → 201 SiteCard & {flow}
 *                                                  409 consent_required ; 400 no_plain_secret, unsupported
 *   GET    /v1/local/sites/{id}                    → SiteCard (avec `request` si une demande est ouverte)
 *   POST   /v1/local/sites/{id}/connect            {answer_here?} → 202 {status} (tester, reconnecter, relancer)
 *   POST   /v1/local/sites/{id}/cancel             → 202 {status: "cancelling"} ; 409 not_connecting
 *   POST   /v1/local/sites/handoff/{jeton}         → {screen_url} (usage unique, 15 min) ; 410 handoff_gone
 *   PATCH  /v1/local/sites/{id}                    {label?, default?: true} → SiteCard
 *   DELETE /v1/local/sites/{id}?forget_credentials=true|false → {deleted: true}
 *   POST   /v1/local/sites/consent                 {site, version} → 204
 *   DELETE /v1/local/sites/{id}/pause              → SiteCard (lever une pause : la personne seulement)
 *   GET    /v1/local/sites/requests/{rid}          → SiteRequest (avec `machine_key`, JWK P-256 éphémère)
 *   POST   /v1/local/sites/requests/{rid}/answer   {sealed} | {done: true} → 204 ; 410 expirée ; 409 déjà répondue
 *   POST   /v1/local/sites/{id}/credentials        → 201 {request} (remplacer le mot de passe)
 *   DELETE /v1/local/sites/{id}/credentials        → 204
 *
 * Saisie scellée (`sealed`, référence `nokker/sites/sealed.js`) : ECDH P-256 (clé éphémère de la page × clé
 * éphémère de la machine pour CETTE demande), HKDF-SHA256 (sel vide, info « nokker-sites-v1|<rid> »), AES-256-GCM
 * (AAD = rid) sur `{"value": …}`. Rien en clair ne quitte la page ; le noyau refuse un secret en clair (400).
 * Les dates du noyau sont des secondes Unix (nombres).
 *
 * `answer_here` : le mot de passe est saisi à l'écran ; la demande Telegram ne part qu'après 30 s sans réponse.
 * Liens servis par le web : `/sites/r/<rid>` (saisie sécurisée d'une demande) et `/sites/h/<jeton>` (ouvrir l'écran du
 * navigateur du site pour une vérification).
 */

export type SiteState =
  | "absent"
  | "connecting"
  | "needs_password"
  | "needs_link"
  | "needs_code"
  | "needs_app_approval"
  | "needs_you"
  | "needs_consent"
  | "connected"
  | "expired"
  | "paused"
  | "suspended"
  | "disconnected"
  | "failed";

export type SiteRequestKind = "password" | "code" | "link" | "app_approval";

export interface SiteCatalogEntry {
  site: string; // linkedin, fakesocial…
  name: string; // LinkedIn
  recipe: boolean;
  gestures: Record<string, string[]>;
}

export interface SiteCard {
  id: string; // st_…
  site: string;
  site_name: string;
  label: string;
  default: boolean;
  /** Identifiant sur le site (e-mail ou nom d'utilisateur) : affiché, pas secret. */
  username: string;
  /** Nom affiché du compte, relevé à la connexion. */
  account_name: string;
  state: SiteState;
  /** Texte de l'état (du noyau, règle du canal du §8.6). */
  state_text: string;
  /** Code stable de la raison (pause, échec, nouvelle demande) ; vide si rien. */
  signal?: SiteSignal | "" | null;
  /** needs_you, propriétaire seulement : lien à usage unique vers la page `/sites/h/<jeton>`. */
  handoff_url?: string | null;
  paused_until?: number | null;
  last_ok_at?: number | null;
  last_auto_login_at?: number | null;
  access: "owner" | "read" | "send";
  /** Compteurs du jour : `{pages: {used, max}, …}`. */
  quotas: Record<string, { used: number; max: number }>;
  credentials?: { stored: boolean; updated_at: number | null };
  grants?: Array<{ account_id: string; level: "read" | "send" }>;
  owner?: { account_id: string };
  /** Demande ouverte (propriétaire seulement) : l'écran y répond. */
  request?: { id: string; kind: SiteRequestKind; expires_at: number } | null;
}

export type SiteSignal =
  | "password_timeout" | "code_timeout" | "wrong_code" | "code_rejected" | "approval_timeout" | "link_timeout"
  | "link_other_site" | "handoff_timeout" | "captcha" | "unknown_screen" | "unusual_activity" | "bad_credentials"
  | "too_many_logins" | "too_many_steps" | "login_page_changed" | "cancelled" | "browser_missing" | "busy" | "internal";

export interface SitesListing {
  /** Faux : fonction éteinte sur la machine (`disabled`) ou pas de machine liée (`no_machine`). */
  enabled: boolean;
  reason?: "disabled" | "no_machine" | string;
  message?: string;
  sites: SiteCard[];
  catalog: SiteCatalogEntry[];
  consent_version: string;
  /** Sites dont l'avertissement est déjà accepté pour cette version. */
  consents: string[];
}

export interface SiteRequest {
  id: string;
  kind: SiteRequestKind;
  label: string;
  expires_at: number;
  /** Clé publique éphémère de la machine (JWK P-256) ; absente pour `app_approval`. */
  machine_key: { kty: string; crv: string; x: string; y: string } | null;
}

export interface SealedValue {
  v: 1;
  epk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  iv: string;
  ct: string;
}

export interface AddSiteRequest {
  site?: string;
  url?: string;
  username: string;
  label?: string;
  /** Le mot de passe est saisi à l'écran : Telegram attend 30 s. */
  answer_here?: true;
}

const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Ce que `sealValue` utilise de WebCrypto (le SDK n'embarque pas les types du DOM). */
/* eslint-disable @typescript-eslint/no-explicit-any */
type LooseCrypto = {
  subtle: Record<"importKey" | "generateKey" | "deriveBits" | "deriveKey" | "encrypt" | "exportKey", (...a: any[]) => Promise<any>>;
  getRandomValues<T extends Uint8Array>(a: T): T;
};
const webcrypto = (): LooseCrypto => (globalThis as unknown as { crypto: LooseCrypto }).crypto;

/** Scelle `value` pour la demande `rid` (même algorithme que `nokker/sites/sealed.js`). */
export async function sealValue(machineKey: NonNullable<SiteRequest["machine_key"]>, rid: string, value: string, c: LooseCrypto = webcrypto()): Promise<SealedValue> {
  const enc = new TextEncoder();
  const machine = await c.subtle.importKey("jwk", { ...machineKey, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = (await c.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { publicKey: unknown; privateKey: unknown };
  const shared = await c.subtle.deriveBits({ name: "ECDH", public: machine }, eph.privateKey, 256);
  const hk = await c.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await c.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("nokker-sites-v1|" + rid) },
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = await c.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(rid) }, key, enc.encode(JSON.stringify({ value })));
  const epk = (await c.subtle.exportKey("jwk", eph.publicKey)) as { x: string; y: string };
  return { v: 1, epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y }, iv: b64u(iv), ct: b64u(ct) };
}
