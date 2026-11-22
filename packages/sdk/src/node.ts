/**
 * Nœud téléphone (nokker docs/LOKKAL-PHONE.md §3, lot P7, PHASE S ; contrat accepté par dev le 06.11).
 * Une machine du compte de nature `phone`, rattachée à un membre, qui exécute des opérations NOMMÉES (table fermée) pour
 * un noyau. Phase S : drapeaux `cloud_link.phone_nodes` + `cloud_link.phone_nodes_unattested` (QA et équipe seulement),
 * sans App Attest ni APNs ; un nœud non attesté ne fait que des LECTURES.
 *
 * Session du membre (l'app) :
 *   POST /v1/link/phone {name, platform, os_version, app_version, public_key_spki, enc_key_spki, key_storage,
 *        attestation: null, push_token: null} → 202 {approval_id, key_fingerprint} (carte forte, signée sur un AUTRE appareil enrôlé en
 *        phase S, qui affiche le nom et l'empreinte de la clé) ; 400 attestation_required ; 409 too_many_phones
 *   GET  /v1/link/phone/registrations/{approval_id} → 202 {status: "pending"} | 201 {machine_id, sealed_token, member,
 *        caps_allowed} (une seule fois) | 403 rejected | 410 gone. Le jeton de machine n'apparaît JAMAIS en clair : il est
 *        scellé pour la clé d'ACCORD du nœud (`enc_key_spki`, distincte de la clé de signature) et seul le natif l'ouvre.
 *        Sceau : ECDH P-256 (clé éphémère du noyau) → HKDF-SHA256 (sel vide, info `nokker-phone-v1|<approval_id>`) →
 *        AES-256-GCM (iv 12 o, données associées = approval_id), clair = `{"machine_token": "…"}` ; même forme que
 *        `sealValue` des sites connectés.
 *   GET  /v1/link/phone → {phones: [PhoneInfo]} (téléphones inscrits du membre)
 *   GET  /v1/link/phone/{machine_id}/tasks?limit=200 → {tasks: [PhoneTaskLog]} (journal sans contenu)
 *   POST /v1/link/machines/{id}/revoke (existe)
 * Nœud (jeton de machine + `X-Nokker-Node-Proof`) :
 *   POST /v1/gateway/phone/beat {…§3.3}
 *   GET  /v1/gateway/phone/tasks?wait=25 → {tasks: [PhoneTask]} (bail de 60 s)
 *   POST /v1/gateway/phone/tasks/{id}/lease → {lease_until}
 *   POST /v1/gateway/phone/tasks/{id}/result {status, result?, error?} → {stored}
 *   GET  <image_url | audio_url> : URL signée de 2 min, à usage unique, liée au nœud (403 pour une autre machine)
 *
 * Preuve : `v1;ts=<unix>;nonce=<b64url 16 o>;sig=<b64url r||s 64 o>`, ES256 sur
 * `method\nhost\npath?query\nts\nnonce\nsha256hex(corps)` ; ± 60 s ; nonce refusé s'il est vu dans les 120 s.
 */

export type PhoneCap = "location" | "device_calendar" | "ocr" | "stt" | "egress" | "lan_home" | "camera";
/** P10a : relais Home Assistant du nœud maison, mêmes noms, arguments et résultats que `home-bridge` (OPS). */
export type HaOp = "ha.states" | "ha.registry" | "ha.call_service" | "ha.query" | "ha.history" | "ha.logbook" | "ha.notify" | "ha.tracker_see" | "ha.events";
/** P10c : caméra de veille (texte des événements ; vignette chiffrée lue sur le LAN par l'app du titulaire). */
export type CameraOp = "camera.watch_event" | "camera.thumb_url";
export type PhoneOp = "zone.state" | "calendar.list" | "ocr.image" | "stt.audio" | "fetch.get" | HaOp | CameraOp | "lan.discover";
export const HA_OPS: ReadonlySet<HaOp> = new Set(["ha.states", "ha.registry", "ha.call_service", "ha.query", "ha.history", "ha.logbook", "ha.notify", "ha.tracker_see", "ha.events"]);
/** Actions sur la maison : cartes d'approbation du noyau, et seulement vers un nœud ATTESTÉ (un nœud non attesté ne fait
 * que des lectures). */
