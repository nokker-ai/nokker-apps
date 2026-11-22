/**
 * Cache hors ligne EN LECTURE SEULE (LOKKAL-PHONE §1.1 W6) : la liste des fils, les derniers fils ouverts (messages et
 * bulles, cartes en attente comprises) gardés dans l'appareil, pour les relire sans réseau avec leur âge
 * (« copie d'il y a 12 min »). Rien n'est écrit hors ligne : un message tapé reste un brouillon du composeur, envoyé
 * seulement par un geste quand la connexion revient. Effacé à « Se déconnecter », à l'oubli de l'appareil et à la
 * suppression du compte.
 * Base IndexedDB à part (`nokker-offline`) ; dans l'app native, chiffrée par une clé de l'appareil au lot P3.
 * Chaque accès est protégé : sans IndexedDB (navigation privée, aperçu), rien n'est gardé et rien ne casse.
 */
import type { Thread } from "@nokker-apps/sdk";

const DB = "nokker-offline";
const STORE = "cache";
/** Fils dont le contenu est gardé (les plus récemment ouverts), et messages gardés par fil. */
export const KEEP_THREADS = 5;
export const KEEP_MESSAGES = 200;

export interface CachedView<V> {
  at: number;
  view: V;
}

function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((ok) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => ok(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => {
            open.result.close();
            ok(req ? (req.result as T) : undefined);
          };
          tx.onerror = tx.onabort = () => {
            open.result.close();
            ok(undefined);
          };
        } catch {
          ok(undefined);
        }
      };
    } catch {
      ok(undefined);
    }
  });
}

const put = (key: string, value: unknown) => withStore("readwrite", (s) => void s.put(value, key));
const get = <T>(key: string) => withStore<T>("readonly", (s) => s.get(key) as IDBRequest<T>);

/** Garde les `n` derniers messages d'une vue de fil (elle reste lisible, et la base petite). */
export function trimView<V extends { messages?: unknown[] }>(view: V, n = KEEP_MESSAGES): V {
  return Array.isArray(view.messages) && view.messages.length > n ? { ...view, messages: view.messages.slice(-n) } : view;
}

/** Ordre des fils gardés : le dernier ouvert en tête, au plus `KEEP_THREADS` ; rend aussi ceux qui sortent. */
export function bumpRecent(order: string[], id: string, keep = KEEP_THREADS): { order: string[]; dropped: string[] } {
  const next = [id, ...order.filter((x) => x !== id)];
  return { order: next.slice(0, keep), dropped: next.slice(keep) };
}

export async function saveThreads(list: Thread[], now = Date.now()): Promise<void> {
  await put("threads", { at: now, view: list } satisfies CachedView<Thread[]>);
}

export function loadThreads(): Promise<CachedView<Thread[]> | undefined> {
  return get<CachedView<Thread[]>>("threads");
}

export async function saveThread<V extends { messages?: unknown[] }>(id: string, view: V, now = Date.now()): Promise<void> {
  const { order, dropped } = bumpRecent((await get<string[]>("recent")) ?? [], id);
  await withStore("readwrite", (s) => {
    s.put({ at: now, view: trimView(view) }, `thread:${id}`);
    s.put(order, "recent");
    for (const d of dropped) s.delete(`thread:${d}`);
  });
}

export function loadThread<V>(id: string): Promise<CachedView<V> | undefined> {
  return get<CachedView<V>>(`thread:${id}`);
}

/** Tout effacer (déconnexion, appareil oublié, compte supprimé). */
export async function clearOffline(): Promise<void> {
  await withStore("readwrite", (s) => void s.clear());
}

/** Erreur de RÉSEAU (pas une réponse du serveur) : on peut alors montrer la copie gardée. */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const st = (err as { status?: unknown } | null)?.status;
  return st === 502 || st === 503 || st === 504;
}

/** « il y a 12 min » / « 12 min ago » : l'âge d'une copie, arrondi pour une personne. */
export function ageMinutes(at: number, now = Date.now()): number {
  return Math.max(0, Math.round((now - at) / 60_000));
}
