/**
 * Connexion du client web.
 *
 * 1. Contexte sécurisé (https ou localhost) : clé d'appareil ECDSA P-256 NON extractible (WebCrypto), gardée
 *    dans IndexedDB (un CryptoKey se range tel quel, sans jamais être exporté) ; signature du défi de session.
 *    `VITE_NOKKER_AUTH=passkey` bascule sur la passkey WebAuthn (ADR 0001).
 * 2. Hors contexte sécurisé (http sur l'IP Tailscale en dev) : ni WebCrypto ni WebAuthn — si le serveur est le
 *    mock, jeton de démo `POST /v1/dev/demo-session` (extension mock, n'existe pas côté noyau) ; sinon erreur.
 * 0. Servi par la passerelle `<nom>.nokker.app` (ou `VITE_NOKKER_GATEWAY=1` contre le mock) : connexion par nokker.ai
 *    (code + PKCE, `gateway/auth.ts`), jeton d'accès en mémoire, aucune clé d'appareil sur cette origine.
 */
import { NokkerApiError, NokkerClient, generateDeviceKeyPair, signChallenge, type AcceptInvitationResult } from "@nokker-apps/sdk";
import { tr } from "./i18n/index.js";
import { registerPasskey, signDecisionWithPasskey } from "./webauthn.js";
import { takeLocalToken } from "./onboarding/localToken.js";
import { AUTHORIZE_BASE, GatewayAuthError, RETRY_MS, beginLogin, completeCallback, gatewayHost, refreshDelayMs, refreshToken, type GatewayToken } from "./gateway/auth.js";

export type AuthMode = "device-key" | "passkey" | "demo" | "gateway" | "local";

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

/** Rangement d'une valeur dans la même base (une CryptoKey non extractible ne survit qu'ici à une navigation). */
export const idbPut = async (key: string, value: unknown): Promise<void> => void (await idb((s) => s.put(value, key), "readwrite"));
export const idbGet = <T>(key: string): Promise<T | undefined> => idb<T>((s) => s.get(key) as IDBRequest<T>, "readonly");
export const idbDelete = async (key: string): Promise<void> => void (await idb((s) => s.delete(key), "readwrite"));

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

/** Appareil rangé que le noyau refuse au défi de session (`device_not_approved`, noyau 0309091) : en attente de sa
 * confirmation (`pending`), retiré (`revoked`)… Ni une panne ni un appareil inconnu : l'écran dit quoi faire. */
export class DeviceNotApprovedError extends Error {
  constructor(readonly deviceStatus: string) {
    super("device_not_approved");
  }
}

/** Refus du défi de session : `forget` (appareil inconnu ou plus reconnu : on oublie la clé, retour à l'accueil),
 * l'erreur d'appareil non approuvé, ou `null` (autre erreur : on la laisse remonter). */
export function deviceRefusal(err: unknown): "forget" | DeviceNotApprovedError | null {
  if (!(err instanceof NokkerApiError)) return null;
  const e = (err.body as { error?: { code?: unknown; device_status?: unknown } } | undefined)?.error;
  const code = e && typeof e === "object" ? e.code : undefined;
  if (code === "device_unknown") return "forget";
  if (code === "device_not_approved") return new DeviceNotApprovedError(typeof e?.device_status === "string" ? e.device_status : "pending");
  return GONE.has(err.status) ? "forget" : null;
}

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
    const r = deviceRefusal(err);
    if (r === "forget") {
      await forgetDevice();
      return null;
    }
    throw r ?? err;
  }
}

export const deviceName = (): string => `web-${navigator.platform || tr("browser")}`;

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
    const r = deviceRefusal(err);
    if (r === "forget") {
      await forgetDevice();
      return null;
    }
    throw r ?? err;
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