export const HA_WRITE_OPS: ReadonlySet<HaOp> = new Set(["ha.call_service", "ha.notify", "ha.tracker_see"]);
export const PHONE_OPS: ReadonlySet<PhoneOp> = new Set<PhoneOp>(["zone.state", "calendar.list", "ocr.image", "stt.audio", "fetch.get", ...HA_OPS, "camera.watch_event", "camera.thumb_url", "lan.discover"]);
export const PHONE_OP_CAP: Record<PhoneOp, PhoneCap> = {
  "zone.state": "location",
  "calendar.list": "device_calendar",
  "ocr.image": "ocr",
  "stt.audio": "stt",
  "fetch.get": "egress",
  ...(Object.fromEntries([...HA_OPS].map((o) => [o, "lan_home"])) as Record<HaOp, PhoneCap>),
  "camera.watch_event": "camera",
  "camera.thumb_url": "camera",
  "lan.discover": "lan_home",
};
export const PHONE_RESULT_MAX = 64 * 1024;
const BIG_HA: ReadonlySet<PhoneOp> = new Set(["ha.states", "ha.registry", "ha.history", "ha.logbook"]);
/** Plafond du résultat par opération : 64 Kio ; `fetch.get` (P11) 1 Mio (texte ≤ 768 Kio) ; états, registre, historique
 * et journal de HA (P10a) 256 Kio pour le transport (le noyau garde ses plafonds avant le modèle). */
export const phoneResultMax = (op: PhoneOp): number => (op === "fetch.get" ? 1024 * 1024 : BIG_HA.has(op) ? 256 * 1024 : PHONE_RESULT_MAX);
export const PHONE_BEAT_S = 60;
export const PHONE_FRESH_S = 180;

export interface PhoneRegisterRequest {
  name: string;
  platform: "ios" | "android";
  os_version: string;
  app_version: string;
  public_key_spki: string; // base64url DER, clé de SIGNATURE (ES256)
  enc_key_spki: string; // base64url DER, clé d'ACCORD (ECDH) qui reçoit le jeton scellé
  key_storage: "secure_enclave" | "strongbox" | "software";
  attestation: null;
  push_token: null;
}

export interface SealedToken {
  v: 1;
  epk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  iv: string;
  ct: string;
}

export interface PhoneRegistered {
  machine_id: string;
  sealed_token: SealedToken;
  member: string;
  caps_allowed: PhoneCap[];
}

export interface PhoneInfo {
  machine_id: string;
  name: string;
  platform: string;
  key_storage: string;
  key_fingerprint: string;
  attested: boolean;
  created_at: string;
  last_beat_at: string | null;
  live: boolean;
}

export interface PhoneBeat {
  v: 1;
  app_version: string;
  os: string;
  mode: "pocket" | "home";
  reach: "live" | "push";
  power: { charging: boolean; level: number };
  net: { type: "wifi" | "cellular" | "none"; metered: boolean; home_wifi: boolean };
  caps: Partial<Record<PhoneCap, "on" | "off" | "denied">>;
  queue: { leased: number };
  slm: "apple" | "gemini_nano" | null;
}

export interface PhoneTask {
  task_id: string;
  op: PhoneOp;
  args: Record<string, unknown>;
  args_sha256: string;
  origin: { kind: "turn" | "agent" | "zone"; thread_id?: string; turn_index?: number };
  heavy: boolean;
  deadline: string;
  lease_until: string;
}

export interface PhoneTaskLog {
  task_id: string;
  op: PhoneOp;
  origin: PhoneTask["origin"]["kind"];
  status: "queued" | "leased" | "done" | "failed" | "expired" | "cancelled";
  at: string;
  /** `fetch.get` : l'HÔTE seulement (ni chemin ni requête). */
  host?: string;
}

export interface PhoneTaskResult {
  status: "done" | "failed";
  result?: string;
  error?: { code: string; message?: string };
}

