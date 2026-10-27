/**
 * Sessions de code du web servi par Lokkal (auth `local` ou passerelle `gateway`) : `GET /v1/local/sessions` (sessions et
 * racines), `POST /v1/local/sessions {cwd}`. Une session sans tour n'est pas encore un fil du hub (`GET /v1/threads`) :
 * on la fusionne dans la liste, titrée par son dossier. Fonctions pures.
 */
import { NokkerApiError, type LocalSessionSummary, type Thread } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

/** Dernier segment d'un chemin (« /home/alice/projets/site » → « site »). */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

/** Dossier choisi : racine + sous-dossier libre. `null` si le sous-dossier sort de la racine (« .. », chemin absolu). */
export function joinUnderRoot(root: string, sub: string): string | null {
  const segs = sub.split(/[\\/]+/).filter(Boolean);
  if (sub.trim().startsWith("/") || segs.some((s) => s === ".." || s === ".")) return null;
  const base = root.replace(/[\\/]+$/, "") || "/";
  return segs.length ? `${base === "/" ? "" : base}/${segs.join("/")}` : base;
}

/** Fils du hub + sessions locales encore inconnues de lui (aucun tour) : fil minimal titré par le dossier. */
export function mergeLocalSessions(threads: Thread[], sessions: LocalSessionSummary[], user: string, nowIso: string): Thread[] {
  const known = new Set(threads.map((t) => t.id));
  const extra = sessions
    .filter((s) => !known.has(s.thread_id))
    .map<Thread>((s) => ({
      id: s.thread_id,
      title: s.title || folderName(s.cwd),
      owner: user,
      members: [user],
      created_at: s.last_turn_at ?? nowIso,
      updated_at: s.last_turn_at ?? nowIso,
      working: !!s.working,
      unread: 0,
      bubble_count: 0,
      last_snippet: "",
    }));
  return [...threads, ...extra];
}

/** `thread_id` → dossier de chaque session de code. */
export const cwdByThread = (sessions: LocalSessionSummary[]): Record<string, string> => Object.fromEntries(sessions.map((s) => [s.thread_id, s.cwd]));

/** Refus d'ouverture : 403 = hors racine ou dossier absent (le noyau ne distingue pas) ; sinon le message du serveur. */
export function openSessionError(e: unknown): string {
  if (e instanceof NokkerApiError && e.status === 403) return tr("This folder is not allowed: it is outside the folders declared on the machine, or it does not exist.");
  if (e instanceof NokkerApiError && e.status === 401) return tr("Session expired: sign in again.");
  return tr("The code session could not be opened. Try again.");
}
