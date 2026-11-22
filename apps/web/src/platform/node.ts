/**
 * Le téléphone comme nœud du compte (LOKKAL-PHONE §3, lot P7, phase S) côté interface. La clé, le jeton de machine, le
 * battement et le long poll vivent dans le plugin natif `NokkerNode` (ios/App/App/NokkerNodePlugin.swift) ; l'interface
 * lance l'inscription avec la session du membre, attend la carte forte (approuvée sur un AUTRE appareil), puis remet au
 * plugin le jeton SCELLÉ pour la clé d'accord du nœud : seul le natif l'ouvre, l'interface n'a qu'un blob opaque.
 */
import { NokkerApiError, type HomeNodeStatus, type NokkerClient, type PhoneRegistered, type SealedToken } from "@nokker-apps/sdk";
import { isNativeShell, nativePlatform } from "./native.js";

export interface NodeStatus {
  enrolled: boolean;
  running: boolean;
  secure_enclave_available?: boolean;
  key_storage?: "secure_enclave" | "software";
  key_fingerprint?: string;
  machine_id?: string;
  base_url?: string;
  last_beat_at?: string;
  last_error?: string;
  /** P11 : pages par ce téléphone (coupé par défaut), plafond cellulaire mensuel. */
  egress?: { on: boolean; cellular?: boolean; cellular_cap_mb: number; cellular_used_mb: number };
  /** P10a : mode nœud maison (jamais le jeton HA, qui reste dans le trousseau). */
  home?: HomeNodeStatus;
  /** Frapper pour appeler, écoute NATIVE du nœud maison (éteinte par défaut ; allumée par le propriétaire). */
  knock?: { on: boolean; available?: boolean; state: "off" | "listening" | "cut" | "background" | "held" | "denied" | "unavailable"; cut: boolean; permission: "granted" | "denied" | "undetermined" };
}

type Listener = { remove?: () => void };
export interface NodePlugin {
  status(): Promise<NodeStatus>;
  prepareKey(): Promise<{ public_key_spki: string; enc_key_spki: string; key_storage: "secure_enclave" | "software"; key_fingerprint: string }>;
  enroll(o: { machine_id: string; approval_id: string; sealed_token: SealedToken; base_url: string }): Promise<NodeStatus>;
  start(): Promise<NodeStatus>;
  stop(): Promise<NodeStatus>;
  forget(): Promise<NodeStatus>;
  setEgress(o: { on?: boolean; cellular?: boolean; cellular_cap_mb?: number }): Promise<NodeStatus>;
  /** P10a : `{on?, ha_url?, entities?}` ; rejet `bad_url` (adresse non privée) ou `bad_entities`. */
  setHome?(o: { on?: boolean; ha_url?: string; entities?: string[] }): Promise<NodeStatus>;
  /** Champ natif sécurisé : le jeton ne passe jamais par la WebView. */
  promptHaToken?(): Promise<{ saved: boolean }>;
  markHomeWifi?(): Promise<NodeStatus & { ok: boolean }>;
  checkHa?(): Promise<NodeStatus>;
  forgetHome?(): Promise<NodeStatus>;
  /** P10b : écran allumé et luminosité de nuit tant que la page murale est affichée ; retenu pour le prochain lancement. */
  setWall?(o: { on: boolean }): Promise<{ on: boolean; night: boolean }>;
  /** Le jeton `nkg_` du mur, EN MÉMOIRE seulement (jamais localStorage, cookie, IndexedDB, URL ni journal). */
  wallToken?(): Promise<{ token: string | null; device_id: string | null; night: boolean; active: boolean }>;
  /** `{token, device_id}` après l'appairage du mur ; `{}` l'oublie. */
  setWallToken?(o: { token?: string; device_id?: string }): Promise<{ stored: boolean }>;
  /** L'appareil a un code (sinon le mur est refusé). */
  wallCheck?(): Promise<{ passcode: boolean }>;
  /** Sortie du mur : biométrie ou code du propriétaire de l'appareil. */
  authenticateExit?(o?: { reason?: string }): Promise<{ ok: boolean }>;
  /** P10c : réglages de la caméra de veille de CET appareil ; l'allumage demande l'accès à la caméra. */
  setCamera?(o: { on?: boolean; name?: string; sensitivity?: "low" | "medium" | "high"; position?: "back" | "front" }): Promise<NodeStatus>;
  /** P10c : téléphone du titulaire — lit la vignette CHIFFRÉE sur le LAN (usage unique) et la déchiffre dans le natif. */
  fetchLocalImage?(o: { url: string; key: string; id: string }): Promise<{ data: string; type: string }>;
  /** P10d : appareils du réseau local vus d'ici (noms et types seulement ; Wi-Fi maison exigé). */
  discoverLan?(o?: { types?: string[] }): Promise<{ services: { id: string; type: string; types: string[]; name: string }[]; at: string }>;
  /** P10d : « Trouver Home Assistant » — URL interne annoncée par HA, sur l'appareil, déjà acceptée par la garde privée. */
  discoverHa?(): Promise<{ candidates: { name: string; url: string }[] }>;
  addListener?(ev: "nodeState", cb: (s: NodeStatus) => void): Promise<Listener> | Listener;
  /** Trois coups entendus par le natif (après le « oui ? ») : aucun son, seulement l'instant et la confiance. */
  addListener?(ev: "knock", cb: (e: { t: number; confidence: number }) => void): Promise<Listener> | Listener;
  /** `{on: true}` : Face ID, Touch ID ou code du propriétaire (rejets `auth_failed`, `no_passcode`, `denied`, `not_home`) ; `{on: false}` sans authentification. */
  setKnock?(o: { on: boolean }): Promise<NodeStatus>;
}

