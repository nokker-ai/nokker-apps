/**
 * Mode non interactif `nokker -p "…" [--json]` (LOKKAL-CLI.md §5) — SANS Ink.
 *
 * Dans une session locale, personne ne peut décider une carte : tout effet qui n'est pas déjà couvert par une
 * règle (le noyau n'émet une carte que pour ce qui ne l'est pas) est REFUSÉ par défaut — mode sans surveillance
 * — et le JSON le dit (`refused: [...]`). Les cartes standard/strong d'un fil ordinaire restent `pending`.
 */
import { NokkerApiError, type Approval, type NokkerClient, type NokkerEvent } from "@nokker-apps/sdk";
import type { Connection } from "./auth.js";
import { CliSession } from "./session.js";
import { toolTarget } from "./toolview.js";
import { resolveEffect } from "./approval-model.js";

export interface RefusedEffect {
  approval_id: string;
  tool: string;
  effect: string | null;
  target: string;
  reason: string;
}

export interface PrintResult {
  reply: string;
  thread_id: string;
  /** Dossier de la session locale (`null` si le serveur n'en propose pas). */
  cwd: string | null;
  pending_approvals: string[];
  refused: RefusedEffect[];
  cancelled: boolean;
}

export async function runPrint(text: string, client: NokkerClient, conn: Connection, cwd: string): Promise<PrintResult> {
  const session = new CliSession(client, conn.identity, undefined, conn.user);
  let local = true;
  try {
    await session.openLocal(cwd);
  } catch (err) {
    if (!(err instanceof NokkerApiError) || ![403, 404, 405].includes(err.status)) throw err;
    local = false;
  }

  const refused: RefusedEffect[] = [];
  const decisions: Promise<unknown>[] = [];
  let cancelled = false;
  let connectedResolve: () => void = () => {};
  const connected = new Promise<void>((r) => (connectedResolve = r));

  const sub = session.subscribeEvents({
    onConnected: () => connectedResolve(),
    onEvent: (e: NokkerEvent) => {
      if (e.type === "turn.done" && e.thread_id === session.threadId && e.cancelled) cancelled = true;
      if (e.type !== "approval.requested") return;
      const a: Approval = e.approval;
      if (!local || !session.isLocalThread(a.thread_id)) return;
      refused.push({
        approval_id: a.id,
        tool: a.tool_name,
        effect: resolveEffect(a, []),
        target: toolTarget(a.tool_name, a.arguments),
        reason: "aucune règle ne couvre cet effet : refusé par défaut (mode non interactif)",
      });
      decisions.push(session.decideLocal(a.id, "reject", "once").catch(() => undefined));
    },
  });
  try {
    // Abonné AVANT le tour : sinon une carte émise tôt serait manquée et le tour resterait bloqué.
    await Promise.race([connected, new Promise((r) => setTimeout(r, 3000))]);
    const reply = await session.sendMessage(text, () => {});
    await Promise.all(decisions);
    const pending = (await session.listApprovals("pending")).filter((a) => !session.isLocalThread(a.thread_id));
    return {
      reply,
      thread_id: session.threadId,
      cwd: local ? cwd : null,
      pending_approvals: pending.map((a) => a.id),
      refused,
      cancelled,
    };
  } finally {
    sub.close();
  }
}
