/**
 * Liste unique des sessions : cloud (app.nokker.ai) + chaque machine Lokkal liée (nokker docs/LOKKAL-PHONE.md §1.2).
 * Fonctions pures : fusion des origines, routes `#/t/<origine>/<fil>`, filtre, recherche fusionnée.
 *
 * Le contenu d'une session Lokkal reste sur sa machine : le client parle à chaque machine EN LIGNE par sa passerelle
 * (`https://<nom>.nokker.app/v1/*`, jeton de `POST /v1/gateway/token {host}`) ; une machine HORS LIGNE n'est connue
 * que par son deck v2 (titres sous la règle du miroir, états, âge).
 */
import type { DeckMachine, DeckThread, Thread, ThreadSearchResult } from "@nokker-apps/sdk";

export const CLOUD = "cloud";

export interface OriginInfo {
  /** `cloud` ou l'id de la machine (`mc_…`). */
  id: string;
  name: string;
  host: string | null;
  online: boolean;
  /** Âge du deck en secondes (machine hors ligne : « hors ligne depuis 12 min »). */
  ageS: number | null;
  mirror: boolean;
}

export interface UnifiedRow {
  origin: string;
  originName: string;
  id: string;
  title: string | null;
  updated_at: string;
  state: DeckThread["state"] | null;
  channel: string | null;
  snippet: string | null;
  /** Machine éteinte : grisé ; s'ouvre en copie du miroir si elle existe, sinon titre et état seulement. */
  offline: boolean;
  thread: Thread | null;
}

/** Copie en miroir d'un fil Lokkal chez nokker.ai (§6.3) : `lokkal-<machine>-<fil>`. */
const MIRROR = /^lokkal-(mc_[A-Za-z0-9_-]+?)-(.+)$/;
export function mirrorOf(cloudThreadId: string): { machine: string; thread: string } | null {
  const m = MIRROR.exec(cloudThreadId);
  return m ? { machine: m[1]!, thread: m[2]! } : null;
}

/**
 * Horodatage comparable (ISO 8601) quel que soit ce qu'envoie une machine : chaîne gardée telle quelle, nombre lu en
 * secondes ou millisecondes, tout le reste → "". Une machine en erreur ne doit JAMAIS faire tomber la liste (bug de
 * prod 47.1 : `localeCompare` sur une valeur qui n'était pas une chaîne → écran blanc).
 */
export function timeKey(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  return "";
}

/** Tri du plus récent au plus ancien, sans jamais lever. */
export const byNewest = <T>(key: (x: T) => unknown) => (a: T, b: T): number => timeKey(key(b)).localeCompare(timeKey(key(a)));

export function originsOf(machines: DeckMachine[]): OriginInfo[] {
  return machines.map((m) => ({ id: m.machine_id, name: m.name, host: m.host || null, online: m.online, ageS: m.deck_age_s, mirror: m.mirror === true }));
}

/**
 * Les fils de toutes les origines, du plus récent au plus ancien. Une machine en ligne dont la liste a été lue (`live`)
 * donne ses fils réels ; sinon (éteinte, ou pas encore lue) ceux de son deck. La copie en miroir d'un fil d'une machine
 * listée n'apparaît pas une seconde fois dans le cloud.
 */
export function unifiedRows(cloud: Thread[], machines: DeckMachine[], live: Record<string, Thread[] | undefined>): UnifiedRow[] {
  const listed = new Set(machines.map((m) => m.machine_id));
  const rows: UnifiedRow[] = cloud
    .filter((t) => {
      const mir = mirrorOf(t.id);
      return !(mir && listed.has(mir.machine));
    })
    .map((t) => ({ origin: CLOUD, originName: CLOUD, id: t.id, title: t.title, updated_at: timeKey(t.updated_at), state: t.working ? "working" : "idle", channel: null, snippet: t.last_snippet ?? null, offline: false, thread: t }));
  for (const m of machines) {
    // Une machine dont la réponse est inattendue est ignorée (ses fils), jamais la liste entière.
    try {
      const real = m.online ? live[m.machine_id] : undefined;
      if (Array.isArray(real)) {
        for (const t of real) if (t && t.id) rows.push({ origin: m.machine_id, originName: String(m.name ?? ""), id: t.id, title: t.title ?? null, updated_at: timeKey(t.updated_at), state: t.working ? "working" : "idle", channel: null, snippet: t.last_snippet ?? null, offline: false, thread: t });
      } else {
        for (const t of Array.isArray(m.threads) ? m.threads : [])
          if (t && t.thread_id) rows.push({ origin: m.machine_id, originName: String(m.name ?? ""), id: t.thread_id, title: t.title ?? null, updated_at: timeKey(t.updated_at), state: t.state, channel: t.channel, snippet: null, offline: !m.online, thread: null });
      }
    } catch {
      /* machine ignorée */
    }
  }
  return rows.sort(byNewest((r) => r.updated_at));
}