export function nodePlugin(w: unknown = globalThis): NodePlugin | undefined {
  return isNativeShell(w) ? (w as { Capacitor?: { Plugins?: { NokkerNode?: NodePlugin } } }).Capacitor?.Plugins?.NokkerNode : undefined;
}

export type EnrollStep =
  | { kind: "waiting"; approvalId: string; fingerprint: string; expiresAt: string }
  | { kind: "done"; status: NodeStatus }
  | { kind: "failed"; code: "rejected" | "expired" | "not_available" | "too_many" | "key" | "network" };

const codeOf = (e: unknown): string | undefined => (e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined);

/**
 * Inscription complète : clé → `POST /v1/link/phone` → attente de la carte (sondage toutes les `everyMs`) → jeton au
 * plugin → démarrage. `onStep` reçoit l'attente (avec l'empreinte à comparer sur l'autre appareil), puis l'issue.
 */
export async function enrollPhone(
  client: Pick<NokkerClient, "registerPhone" | "phoneRegistration">,
  plugin: NodePlugin,
  o: { name: string; baseUrl: string; appVersion: string; osVersion: string; onStep: (s: EnrollStep) => void; everyMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Promise<EnrollStep> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = (s: EnrollStep): EnrollStep => (o.onStep(s), s);
  let key;
  try {
    key = await plugin.prepareKey();
  } catch {
    return end({ kind: "failed", code: "key" });
  }
  let reg;
  try {
    reg = await client.registerPhone({
      name: o.name.slice(0, 40),
      platform: nativePlatform() === "android" ? "android" : "ios",
      os_version: o.osVersion.slice(0, 20),
      app_version: o.appVersion.slice(0, 20),
      public_key_spki: key.public_key_spki,
      enc_key_spki: key.enc_key_spki,
      key_storage: key.key_storage,
      attestation: null,
      push_token: null,
    });
  } catch (e) {
    const c = codeOf(e);
    if (c === "attestation_required" || (e instanceof NokkerApiError && e.status === 404)) return end({ kind: "failed", code: "not_available" });
    if (c === "too_many_phones") return end({ kind: "failed", code: "too_many" });
    return end({ kind: "failed", code: "network" });
  }
  o.onStep({ kind: "waiting", approvalId: reg.approval_id, fingerprint: reg.key_fingerprint, expiresAt: reg.expires_at });
  const deadline = Date.parse(reg.expires_at) || Date.now() + 10 * 60_000;
  while (!o.signal?.aborted && Date.now() < deadline) {
    await sleep(o.everyMs ?? 2000);
    let r;
    try {
      r = await client.phoneRegistration(reg.approval_id);
    } catch (e) {
      const c = codeOf(e);
      if (c === "rejected") return end({ kind: "failed", code: "rejected" });
      if (c === "gone") return end({ kind: "failed", code: "expired" });
      continue; // coupure passagère : on resonde
    }
    if ("sealed_token" in r) {
      const got = r as PhoneRegistered;
      try {
        await plugin.enroll({ machine_id: got.machine_id, approval_id: reg.approval_id, sealed_token: got.sealed_token, base_url: o.baseUrl });
      } catch {
        return end({ kind: "failed", code: "key" }); // sceau illisible pour cette clé : on recommence l'inscription
      }
      return end({ kind: "done", status: await plugin.start() });
    }
  }
  return end({ kind: "failed", code: "expired" });
}

/** Retirer ce téléphone : révocation chez le noyau (le jeton ne vaut plus rien), puis oubli local de la clé et du jeton.
 * Un 404 (déjà révoqué ailleurs) n'empêche pas l'oubli local. */
export async function removePhone(client: Pick<NokkerClient, "revokeMachine">, plugin: NodePlugin, machineId: string | undefined): Promise<NodeStatus> {
  if (machineId) await client.revokeMachine(machineId).catch((e) => (e instanceof NokkerApiError && e.status === 404 ? undefined : Promise.reject(e)));
  return plugin.forget();
}

/** Âge du dernier battement, en minutes (arrondi), ou null. */
export const beatMinutes = (s: Pick<NodeStatus, "last_beat_at">, now = Date.now()): number | null => (s.last_beat_at ? Math.max(0, Math.round((now - Date.parse(s.last_beat_at)) / 60_000)) : null);
