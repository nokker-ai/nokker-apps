/**
 * Mode « nœud maison » du téléphone (LOKKAL-PHONE §4.4, lot P10a ; contrat validé par dev le 06.11).
 *
 * Un vieux téléphone ou une tablette, branché, sur le Wi-Fi de la maison, app au premier plan : il relaie Home Assistant
 * sur le LAN avec les opérations nommées de `home-bridge` (`HaOp`). HA n'est pas exposé à Internet ; c'est le nœud qui
 * sort vers nokker.ai. Le nœud appartient au membre qui l'a inscrit (partage foyer : lot à part, carte révocable).
 *
 * Règles de l'appareil (la politique et les cartes restent dans le noyau) :
 *  - battement `mode: "home"` quand le réglage est allumé ; `caps.lan_home = "on"` seulement si HA est configuré ET
 *    que le Wi-Fi courant est celui déclaré « maison » (`home_wifi`) ; sinon `off` ;
 *  - URL de HA PRIVÉE seulement (RFC 1918, lien local, ULA, `.local`), résolue une fois puis épinglée ;
 *  - jeton HA (compte NON administrateur) saisi dans un champ NATIF, gardé dans le trousseau (ThisDeviceOnly) : il ne
 *    passe jamais dans la WebView et ne sort jamais de l'appareil ;
 *  - entités : liste de motifs choisie dans l'app, VIDE par défaut (rien n'est lu ni touché) ;
 *  - aucune coordonnée ne quitte le téléphone : `latitude`, `longitude`, `gps_accuracy` retirés des entités `person`,
 *    `device_tracker` et `zone` avant l'envoi ;
 *  - l'app n'envoie que des CODES d'échec ; les phrases sont dans le noyau (REASONS).
 */

import type { CameraStatus } from "./camera.js";
import { HA_WRITE_OPS, type HaOp } from "./node.js";

/** Codes d'échec du relais HA rendus par le natif (`error.code`). */
export type HaError =
  | "not_home_wifi"
  | "ha_not_configured"
  | "ha_unreachable"
  | "ha_auth_failed"
  | "entity_not_allowed"
  | "service_not_allowed"
  | "ha_error"
  | "bad_args";

export const HA_ENTITY_PATTERNS_MAX = 100;
export const HA_TARGETS_MAX = 10;
export const HA_EVENTS_TIMEOUT_MAX_S = 20;
/** Historique et journal : au plus 7 jours (MAX_HISTORY_H de `home-bridge`). */
export const HA_HISTORY_MAX_H = 24 * 7;
/** Clés de cible interdites dans `data` (même règle que `home-bridge` : la cible passe par `entity_ids` seulement). */
export const HA_TARGET_KEYS: ReadonlySet<string> = new Set(["entity_id", "area_id", "device_id", "floor_id", "label_id"]);
/** Services à réponse permis à `ha.query` (QUERY_SERVICES de `home-bridge`). */
export const HA_QUERY_SERVICES: ReadonlySet<string> = new Set(["weather.get_forecasts", "calendar.get_events", "todo.get_items", "media_player.search_media", "music_assistant.search", "music_assistant.get_queue"]);
/** Services d'intégration dont la cible est d'un autre domaine (TARGET_DOMAIN de `home-bridge`). */
export const HA_TARGET_DOMAIN: Readonly<Record<string, string>> = { music_assistant: "media_player" };
/** Clés de `data` qui désignent d'autres entités : chacune dans la liste et du domaine indiqué (ENTITY_REF_KEYS). */
export const HA_ENTITY_REF_KEYS: Readonly<Record<string, string>> = { group_members: "media_player", media_player_entity_id: "media_player", source_player: "media_player" };
/** Domaines dont les coordonnées sont retirées sur l'appareil. */
export const HA_COORD_DOMAINS: ReadonlySet<string> = new Set(["person", "device_tracker", "zone"]);
export const HA_COORD_ATTRS: readonly string[] = ["latitude", "longitude", "gps_accuracy"];

/** État du mode maison tel que le natif le rend à la WebView (jamais le jeton). */
export interface HomeNodeStatus {
  on: boolean;
  ha_url: string | null;
  ha_token_set: boolean;
  entities: string[];
  /** Un Wi-Fi « maison » a été déclaré sur cet appareil (empreinte salée du BSSID ; le BSSID ne sort jamais). */
  home_wifi_set: boolean;
  /** Le Wi-Fi courant est celui déclaré (lu par l'OS ; faux sans l'autorisation ou l'entitlement). */
  home_wifi: boolean;
  /** Dernier contrôle de HA : ok, ou un code `HaError`. */
  ha_check: "ok" | HaError | null;
  /** `caps.lan_home` tel qu'envoyé au battement. */
  lan_home: "on" | "off";
  /** P10c : caméra de veille de cet appareil. */
  camera?: CameraStatus;
}

