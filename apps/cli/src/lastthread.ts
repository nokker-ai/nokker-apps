/**
 * Dernier fil de session locale par (serveur, dossier), gardé par la CLI dans `~/.config/nokker/local-threads.json` (0600).
 *
 * Pourquoi : la liste `GET /v1/local/sessions` du noyau vit en mémoire ; après un redémarrage du noyau (update, reboot,
 * restore) elle est vide et la CLI ouvrait un fil NEUF dans le même dossier, alors que l'ancien fil existe toujours. La CLI
 * se souvient donc du dernier fil de chaque dossier et le redemande à l'ouverture (`POST /v1/local/sessions {cwd, thread_id}`).
 * Le noyau persistera ce lien lui-même plus tard ; ce fichier n'est alors qu'un repli.
 *
 * Aucune erreur de lecture ou d'écriture ne remonte : un fichier illisible = rien de mémorisé.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config.js";

export interface LastThreadStore {
  get(cwd: string): string | null;
  set(cwd: string, threadId: string): void;
}

/** Entrées gardées au plus (les plus récentes). */
export const LAST_THREADS_MAX = 200;

interface FileShape {
  version: 1;
  entries: Record<string, { thread_id: string; at: string }>;
}

export function lastThreadsPath(): string {
  return join(configDir(), "local-threads.json");
}

function key(server: string, cwd: string): string {
  return `${server.replace(/\/+$/, "")}|${cwd}`;
}

function read(path: string): FileShape {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FileShape>;
    if (raw && raw.version === 1 && raw.entries && typeof raw.entries === "object") return { version: 1, entries: raw.entries };
  } catch {
    // absent ou illisible : vide
  }
  return { version: 1, entries: {} };
}

export function fileLastThreadStore(server: string, path: string = lastThreadsPath(), now: () => Date = () => new Date()): LastThreadStore {
  return {
    get(cwd) {
      const e = read(path).entries[key(server, cwd)];
      return e && typeof e.thread_id === "string" && /^th_[A-Za-z0-9_-]+$/.test(e.thread_id) ? e.thread_id : null;
    },
    set(cwd, threadId) {
      try {
        const data = read(path);
        data.entries[key(server, cwd)] = { thread_id: threadId, at: now().toISOString() };
        const kept = Object.entries(data.entries)
          .sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0))
          .slice(0, LAST_THREADS_MAX);
        data.entries = Object.fromEntries(kept);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n", { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
      } catch {
        // dossier de config en lecture seule : la reprise retombera sur la liste du noyau
      }
    },
  };
}
