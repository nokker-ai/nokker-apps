/**
 * Connexion du client web.
 *
 * 1. Contexte sécurisé (https ou localhost) : clé d'appareil ECDSA P-256 NON extractible (WebCrypto), gardée
 *    dans IndexedDB (un CryptoKey se range tel quel, sans jamais être exporté) ; signature du défi de session.
 *    `VITE_NOKKER_AUTH=passkey` bascule sur la passkey WebAuthn (ADR 0001).
 * 2. Hors contexte sécurisé (http sur l'IP Tailscale en dev) : ni WebCrypto ni WebAuthn — si le serveur est le
 *    mock, jeton de démo `POST /v1/dev/demo-session` (extension mock, n'existe pas côté noyau) ; sinon erreur.
 */
import { NokkerApiError, NokkerClient, generateDeviceKeyPair, signChallenge, type AcceptInvitationResult } from "@nokker-apps/sdk";
import { registerPasskey, signDecisionWithPasskey } from "./webauthn.js";

export type AuthMode = "device-key" | "passkey" | "demo";

export interface AuthResult {
  mode: AuthMode;
  /** Identité vérifiée portée par le jeton : réponse de `POST /v1/sessions` (`user`, APPROVALS.md §3.6). Le noyau
   * n'expose pas de route « qui suis-je » : c'est la seule source, et elle suffit (on se reconnecte à chaque
   * chargement). Sert de `totp_user` (§3.5). */
  user: string;
  /** Signe un défi d'approbation (`challenge.decision`) — absent en mode démo (TOTP seulement).
   * Forme snake_case du contrat (APPROVALS.md §3.3/§3.4) : `device_id`/`webauthn`. */
  signDecision?: (
    challenge: string,
    decision: "approve" | "reject",
  ) => Promise<{ device_id: string; signature?: string; webauthn?: { client_data_json: string; authenticator_data: string; signature: string } }>;
}

const DB = "nokker-web";
const STORE = "keys";

