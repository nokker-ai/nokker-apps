/**
 * Liste `/threads` du client terminal : les fils du compte et les sessions de code de la machine RÉUNIS, comme la web
 * servie par Lokkal (apps/web/src/lokkal/sessions.ts `mergeLocalSessions`) et l'app.
 * - fils du hub (`GET /v1/threads`) : sessions ordinaires seulement ; un fil de passage d'agent (`origin.kind === "agent"`)
 *   est rangé sous son agent, pas dans la liste (comme la web) ;
 * - sessions de code (`GET /v1/local/sessions`) : le dossier s'affiche à côté du fil ; une session sans tour n'est pas
 *   encore un fil du hub, elle est ajoutée, titrée par son dossier ;
 * - ordre : la plus récente d'abord (`updated_at`, sinon le dernier tour de la session).
 * Fonction pure.
 */
import { isSessionThread, type LocalSessionSummary, type Thread } from "@nokker-apps/sdk";

export interface ThreadRow {
  id: string;
  title: string;
  /** Dossier de la session de code ; `null` pour un fil de conversation. */
  folder: string | null;
  working: boolean;
  bubbles: number;
  pendingApprovals: number;
  updatedAt: string;
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]+/).filter(Boolean).at(-1) ?? cwd;
}

export function unifiedThreads(threads: Thread[], sessions: LocalSessionSummary[], nowIso: string): ThreadRow[] {
  const byThread = new Map(sessions.map((s) => [s.thread_id, s]));
  const rows: ThreadRow[] = threads.filter(isSessionThread).map((th) => {
    const s = byThread.get(th.id);
    return {
      id: th.id,
      title: th.title || (s ? folderName(s.cwd) : th.id),
      folder: s ? s.cwd : null,
      working: th.working || !!s?.working,
      bubbles: th.bubble_count,
      pendingApprovals: s?.pending_approvals ?? 0,
      updatedAt: th.updated_at,
    };
  });
  const known = new Set(rows.map((r) => r.id));
  for (const s of sessions) {
    if (known.has(s.thread_id)) continue;
    rows.push({
      id: s.thread_id,
      title: s.title || folderName(s.cwd),
      folder: s.cwd,
      working: !!s.working,
      bubbles: 0,
      pendingApprovals: s.pending_approvals ?? 0,
      updatedAt: s.last_turn_at ?? nowIso,
    });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
