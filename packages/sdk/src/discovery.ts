/**
 * Découverte du réseau local par le nœud maison (LOKKAL-PHONE §4.4, lot P10d ; contrat validé par dev le 06.11).
 *
 * - Le nœud n'ANNONCE rien sur le LAN (aucun service Bonjour ; l'écoute :8802 de la caméra n'est ouverte que pendant
 *   qu'une vignette attend, et ne s'annonce pas).
 * - `lan.discover {types?, timeout_s ≤ 5}` → `{services: [{id, type, types, name}], at}` : liste FERMÉE de types
 *   (écrans, enceintes, Home Assistant ; jamais téléphones ni ordinateurs personnels), ni IP, ni port, ni TXT. Sur
 *   l'appareil : instances dont le TXT `model`/`am` commence par Mac, iPhone, iPad, iPod ÉCARTÉES (« MacBook de
 *   Marie ») ; préfixe matériel `XXXXXXXXXXXX@` des noms RAOP retiré ; dédoublonnage par nom (une entrée, ses types).
 *   `id` = sha256(sel du nœud ‖ type ‖ nom) tronqué : stable pour CE nœud, ne relie rien d'un nœud à l'autre.
 * - Route du titulaire (noyau, contrat d'onboarding) : GET /v1/link/phone/{machine_id}/lan/services?types=a,b →
 *   {services: [{id, types, name}], at} ; 409 node_offline, 504 phone_timeout, 400 bad_op, 502 {code} ; no-store.
 * - « Trouver Home Assistant » (`_home-assistant._tcp`) : SUR l'appareil seulement ; l'adresse ne sort pas, préremplit
 *   le champ et repasse par `haUrlCheck`/`normalizeBase` puis l'épinglage de P10a.
 */

export const DISCOVERY_TYPES = ["_googlecast._tcp", "_airplay._tcp", "_raop._tcp", "_home-assistant._tcp", "_spotify-connect._tcp", "_sonos._tcp"] as const;
export type DiscoveryType = (typeof DISCOVERY_TYPES)[number];
export const DISCOVERY_MAX = 50;
export const DISCOVERY_TIMEOUT_MAX_S = 5;

export interface DiscoveredService {
  id: string;
  /** Premier type vu ; `types` : tous les types annoncés sous ce nom. */
  type: DiscoveryType;
  types: DiscoveryType[];
  /** Nom d'instance Bonjour (≤ 63) : texte de tiers. */
  name: string;
}
export interface LanDiscoverArgs {
  types?: DiscoveryType[];
  timeout_s?: number;
}
export interface LanDiscoverResult {
  services: DiscoveredService[];
  at: string;
}
export type DiscoveryError = "not_home_wifi" | "local_network_denied" | "bad_args";

/** Candidat Home Assistant trouvé sur l'appareil (l'adresse reste sur l'appareil). */
export interface HaCandidate {
  name: string;
  url: string;
}

const PERSONAL = /^(mac|iphone|ipad|ipod)/i;

/** Règles de l'appareil, en référence (le natif fait de même) : rend les services gardés, dans l'ordre vu. */
export function filterDiscovered(raw: { type: string; name: string; txt?: Record<string, string> }[], idOf: (type: string, name: string) => string): DiscoveredService[] {
  const out: DiscoveredService[] = [];
  for (const r of raw) {
    if (!(DISCOVERY_TYPES as readonly string[]).includes(r.type)) continue;
    const model = r.txt?.model ?? r.txt?.am ?? "";
    if (PERSONAL.test(model)) continue; // ordinateurs et téléphones personnels : jamais
    const name = (r.type === "_raop._tcp" ? r.name.replace(/^[0-9A-Fa-f]{12}@/, "") : r.name).slice(0, 63);
    if (!name.trim()) continue;
    const prev = out.find((s) => s.name === name);
    if (prev) {
      if (!prev.types.includes(r.type as DiscoveryType)) prev.types.push(r.type as DiscoveryType);
      continue;
    }
    if (out.length >= DISCOVERY_MAX) break;
    out.push({ id: idOf(r.type, name), type: r.type as DiscoveryType, types: [r.type as DiscoveryType], name });
  }
  return out;
}