function idb<T>(fn: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

/** Format EXACT de l'entrée `device` d'IndexedDB lue par `deviceKeyLogin`. */
export interface StoredKey {
  deviceId: string;
  privateKey: CryptoKey;
  publicKeySpkiB64Url: string;
}

export const DEVICE_RECORD_KEY = "device";

export function buildStoredKey(deviceId: string, pair: { privateKey: unknown; publicKeySpkiB64Url: string }): StoredKey {
  return { deviceId, privateKey: pair.privateKey as CryptoKey, publicKeySpkiB64Url: pair.publicKeySpkiB64Url };
}

/** Range l'appareil là où `deviceKeyLogin` le relira : l'App sur « / » se reconnecte sans nouvel enrôlement. */
export async function storeDeviceKey(stored: StoredKey): Promise<void> {
  await idb((s) => s.put(stored, DEVICE_RECORD_KEY), "readwrite");
}

export function readStoredDeviceKey(): Promise<StoredKey | undefined> {
  return idb<StoredKey>((s) => s.get(DEVICE_RECORD_KEY) as IDBRequest<StoredKey>, "readonly");
}

async function deviceKeySession(client: NokkerClient, key: StoredKey): Promise<AuthResult> {
  const { challenge } = await client.requestSessionChallenge(key.deviceId);
  const session = await client.createSession({ device_id: key.deviceId, challenge, signature: await signChallenge(key.privateKey, challenge, "login") });
  return {
    mode: "device-key",
    user: session.user,
    signDecision: async (ch, decision) => ({ device_id: key.deviceId, signature: await signChallenge(key.privateKey, ch, decision) }),
  };
}

/** Appareil inconnu du serveur (base remise à zéro), révoqué ou refusé : on l'oublie, le visiteur revoit l'accueil. */
const GONE = new Set([401, 403, 404]);

export async function forgetDevice(): Promise<void> {
  await idb((s) => s.delete(DEVICE_RECORD_KEY), "readwrite");
  try {
    localStorage.removeItem(PASSKEY_STORAGE);
  } catch {
    /* stockage indisponible */
  }
}

/** Session de l'appareil rangé. `null` : l'appareil n'est plus reconnu (le visiteur repart de l'accueil). */
async function deviceKeyLogin(client: NokkerClient, stored: StoredKey): Promise<AuthResult | null> {
  if (typeof CryptoKey !== "undefined" && !(stored.privateKey instanceof CryptoKey)) {
    await forgetDevice(); // enregistrement illisible (profil copié, stockage corrompu) : mieux vaut l'accueil qu'une panne
    return null;
  }
  try {
    return await deviceKeySession(client, stored);
  } catch (err) {
    if (err instanceof NokkerApiError && GONE.has(err.status)) {
      await forgetDevice();
      return null;
    }
    throw err;
  }
}

const deviceName = (): string => `web-${navigator.platform || "navigateur"}`;

/** Connexion par code reçu par mail : la clé NON extractible est générée ici, le serveur l'enregistre comme
 * appareil actif (le code prouve la boîte mail) ; la session se reprend ensuite par `restoreLogin`. */
export async function loginWithEmailCode(client: NokkerClient, email: string, code: string): Promise<void> {
  if (!isSecure()) throw new Error("insecure_context");
  const pair = await generateDeviceKeyPair();
  const res = await client.verifyEmailCode({ email, code, name: deviceName(), public_key_spki: pair.publicKeySpkiB64Url });
  await storeDeviceKey(buildStoredKey(res.device_id, pair));
}

/** Retour de la connexion Google (`/auth/callback#ticket=…`) : même principe, le ticket tient lieu de code. */
export async function loginWithGoogleTicket(client: NokkerClient, ticket: string): Promise<void> {
  if (!isSecure()) throw new Error("insecure_context");
  const pair = await generateDeviceKeyPair();
  const res = await client.exchangeGoogleTicket({ ticket, name: deviceName(), public_key_spki: pair.publicKeySpkiB64Url });
  await storeDeviceKey(buildStoredKey(res.device_id, pair));
}

async function passkeyRestore(client: NokkerClient): Promise<AuthResult | null> {
  let device: { deviceId: string; credentialIdB64Url: string } | null = null;
  try {
    const raw = localStorage.getItem(PASSKEY_STORAGE);
    device = raw ? JSON.parse(raw) : null;
  } catch {
    device = null;
  }
  if (!device) return null;
  try {
    return await passkeySession(client, device);
  } catch (err) {
    if (err instanceof NokkerApiError && GONE.has(err.status)) {
      await forgetDevice();
      return null;
    }
    throw err;
  }
}

async function passkeySession(client: NokkerClient, d: { deviceId: string; credentialIdB64Url: string }): Promise<AuthResult> {
  const { challenge } = await client.requestSessionChallenge(d.deviceId);
  // Connexion WebAuthn : challenge = SHA-256(challenge) SANS suffixe (APPROVALS.md §3.6) — `suffix` omis.
  const proof = await signDecisionWithPasskey(d.credentialIdB64Url, challenge);
  const session = await client.createSession({ device_id: d.deviceId, challenge, webauthn: proof });
  return {
    mode: "passkey",
    user: session.user,
    signDecision: async (ch, decision) => ({
      device_id: d.deviceId,
      webauthn: await signDecisionWithPasskey(d.credentialIdB64Url, ch, decision),
    }),
  };
}

const PASSKEY_STORAGE = "nokker.web.device";

function isSecure(): boolean {
  return window.isSecureContext && typeof crypto !== "undefined" && !!crypto.subtle;
}

export interface AcceptedLogin {
  auth: AuthResult;
  accepted: AcceptInvitationResult;
}

/** Acceptation d'une invitation (public) puis connexion immédiate : la clé privée est générée ici et ne quitte
 * jamais l'appareil. Passkey si `VITE_NOKKER_AUTH=passkey`, sinon clé d'appareil rangée au format de `deviceKeyLogin`. */
export async function acceptAndLogin(
  client: NokkerClient,
  req: { token: string; termsSha256: string; name: string; trainingConsent?: boolean },
): Promise<AcceptedLogin> {
  if (!isSecure()) throw new Error("insecure_context");
  const base = { token: req.token, terms_sha256: req.termsSha256, name: req.name, training_consent: req.trainingConsent === true };
  if (import.meta.env?.VITE_NOKKER_AUTH === "passkey") {
    const { publicKeySpkiB64Url, credentialIdB64Url } = await registerPasskey("nokker (web)");
    const accepted = await client.acceptInvitation({ ...base, public_key_spki: publicKeySpkiB64Url });
    const device = { deviceId: accepted.device_id, credentialIdB64Url };
    try {
      localStorage.setItem(PASSKEY_STORAGE, JSON.stringify(device));
    } catch {
      /* stockage indisponible : la passkey sera redemandée */
    }
    return { auth: await passkeySession(client, device), accepted };
  }
  const pair = await generateDeviceKeyPair();
  const accepted = await client.acceptInvitation({ ...base, public_key_spki: pair.publicKeySpkiB64Url });
  const stored = buildStoredKey(accepted.device_id, pair);
  await storeDeviceKey(stored);
  return { auth: await deviceKeySession(client, stored), accepted };
}

export async function isMockServer(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/healthz`);
    const j = (await r.json()) as { mock?: boolean };
    return j.mock === true;
  } catch {
    return false;
  }
}

/** Reprend la session de cet appareil. Ne crée JAMAIS de compte ni d'appareil : sans appareil reconnu, `null`
 * (accueil « bêta privée »). L'enrôlement passe par une invitation (`acceptAndLogin`) ou un code mail (`loginWithEmailCode`). */
export async function restoreLogin(client: NokkerClient, mock: boolean): Promise<AuthResult | null> {
  if (isSecure()) {
    const stored = await readStoredDeviceKey();
    if (stored) return deviceKeyLogin(client, stored);
    return import.meta.env?.VITE_NOKKER_AUTH === "passkey" ? passkeyRestore(client) : null;
  }
  if (mock) {
    const session = await client.demoSessionMockExtension();
    return { mode: "demo", user: session.user };
  }
  throw new Error("Contexte non sécurisé (http) : ouvre Nokker en https pour enrôler cet appareil.");
}
