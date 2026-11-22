/**
 * Pages ouvertes par la connexion du téléphone (LOKKAL-PHONE §4.5, lot P11 ; contrat accepté par dev le 06.11).
 * Opération `fetch.get` de la file du nœud (P7), capacité `egress`, COUPÉE par défaut. Deux déclenchements seulement :
 *  (a) l'hôte est dans la liste de la personne (`PUT /v1/me/egress/hosts`), pendant un tour qu'elle a ouvert ;
 *  (b) un GESTE de la personne : la réponse d'un `web_fetch` refusé (403, 451, CAPTCHA, blocage) porte une offre
 *      (`ThreadMessage.phone_fetch_offers`) ; le bouton « Ouvrir par mon téléphone » appelle
 *      `POST /v1/threads/{id}/phone-fetch {url, call_id}`, le noyau crée un tour de la personne (origin `phone_fetch`)
 *      avec un droit SIGNÉ par lui (`phone_fetch_grant {url, turn_id}`, usage unique, 10 min) : seul ce droit permet le
 *      fetch explicite. Le modèle ne choisit jamais le téléphone (aucun champ dans le schéma de `web_fetch`).
 * Jamais pour un agent, une tâche planifiée, un tour de continuation ; jamais en repli automatique après un refus.
 * Garde sur l'appareil : https:443, résolution entière publique (IPv4 encapsulées revérifiées), connexion épinglée à
 * l'IP vérifiée, TLS au nom de l'hôte, HTTP/1.1 sans cookies, 5 redirections revérifiées, 3 Mo, 8 s, texte seulement.
 */

export const EGRESS_MAX_HOSTS = 50;
export const FETCH_RESULT_MAX = 1024 * 1024;
export const FETCH_TEXT_MAX = 768 * 1024;
export const FETCH_PER_HOUR = 30;
export const EGRESS_CELL_CAP_MB = 100;

export interface EgressHosts {
  hosts: string[];
}

export interface FetchGetArgs {
  url: string;
  trigger: "allowlist" | "explicit";
  turn_id: string;
  /** Mode `allowlist` : la liste de la personne, pour revérifier chaque redirection sur l'appareil. */
  allow_hosts?: string[];
  /** Mode `explicit` : id du droit signé par le noyau (le natif ne le vérifie pas, il le recopie dans son résultat). */
  grant_id?: string;
}

export interface FetchGetResult {
  status: number;
  final_url: string;
  content_type: string;
  charset: string | null;
  text: string;
  bytes: number;
  truncated: boolean;
  hops: number;
}

export type FetchGetError =
  | "blocked_address"
  | "dns_failed"
  | "tls_failed"
  | "timeout"
  | "too_large"
  | "unsupported_type"
  | "too_many_redirects"
  | "redirect_not_allowed"
  | "scheme_not_allowed"
  | "port_not_allowed"
  | "host_not_allowed"
  | "egress_off"
  | "metered_cap"
  | "constrained"
  | "no_network"
  | "cellular_off"
  | "low_battery"
  | "rate"
  | "grant_invalid"
  | "phone_timeout";

/** Offre portée par la réponse d'un `web_fetch` refusé, quand la personne a un téléphone dont `egress` est allumé. */
export interface PhoneFetchOffer {
  call_id: string;
  url: string;
  host: string;
  reason: "http_403" | "http_451" | "captcha" | "blocked";
}

/** Page ouverte par le téléphone pendant le tour : la bulle dit « page ouverte par ton téléphone (hôte) ». */
export interface PhoneFetched {
  host: string;
  ok: boolean;
  status?: number;
  error?: FetchGetError | (string & {});
}

const BANNED_SUFFIX = /(^|\.)(local|lan|home\.arpa|internal|localhost|intranet|corp|home)$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Règle d'hôte de la liste : `exemple.ch` (exact) ou `*.exemple.ch` (ses sous-domaines, pas lui-même). Minuscules,
 * au moins deux étiquettes, ni IP, ni joker nu, ni suffixe local. Rend la règle normalisée, ou null.
 */
export function normalizeEgressHost(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, "");
  const wild = h.startsWith("*.");
  const name = wild ? h.slice(2) : h;
  if (!name || name.length > 253 || name.includes("*") || IPV4.test(name) || name.includes(":") || name.includes("/")) return null;
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (BANNED_SUFFIX.test(name)) return null;
  return wild ? `*.${name}` : name;
}

/** L'hôte est-il couvert par la liste ? `*.exemple.ch` couvre `a.exemple.ch`, pas `exemple.ch`. */
export function hostAllowed(host: string, rules: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return rules.some((r) => (r.startsWith("*.") ? h.endsWith(r.slice(1)) && h.length > r.length - 1 : h === r));
}

/** Hôte d'une URL https:443 acceptable pour `fetch.get`, ou un code de refus (même règle que l'appareil). */
export function fetchUrlCheck(url: string): { host: string } | { error: FetchGetError } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: "scheme_not_allowed" };
  }
  if (u.protocol !== "https:") return { error: "scheme_not_allowed" };
  if (u.port && u.port !== "443") return { error: "port_not_allowed" };
  if (u.username || u.password) return { error: "host_not_allowed" };
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[") || IPV4.test(host) || normalizeEgressHost(host) === null) return { error: "host_not_allowed" };
  return { host };
}
