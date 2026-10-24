/**
 * Enrôlement d'appareil + connexion (APPROVALS.md §3, CLIENT-API.md §Authentification).
 *
 * La CLI n'a pas de Secure Enclave : contrairement à la Mini App Telegram (clé WebCrypto
 * `extractable` rangée en `biometricToken` libéré par Face ID) ou à une app native avec Secure
 * Enclave/StrongBox, ici la clé privée DOIT être exportable pour survivre entre deux lancements du
 * processus — elle est donc générée `extractable: true`, exportée en JWK, et rangée via
 * `keychain.ts` (trousseau OS si dispo, sinon fichier 0600). C'est la même tension que documente
 * APPROVALS.md §3 ("non extractible ailleurs") : "ailleurs" veut dire "dans une app avec enclave
 * sécurisée", pas "un process CLI nu" — à confirmer côté noyau, noté dans docs/ARCHITECTURE.md.
 */
import { webcrypto } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import {
  NokkerApiError,
  NokkerClient,
  base64UrlEncode,
  canonicalJson,
  type Device,
  type SessionToken,
} from "@nokker-apps/sdk";
import { openKeychain } from "./keychain.js";
import { deviceKeyFilePath, sessionFilePath } from "./config.js";
import { cliLog } from "./log.js";
import { resolveTokenPath } from "./lokkal.js";

export interface DeviceIdentity {
  deviceId: string;
  privateKey: webcrypto.CryptoKey;
  /** SPKI DER, base64url SANS padding — forme canonique émise à l'enrôlement (APPROVALS.md §3.1). */
  publicKeySpkiB64Url: string;
}

interface StoredDeviceIdentity {
  deviceId: string;
  publicKeySpkiB64Url: string;
  privateKeyJwk: webcrypto.JsonWebKey;
  /** Code court de confirmation (6 car.), gardé pour le réafficher si l'appareil est encore `pending`. */
  code?: string;
}

async function loadStoredIdentity(account: string): Promise<StoredDeviceIdentity | null> {
  const keychain = await openKeychain(deviceKeyFilePath());
  const raw = await keychain.get(account);
  if (!raw) return null;
  return JSON.parse(raw) as StoredDeviceIdentity;
}

async function saveStoredIdentity(account: string, stored: StoredDeviceIdentity): Promise<void> {
  const keychain = await openKeychain(deviceKeyFilePath());
  await keychain.set(account, JSON.stringify(stored));
}

const DEVICE_ACCOUNT = "default";

/** Enrôle un nouvel appareil auprès du serveur et range la clé localement. Idempotent : si une
 * identité existe déjà localement, elle est réutilisée (pas de ré-enrôlement silencieux). */
export async function ensureDeviceIdentity(
  client: NokkerClient,
  deviceName: string,
  user: string = defaultUser(),
): Promise<{ identity: DeviceIdentity; device: Device; freshlyEnrolled: boolean }> {
  const existing = await loadStoredIdentity(DEVICE_ACCOUNT);
  if (existing) {
    const privateKey = (await webcrypto.subtle.importKey(
      "jwk",
      existing.privateKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    )) as webcrypto.CryptoKey;
    return {
      identity: { deviceId: existing.deviceId, privateKey, publicKeySpkiB64Url: existing.publicKeySpkiB64Url },
      // Approximation locale (pas de round-trip serveur ici) — `code`/`approved_via` réels ne sont
      // connus qu'au moment de l'enrôlement, jamais relus depuis `GET /v1/devices` ici.
      device: {
        id: existing.deviceId,
        code: existing.code ?? "",
        name: deviceName,
        user,
        status: "approved",
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        approved_via: null,
      },
      freshlyEnrolled: false,
    };
  }

  const { publicKey, privateKey } = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, // extractable — voir le commentaire de module.
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;
  const spki = await webcrypto.subtle.exportKey("spki", publicKey);
  const publicKeySpkiB64Url = base64UrlEncode(new Uint8Array(spki));

  // APPROVALS.md §3.1bis : sans compte lié, l'utilisateur est DÉCLARÉ à l'enrôlement et l'appareil reste
  // `pending` jusqu'à confirmation (hôte ou TOTP de cet utilisateur).
  const device = await client.enrollDevice({ name: deviceName, public_key_spki: publicKeySpkiB64Url, user });

  const privateKeyJwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  await saveStoredIdentity(DEVICE_ACCOUNT, { deviceId: device.id, publicKeySpkiB64Url, privateKeyJwk, code: device.code });

  return {
    identity: { deviceId: device.id, privateKey, publicKeySpkiB64Url },
    device,
    freshlyEnrolled: true,
  };
}

/** Signe `challenge + "." + suffix` (ou `challenge` seul si `suffix` omis) — APPROVALS.md §3.3
 * (décision : `"approve"`/`"reject"`) et §3.6 (connexion : `"login"`). */