/** Filtre d'origine en tête du tiroir : `all`, `cloud` ou une machine. */
export const filterRows = (rows: UnifiedRow[], origin: string): UnifiedRow[] => (origin === "all" ? rows : rows.filter((r) => r.origin === origin));

/** Route d'un fil : `#/t/<fil>` (cloud, ancien lien) ou `#/t/<mc_…>/<fil>` ; `#/t/<fil>/b/<bulle>` garde sa bulle. */
export function parseThreadRoute(hash: string): { origin: string; id: string; bubble?: string } | null {
  const m = /^#\/t\/([^/]+)(?:\/([^/]+))?(?:\/b\/([^/]+))?/.exec(hash);
  if (!m) return null;
  const [, a, b, bubble] = m;
  if (a!.startsWith("mc_") && b && b !== "b") return { origin: a!, id: decodeURIComponent(b), ...(bubble ? { bubble } : {}) };
  const legacyBubble = b === "b" ? undefined : bubble;
  const bub = /\/b\/([^/]+)/.exec(hash)?.[1] ?? legacyBubble;
  return { origin: CLOUD, id: decodeURIComponent(a!), ...(bub ? { bubble: bub } : {}) };
}

export const threadRoute = (origin: string, id: string): string => (origin === CLOUD ? `#/t/${encodeURIComponent(id)}` : `#/t/${origin}/${encodeURIComponent(id)}`);

/** Base de la passerelle d'une machine : https ; http seulement pour une machine locale de recette (127.0.0.1, localhost). */
export function machineBase(host: string): string {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ? `http://${host}` : `https://${host}`;
}

/** Âge d'une machine éteinte, en minutes (arrondi), ou null si inconnu. */
export const offlineMinutes = (o: Pick<OriginInfo, "ageS">): number | null => (o.ageS === null ? null : Math.max(1, Math.round(o.ageS / 60)));

export interface OriginSearch {
  origin: string;
  name: string;
  results?: ThreadSearchResult[];
  /** Pas de réponse dans le délai (3 s), ou erreur. */
  failed?: boolean;
}

export interface SearchRow extends ThreadSearchResult {
  origin: string;
  originName: string;
}

/** Recherche fusionnée : par date, et la liste des origines qui n'ont pas répondu (« atelier n'a pas répondu »). Une copie
 * en miroir trouvée dans le cloud (`copy_of`) est rendue à SA machine, et une seule fois si la machine l'a trouvée aussi. */
export function mergeSearch(parts: OriginSearch[], names: Record<string, string> = {}): { rows: SearchRow[]; silent: string[] } {
  const all = parts.flatMap((p) =>
    (p.results ?? []).map((r) =>
      r.copy_of
        ? { ...r, thread_id: r.copy_of.thread_id, origin: r.copy_of.machine_id, originName: names[r.copy_of.machine_id] ?? p.name }
        : { ...r, origin: p.origin, originName: p.name },
    ),
  );
  all.sort(byNewest((r) => r.at));
  const seen = new Set<string>();
  const rows = all.filter((r) => {
    const k = `${r.origin}/${r.thread_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { rows, silent: parts.filter((p) => p.failed).map((p) => p.name) };
}

/** Machines éteintes : on cherche seulement dans les titres de leur deck (le contenu n'est pas chez nokker.ai). */
export function searchOfflineTitles(q: string, machines: DeckMachine[]): OriginSearch[] {
  const needle = q.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return machines
    .filter((m) => !m.online)
    .map((m) => ({
      origin: m.machine_id,
      name: m.name,
      results: (m.threads ?? [])
        .filter((t) => t.title && norm(t.title).includes(needle))
        .map((t) => ({ thread_id: t.thread_id, title: t.title, snippet: "", turn_index: null, at: t.updated_at, channel: t.channel })),
    }));
}

/** Coupe une promesse après `ms` : la recherche d'une origine lente ne bloque pas les autres. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        ok(v);
      },
      (e) => {
        clearTimeout(t);
        ko(e);
      },
    );
  });
}
