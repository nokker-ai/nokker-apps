/**
 * Signature ECDSA P-256 des défis (APPROVALS.md §3) — WebCrypto (`crypto.subtle`), pas une lib
 * spécifique à une plate-forme : disponible nativement sous Node ≥ 16 (`node:crypto`.webcrypto ou
 * global depuis Node 19), dans tout navigateur, et sous React Native via un polyfill standard
 * (`react-native-webcrypto` / `expo-crypto` selon la cible — affaire d'`apps/*`, pas du SDK).
 *
 * Format exact du contrat : signature ECDSA P-256 SHA-256, **IEEE P1363** (r‖s bruts, PAS DER),
 * encodée base64url. WebCrypto `crypto.subtle.sign("ECDSA", ...)` produit déjà du P1363 — c'est
 * DER qu'il aurait fallu reconvertir. Rien à faire ici, mais c'est le piège classique : si un jour
 * la signature passe par `node:crypto.createSign` (OpenSSL), elle sort en DER et doit être
 * convertie en P1363 avant envoi.
 */

export interface SubtleCryptoLike {
  generateKey(
    algorithm: { name: "ECDSA"; namedCurve: "P-256" },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<{ publicKey: unknown; privateKey: unknown }>;
  exportKey(format: "spki" | "pkcs8", key: unknown): Promise<ArrayBuffer>;
  importKey(
    format: "spki" | "pkcs8",
    keyData: ArrayBuffer,
    algorithm: { name: "ECDSA"; namedCurve: "P-256" },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<unknown>;
  sign(algorithm: { name: "ECDSA"; hash: "SHA-256" }, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
  verify(
    algorithm: { name: "ECDSA"; hash: "SHA-256" },
    key: unknown,
    signature: ArrayBuffer,
    data: ArrayBuffer,
  ): Promise<boolean>;
}

function getSubtle(subtle?: SubtleCryptoLike): SubtleCryptoLike {
  if (subtle) return subtle;
  const g = globalThis as unknown as { crypto?: { subtle?: SubtleCryptoLike } };
  if (!g.crypto?.subtle) {
    throw new Error(
      "WebCrypto indisponible — passer `subtle` explicitement (ex. require('node:crypto').webcrypto.subtle sous Node < 19).",
    );
  }
  return g.crypto.subtle;
}

const textEncoder = new TextEncoder();

// `btoa` est global sous Node ≥ 16 (stable depuis 18), dans tout navigateur, et sous React Native
// récent — pas besoin du repli `Buffer` (qui, en plus, ferait dépendre ce fichier partagé des types
// Node quand il est type-checké depuis `apps/web`, sans lib Node).
function bytesToBinaryString(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return bin;
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(bytesToBinaryString(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64Encode(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(bytesToBinaryString(bytes));
}

export interface DeviceKeyPair {
  /** SPKI DER, base64url SANS padding — forme canonique du champ `public_key_spki`
   * (APPROVALS.md §3.1, EnrollDeviceRequest). */
  publicKeySpkiB64Url: string;
  /** Référence opaque (CryptoKey) — jamais sérialisée ni loggée. */
  privateKey: unknown;
}

/** Génère une paire ECDSA P-256 d'appareil (APPROVALS.md §3). `extractable: false` par défaut —
 * seule la Mini App Telegram a besoin d'une clé extractible (WebCrypto `extractable`, rangée
 * `biometricToken` libérée par Face ID) ; `apps/cli` et `apps/web` n'en ont pas besoin. */
export async function generateDeviceKeyPair(
  opts: { extractable?: boolean; subtle?: SubtleCryptoLike } = {},
): Promise<DeviceKeyPair> {
  const subtle = getSubtle(opts.subtle);
  const { publicKey, privateKey } = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    opts.extractable ?? false,
    ["sign", "verify"],
  );
  const spki = await subtle.exportKey("spki", publicKey);
  return { publicKeySpkiB64Url: base64UrlEncode(spki), privateKey };
}

/** Signe `challenge + "." + suffix` (APPROVALS.md §3.3 : « la décision est incluse dans la
 * signature ») — ou juste `challenge` seul si `suffix` est omis. `suffix` porte soit une décision
 * (`"approve"`/`"reject"`), soit `"login"` pour `/v1/sessions` (§3.6 : signe `challenge + ".login"`). */
export async function signChallenge(
  privateKey: unknown,
  challenge: string,
  suffix?: string,
  subtle?: SubtleCryptoLike,
): Promise<string> {
  const s = getSubtle(subtle);
  const payload = suffix === undefined ? challenge : `${challenge}.${suffix}`;
  const sig = await s.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, textEncoder.encode(payload).buffer);
  return base64UrlEncode(sig);
}