export function isSecure(): boolean {
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
/** Hôte de passerelle si cette page est servie par `<nom>.nokker.app` (ou forcée pour le mock). */
export function gatewayContext(): string | null {
  // La page d'autorisation est celle de nokker.ai : elle se connecte comme nokker.ai, jamais par la passerelle.
  if (location.pathname === "/gateway/authorize") return null;
  if (import.meta.env?.VITE_NOKKER_GATEWAY === "1") return location.host;
  return gatewayHost(location.hostname);
}

/** `sub` du jeton d'accès (affichage seulement : la signature est vérifiée par le relais et par le Lokkal). */
export function tokenSubject(token: string): string {
  try {
    const part = token.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : "";
  } catch {
    return "";
  }
}

let renewTimer: ReturnType<typeof setTimeout> | undefined;

/** Garde le jeton frais : renouvellement à 80 % de sa durée ; 502 → nouvel essai ; refresh refusé → reconnexion. */
function keepFresh(client: NokkerClient, host: string, tok: GatewayToken): void {
  client.setToken(tok.access_token);
  clearTimeout(renewTimer);
  const schedule = (ms: number): void => {
    renewTimer = setTimeout(() => {
      refreshToken().then(
        (next) => {
          if (next) keepFresh(client, host, next);
          else void beginLogin(host, location.pathname + location.search + location.hash, sessionStorage, authorizeBase()).then((u) => location.assign(u));
        },
        (err: unknown) => {
          if (err instanceof GatewayAuthError && err.kind === "forbidden") {
            console.error("gateway: /_gw/refresh refused (403, Origin or Content-Type) — renewal stopped");
            return;
          }
          schedule(err instanceof GatewayAuthError && err.retryAfterMs ? err.retryAfterMs : RETRY_MS);
        },
      );
    }, ms);
  };
  schedule(refreshDelayMs(tok.expires_in));
}

/** Page d'approbation d'app.nokker.ai pour une carte de cette machine (on ne connaît que l'hôte, pas le machine_id). */
export function remoteApprovalUrl(host: string, approvalId: string): string {
  const u = new URL("/approve", authorizeBase());
  u.search = new URLSearchParams({ host, approval: approvalId }).toString();
  return u.href;
}

const authorizeBase = (): string => (import.meta.env?.VITE_NOKKER_AUTHORIZE_URL as string | undefined) ?? AUTHORIZE_BASE;

function gatewayErrorText(kind: string): string | undefined {
  switch (kind) {
    case "state":
      return tr("The sign-in could not be verified (expired link or opened in another tab). Reload the page.");
    case "denied":
      return tr("Sign-in refused on nokker.ai.");
    case "exchange":
      return tr("The sign-in expired along the way. Reload the page.");
    case "unavailable":
      return tr("The nokker.ai sign-in service is unavailable. Try again in a moment.");
    case "forbidden":
      return tr("The gateway sign-in was refused (application error). Reload the page.");
    default:
      return undefined;
  }
}

/** Un seul passage par chargement de page : le code du callback est à usage unique, et React (StrictMode, ou un
 * remontage) peut relancer l'effet de connexion — le second passage relancerait sinon une connexion en boucle. */
let gatewayOnce: Promise<GatewayToken | null> | null = null;

/** Adresse au chargement : le store réécrit l'URL (fil courant) dès son montage, avant que la connexion la lise. */
const BOOT_URL = typeof location === "undefined" ? null : { path: location.pathname, search: location.search };

function gatewayToken(): Promise<GatewayToken | null> {
  gatewayOnce ??= (async () => {
    if (BOOT_URL?.path !== "/auth/callback") return refreshToken();
    const r = await completeCallback(BOOT_URL.search);
    history.replaceState(null, "", r.back);
    return r;
  })();
  return gatewayOnce;
}

let redirecting = false;

async function gatewayLogin(client: NokkerClient, host: string): Promise<AuthResult> {
  try {
    const tok = await gatewayToken();
    if (!tok) {
      if (!redirecting) {
        redirecting = true;
        location.assign(await beginLogin(host, location.pathname + location.search + location.hash, sessionStorage, authorizeBase()));
      }
      return new Promise<never>(() => undefined); // la page part vers nokker.ai
    }
    keepFresh(client, host, tok);
    return { mode: "gateway", user: tokenSubject(tok.access_token) };
  } catch (err) {
    if (err instanceof GatewayAuthError) throw new Error(gatewayErrorText(err.kind) ?? err.message);
    throw err;
  }
}

/** Servi par un Lokkal en boucle locale (127.0.0.1 / localhost) avec son jeton local (§7.1, `/setup#token=…`). */
export function localTokenContext(): string | null {
  const h = location.hostname;
  if (h !== "127.0.0.1" && h !== "localhost" && h !== "[::1]") return null;
  return takeLocalToken();
}

export async function restoreLogin(client: NokkerClient, mock: boolean): Promise<AuthResult | null> {
  const gw = gatewayContext();
  if (gw) return gatewayLogin(client, gw);
  // Lokkal local : le jeton local vaut session (pas d'appareil à enrôler sur sa propre machine).
  const local = localTokenContext();
  if (local) {
    client.setToken(local);
    return { mode: "local", user: "local-owner" };
  }
  if (isSecure()) {
    const stored = await readStoredDeviceKey();
    if (stored) return deviceKeyLogin(client, stored);
    return import.meta.env?.VITE_NOKKER_AUTH === "passkey" ? passkeyRestore(client) : null;
  }
  if (mock) {
    const session = await client.demoSessionMockExtension();
    return { mode: "demo", user: session.user };
  }
  throw new Error(tr("Insecure context (http): open Nokker over https to enrol this device."));
}