export const sealInfo = (approvalId: string): string => `nokker-phone-v1|${approvalId}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type SealCrypto = { subtle: Record<"importKey" | "generateKey" | "deriveBits" | "encrypt" | "decrypt" | "exportKey", (...a: any[]) => Promise<any>>; getRandomValues<T extends Uint8Array>(a: T): T };
const sealCrypto = (): SealCrypto => (globalThis as unknown as { crypto: SealCrypto }).crypto;

async function sealKey(c: SealCrypto, shared: ArrayBuffer, approvalId: string, usage: "encrypt" | "decrypt"): Promise<unknown> {
  const hk = await c.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await c.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(sealInfo(approvalId)) }, hk, 256);
  return c.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [usage]);
}

/** Scelle le jeton de machine pour la clé d'accord du nœud (ce que fait le noyau). */
export async function sealToken(encKeySpkiB64u: string, approvalId: string, machineToken: string, c: SealCrypto = sealCrypto()): Promise<SealedToken> {
  const node = await c.subtle.importKey("spki", b64uDecode(encKeySpkiB64u), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = (await c.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { publicKey: unknown; privateKey: unknown };
  const shared = await c.subtle.deriveBits({ name: "ECDH", public: node }, eph.privateKey, 256);
  const key = await sealKey(c, shared, approvalId, "encrypt");
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = await c.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(approvalId) }, key, new TextEncoder().encode(JSON.stringify({ machine_token: machineToken })));
  const epk = (await c.subtle.exportKey("jwk", eph.publicKey)) as { x: string; y: string };
  return { v: 1, epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y }, iv: b64uEncode(iv), ct: b64uEncode(new Uint8Array(ct)) };
}

/** Ouvre le sceau avec la clé privée d'accord (ce que fait le natif ; ici pour les tests et la fausse coque). */
export async function openSealedToken(privateKey: unknown, approvalId: string, s: SealedToken, c: SealCrypto = sealCrypto()): Promise<string> {
  const epk = await c.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: s.epk.x, y: s.epk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await c.subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
  const key = await sealKey(c, shared, approvalId, "decrypt");
  const pt = await c.subtle.decrypt({ name: "AES-GCM", iv: b64uDecode(s.iv), additionalData: new TextEncoder().encode(approvalId) }, key, b64uDecode(s.ct));
  return (JSON.parse(new TextDecoder().decode(pt)) as { machine_token: string }).machine_token;
}

/** Chaîne signée par la preuve (l'hôte en fait partie : une preuve ne se rejoue pas vers un autre hôte). */
export function proofString(method: string, host: string, pathQuery: string, ts: number, nonce: string, bodySha256Hex: string): string {
  return `${method.toUpperCase()}\n${host.toLowerCase()}\n${pathQuery}\n${ts}\n${nonce}\n${bodySha256Hex}`;
}

export const proofHeader = (ts: number, nonce: string, sigB64u: string): string => `v1;ts=${ts};nonce=${nonce};sig=${sigB64u}`;

export function parseProof(h: string | null | undefined): { ts: number; nonce: string; sig: string } | null {
  const m = /^v1;ts=(\d{9,12});nonce=([A-Za-z0-9_-]{16,32});sig=([A-Za-z0-9_-]{80,90})$/.exec(h ?? "");
  return m ? { ts: Number(m[1]), nonce: m[2]!, sig: m[3]! } : null;
}

/** Empreinte affichée par la carte d'inscription : 8 premiers caractères du sha256 (hex) de la clé publique SPKI. */
export async function keyFingerprint(spkiB64u: string, subtle: SubtleLike = webSubtle()): Promise<string> {
  const der = b64uDecode(spkiB64u);
  return hex(new Uint8Array(await subtle.digest("SHA-256", der))).slice(0, 8);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type SubtleLike = { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>; sign?: (...a: any[]) => Promise<ArrayBuffer> };
const webSubtle = (): SubtleLike => (globalThis as unknown as { crypto: { subtle: SubtleLike } }).crypto.subtle;
const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
export const b64uEncode = (u: Uint8Array): string => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const b64uDecode = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export async function bytesSha256Hex(data: Uint8Array, subtle: SubtleLike = webSubtle()): Promise<string> {
  return hex(new Uint8Array(await subtle.digest("SHA-256", data)));
}

/**
 * Client du NŒUD (ce que l'app native fait en Swift) : jeton de machine + preuve signée par la clé du nœud.
 * Sert aux tests et au faux noyau ; `sign` rend la signature r||s (64 octets) de la chaîne de preuve.
 */
export class NodeClient {
  constructor(
    readonly baseUrl: string,
    readonly machineToken: string,
    readonly sign: (data: Uint8Array) => Promise<Uint8Array>,
    readonly fetchImpl: typeof fetch = fetch,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async call<T>(method: string, pathQuery: string, body?: unknown, extra: { nonce?: string; ts?: number } = {}): Promise<{ status: number; body: T }> {
    const raw = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const ts = extra.ts ?? this.now();
    const nonce = extra.nonce ?? b64uEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const host = new URL(this.baseUrl).host;
    const sig = await this.sign(new TextEncoder().encode(proofString(method, host, pathQuery, ts, nonce, await bytesSha256Hex(raw))));
    const res = await this.fetchImpl(`${this.baseUrl}${pathQuery}`, {
      method,
      headers: { Authorization: `Bearer ${this.machineToken}`, "X-Nokker-Node-Proof": proofHeader(ts, nonce, b64uEncode(sig)), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: raw }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  beat(b: PhoneBeat) {
    return this.call<{ ok: boolean; state: string }>("POST", "/v1/gateway/phone/beat", b);
  }
  poll(wait = 25) {
    return this.call<{ tasks: PhoneTask[] }>("GET", `/v1/gateway/phone/tasks?wait=${wait}`);
  }
  lease(id: string) {
    return this.call<{ lease_until: string }>("POST", `/v1/gateway/phone/tasks/${encodeURIComponent(id)}/lease`, {});
  }
  result(id: string, r: PhoneTaskResult) {
    return this.call<{ stored: boolean }>("POST", `/v1/gateway/phone/tasks/${encodeURIComponent(id)}/result`, r);
  }
}
