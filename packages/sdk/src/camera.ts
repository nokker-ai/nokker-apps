/**
 * Routes de l'app (session du TITULAIRE du nœud ; lecture à la demande par la file, 10 s, rien gardé au noyau,
 * no-store ; contrat verrouillé avec onboarding le 06.11) :
 *   GET  /v1/link/phone/{machine_id}/camera/events?after=<epoch s> → {items, now}
 *   POST /v1/link/phone/{machine_id}/camera/thumb {id}             → {url, key, expires_in}
 *   Erreurs : 404 not_found, 409 node_offline, 410 thumb_gone, 504 phone_timeout.
 *
 * Caméra de veille du nœud maison (LOKKAL-PHONE §4.4, lot P10c ; contrat validé par dev le 06.11, doctrine HOME-WATCH
 * §1 : les images ne quittent jamais le réseau local).
 *
 * - Détection SUR l'appareil (2 images/s, différence de luminance, classe « personne » par Vision) ; un événement au
 *   plus par minute. « personne » est une CLASSE, jamais une identité : aucune reconnaissance de visage.
 * - Le noyau ne reçoit que du TEXTE (`camera.watch_event`, forme réduite de `cameras.reviews`) ; le modèle ne voit
 *   jamais d'image en v1.
 * - Vignette : sur l'appareil 24 h (≤ 200 Mo), lue seulement depuis le même Wi-Fi, CHIFFRÉE de bout en bout :
 *   `camera.thumb_url` rend une URL LAN à usage unique et une clé AES-256-GCM propre à la demande ; le natif du
 *   téléphone du titulaire lit le chiffré et le déchiffre (le LAN ne voit que du chiffré, le noyau ne peut pas joindre
 *   l'URL et ne journalise ni l'URL ni la clé).
 */

export const CAMERA_PORT = 8802;
export const THUMB_TTL_MAX_S = 300;
export const CAMERA_EVENTS_MAX = 200;

/** Forme réduite de `cameras.reviews` (contrat verrouillé avec onboarding, 06.11 ; le noyau nettoie sur cette
 * liste). `camera` : nom donné par le titulaire (donnée de tiers). `title` : « personne » ou « mouvement », une
 * CLASSE, jamais une identité. */
export interface CameraEvent {
  id: string;
  camera: string;
  start: number;
  end: number;
  severity: "detection";
  niveau: "inconnu";
  title: "personne" | "mouvement";
  summary: null;
  objects: "person"[];
  zones: string[];
  has_thumb: boolean;
}

export interface CameraWatchArgs {
  after: number;
  limit?: number;
}
export interface CameraWatchResult {
  items: CameraEvent[];
  now: number;
}

export interface CameraThumb {
  id: string;
  url: string;
  /** Clé AES-256-GCM de CETTE demande, base64url (32 octets) : jamais journalisée, jamais au modèle. */
  key: string;
  expires_in: number;
}

/** Codes du nœud (vers l'app seulement, jamais au modèle ; phrases dans l'app) et de la route du noyau (404
 * not_found, 409 node_offline, 410 thumb_gone, 504 phone_timeout). */
export type CameraError = "camera_off" | "thumb_gone" | "not_home_wifi" | "denied" | "not_found" | "node_offline" | "phone_timeout";
export const CAMERA_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Réglages de la veille sur le nœud (rendus par le natif, jamais d'image). */
export interface CameraStatus {
  on: boolean;
  name: string;
  sensitivity: "low" | "medium" | "high";
  position: "back" | "front";
  /** Autorisation de l'OS : granted | denied | undetermined. */
  permission: "granted" | "denied" | "undetermined";
  /** `caps.camera` tel qu'envoyé au battement. */
  cap: "on" | "off";
  /** Nombre d'événements gardés (24 h) et taille des vignettes (octets). */
  events: number;
  bytes: number;
}

export const thumbAad = (id: string): Uint8Array => new TextEncoder().encode(`nokker-thumb-v1|${id}`);

const b64uDec = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const b64uEnc = (u: Uint8Array): string => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/* eslint-disable @typescript-eslint/no-explicit-any -- WebCrypto sans la lib DOM (SDK partagé navigateur/Node) */
type Subtle = {
  importKey(format: "raw", key: Uint8Array, alg: { name: "AES-GCM" }, extractable: boolean, usages: string[]): Promise<any>;
  encrypt(alg: { name: "AES-GCM"; iv: Uint8Array; additionalData: Uint8Array }, key: any, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(alg: { name: "AES-GCM"; iv: Uint8Array; additionalData: Uint8Array }, key: any, data: Uint8Array): Promise<ArrayBuffer>;
};
const subtleOf = (s?: Subtle): Subtle => s ?? (globalThis as unknown as { crypto: { subtle: Subtle } }).crypto.subtle;
const randomBytes = (n: number): Uint8Array => (globalThis as unknown as { crypto: { getRandomValues(u: Uint8Array): Uint8Array } }).crypto.getRandomValues(new Uint8Array(n));

/** Chiffre une vignette (référence du natif et du faux noyau) : iv (12) ‖ chiffré ‖ tag. */
export async function encryptThumb(bytes: Uint8Array, id: string, rand: (n: number) => Uint8Array = randomBytes, subtle?: Subtle): Promise<{ key: string; data: Uint8Array }> {
  const raw = rand(32);
  const iv = rand(12);
  const k = await subtleOf(subtle).importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await subtleOf(subtle).encrypt({ name: "AES-GCM", iv, additionalData: thumbAad(id) }, k, bytes));
  const data = new Uint8Array(12 + ct.length);
  data.set(iv, 0);
  data.set(ct, 12);
  return { key: b64uEnc(raw), data };
}

/** Déchiffre une vignette ; lève si la clé, l'id (AAD) ou les octets ne correspondent pas. */
export async function decryptThumb(data: Uint8Array, key: string, id: string, subtle?: Subtle): Promise<Uint8Array> {
  const raw = b64uDec(key);
  if (raw.length !== 32 || data.length < 12 + 16) throw new Error("bad_thumb");
  const k = await subtleOf(subtle).importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await subtleOf(subtle).decrypt({ name: "AES-GCM", iv: data.slice(0, 12), additionalData: thumbAad(id) }, k, data.slice(12)));
}

/** URL de vignette acceptable pour le natif : http, IPv4 privée (RFC 1918), port 8802, chemin `/t/<jeton>`. */
export function thumbUrlCheck(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname);
  if (u.protocol !== "http:" || !m || u.port !== String(CAMERA_PORT) || !/^\/t\/[A-Za-z0-9_-]{32}$/.test(u.pathname) || u.search || u.username) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