export async function signWithDevice(privateKey: webcrypto.CryptoKey, challenge: string, suffix?: string): Promise<string> {
  const payload = suffix === undefined ? challenge : `${challenge}.${suffix}`;
  const sig = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload),
  );
  return base64UrlEncode(new Uint8Array(sig));
}

export function defaultUser(): string {
  if (process.env.NOKKER_USER) return process.env.NOKKER_USER;
  try {
    return userInfo().username;
  } catch {
    return "local";
  }
}

export interface LoginOptions {
  /** Utilisateur déclaré à l'enrôlement (défaut : `$NOKKER_USER` puis l'utilisateur du système). */
  user?: string;
  /** Appelé quand l'appareil est `pending` : afficher `device.code` et dire comment le confirmer. */
  onPending?: (device: Device) => void;
  /** TOTP : confirme l'appareil tout de suite (`POST /v1/devices/{id}/confirm`). */
  totp?: string;
  pollMs?: number;
  /** Attente maximale de la confirmation (défaut 5 min). */
  timeoutMs?: number;
}

/** Connexion complète : enrôle l'appareil si besoin, attend sa confirmation s'il est `pending` (code affiché),
 * demande le défi de session (`client.requestSessionChallenge`, route réelle du noyau depuis le 18.10.2026),
 * signe `challenge + ".login"` (APPROVALS.md §3.6), échange contre un jeton. */
export async function login(client: NokkerClient, deviceName: string, opts: LoginOptions = {}): Promise<SessionToken> {
  const user = opts.user ?? defaultUser();
  const { identity, device } = await ensureDeviceIdentity(client, deviceName, user);
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  let announced = false;
  if (device.status === "pending") {
    announced = true;
    opts.onPending?.(device);
    if (opts.totp) await client.confirmDevice(device.id, { totp: opts.totp, user });
  }
  for (;;) {
    try {
      const { challenge } = await client.requestSessionChallenge(identity.deviceId);
      const signature = await signWithDevice(identity.privateKey, challenge, "login");
      const token = await client.createSession({ device_id: identity.deviceId, challenge, signature });
      await persistSession(token);
      return token;
    } catch (err) {
      // 403 = appareil inconnu ou non approuvé (encore `pending`) : on attend sa confirmation.
      if (!(err instanceof NokkerApiError) || err.status !== 403) throw err;
      if (!announced) {
        announced = true;
        opts.onPending?.({ ...device, status: "pending" });
      }
      if (Date.now() > deadline) throw new Error("Appareil non confirmé (délai dépassé) — relance nokker une fois le code confirmé.");
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
    }
  }
}

export function isLocalServer(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

export async function readLocalToken(): Promise<string | null> {
  try {
    const t = (await readFile(resolveTokenPath(), "utf-8")).trim();
    return t || null;
  } catch {
    return null;
  }
}

export interface Connection {
  user: string;
  /** `local` = jeton local (aucun enrôlement) ; `device` = appareil enrôlé + session. */
  mode: "local" | "device";
  identity: DeviceIdentity | null;
}

/** Établit l'identité du client : jeton local si le serveur est local et que le fichier existe (puis vérifié
 * par un appel), sinon session d'appareil enregistrée, sinon flux d'appareil complet. */
export async function connect(client: NokkerClient, serverUrl: string, deviceName: string, opts: LoginOptions = {}): Promise<Connection> {
  if (isLocalServer(serverUrl)) {
    const local = await readLocalToken();
    if (local) {
      client.setToken(local);
      try {
        await client.listThreads();
        cliLog("info", `connexion par jeton local sur ${serverUrl}`);
        return { user: "local-owner", mode: "local", identity: null };
      } catch (err) {
        cliLog("warn", `jeton local refusé sur ${serverUrl} : ${String(err)}`);
      }
    }
  }
  const saved = await loadSession();
  if (saved) {
    client.setToken(saved.token);
    try {
      await client.listThreads();
      const { identity } = await ensureDeviceIdentity(client, deviceName, saved.user);
      return { user: saved.user, mode: "device", identity };
    } catch {
      cliLog("warn", "session enregistrée refusée, nouvelle connexion");
    }
  }
  const token = await login(client, deviceName, opts);
  const { identity } = await ensureDeviceIdentity(client, deviceName, token.user);
  return { user: token.user, mode: "device", identity };
}

async function persistSession(token: SessionToken): Promise<void> {
  const path = sessionFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadSession(): Promise<SessionToken | null> {
  try {
    const raw = await readFile(sessionFilePath(), "utf-8");
    const token = JSON.parse(raw) as SessionToken;
    if (Date.parse(token.expires_at) < Date.now()) return null;
    return token;
  } catch {
    return null;
  }
}

// Ré-exporté pour que les appelants n'aient pas besoin d'importer directement `canonicalJson`.
export { canonicalJson };