/** Motif d'entité : `domaine.objet` avec `*` et `?` (même syntaxe que `fnmatchcase` de `home-bridge`). */
export function normalizeEntityPattern(raw: string): string | null {
  const p = raw.trim().toLowerCase();
  if (!/^[a-z_*?][a-z0-9_*?]*\.[a-z0-9_*?]+$/.test(p) || p === "*.*") return null;
  return p;
}

const globRe = (p: string): RegExp => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export function entityAllowed(entityId: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globRe(p).test(entityId));
}

/** Retire les coordonnées d'un état HA (`{entity_id, state, attributes}`) des domaines `person`, `device_tracker`, `zone`. */
export function stripCoordinates<T extends { entity_id?: unknown; attributes?: unknown }>(s: T): T {
  const id = String(s.entity_id ?? "");
  if (!HA_COORD_DOMAINS.has(id.split(".", 1)[0]!) || !s.attributes || typeof s.attributes !== "object") return s;
  const attributes = { ...(s.attributes as Record<string, unknown>) };
  for (const k of HA_COORD_ATTRS) delete attributes[k];
  return { ...s, attributes };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Adresse IPv4 du foyer : RFC 1918 ou lien local (jamais publique, jamais CGNAT, jamais boucle locale). */
export function privateIPv4(ip: string): boolean {
  const m = IPV4.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((x) => x > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** IPv6 du foyer : ULA (fc00::/7) ou lien local (fe80::/10). */
export function privateIPv6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

/**
 * URL de Home Assistant acceptable sur l'appareil : http(s), hôte `.local` ou adresse privée, port quelconque, sans
 * identifiants ni chemin au-delà de `/`. Rend l'URL de base normalisée, ou un code. Le natif revérifie l'adresse RÉSOLUE
 * (un `.local` qui résout vers une adresse publique est refusé) et s'y épingle.
 */
export function haUrlCheck(raw: string): { url: string } | { error: "bad_args" | "ha_unreachable" } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "bad_args" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "bad_args" };
  if (u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) return { error: "bad_args" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ok = privateIPv4(host) || (u.hostname.startsWith("[") && privateIPv6(host)) || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(host);
  if (!ok) return { error: "ha_unreachable" };
  return { url: `${u.protocol}//${u.host}` };
}

/** `ha.events {after, timeout}` : `timeout` borné à 20 s (une tâche de la file). Même forme que `home-bridge` : chaque
 * événement `state_changed` d'une entité permise, numéroté ; `after < 0` rend le curseur sans événement. */
export interface HaEventsArgs {
  after: number;
  timeout?: number;
}
export interface HaStateChanged {
  seq: number;
  event: { event_type: "state_changed"; time_fired?: string; data: { entity_id: string; old_state: Record<string, unknown> | null; new_state: Record<string, unknown> | null } };
}
export interface HaEventsResult {
  cursor: number;
  events: HaStateChanged[];
}

/** Cibles d'un appel (`_targets` de `home-bridge`) : 1 à 10 entités permises, du domaine du service (ou de son
 * domaine cible), aucune cible dans `data`, références d'entités de `data` permises et du bon domaine. */
export function haTargetsCheck(p: { domain?: unknown; service?: unknown; entity_ids?: unknown; data?: unknown }, patterns: readonly string[]): { ok: true } | { error: "bad_args" | "entity_not_allowed" } {
  const domain = String(p.domain ?? ""), service = String(p.service ?? "");
  const ids = p.entity_ids, data = (p.data ?? {}) as Record<string, unknown>;
  if (!domain || !service || !Array.isArray(ids) || !ids.length || ids.length > HA_TARGETS_MAX || typeof data !== "object" || Array.isArray(data)) return { error: "bad_args" };
  if (Object.keys(data).some((k) => HA_TARGET_KEYS.has(k))) return { error: "entity_not_allowed" };
  const tdom = HA_TARGET_DOMAIN[domain] ?? domain;
  const bad = ids.map(String).filter((e) => !entityAllowed(e, patterns) || e.split(".", 1)[0] !== tdom);
  for (const [key, refDomain] of Object.entries(HA_ENTITY_REF_KEYS)) {
    if (!(key in data)) continue;
    const refs = Array.isArray(data[key]) ? (data[key] as unknown[]) : [data[key]];
    bad.push(...refs.map(String).filter((r) => !entityAllowed(r, patterns) || r.split(".", 1)[0] !== refDomain));
  }
  return bad.length ? { error: "entity_not_allowed" } : { ok: true };
}

/** Opérations du relais qui ne font que lire (permises à un nœud non attesté). */
export const haReadOp = (op: HaOp): boolean => !HA_WRITE_OPS.has(op);
