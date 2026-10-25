/**
 * Mode non interactif `nokker -p "…" [--json]` (LOKKAL-CLI.md §5) — SANS Ink.
 *
 * Dans une session locale, personne ne peut décider une carte : tout effet qui n'est pas déjà couvert par une
 * règle (le noyau n'émet une carte que pour ce qui ne l'est pas) est REFUSÉ par défaut — mode sans surveillance
 * — et le JSON le dit (`refused: [...]`). Les cartes standard/strong d'un fil ordinaire restent `pending`.
 */
import { NokkerApiError, type Approval, type NokkerClient, type NokkerEvent, type TurnCostEvent } from "@nokker-apps/sdk";
import type { Connection } from "./auth.js";
import { CliSession } from "./session.js";
import { toolTarget } from "./toolview.js";
import { resolveEffect } from "./approval-model.js";
import { t } from "./i18n/index.js";

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
  /** `turn.cost` du tour tel que publié par le noyau (sans `type`) ; absent si le serveur n'en publie pas. */
  cost?: Omit<TurnCostEvent, "type">;
}

/** Attente maximale de `turn.done` après la fin du flux de réponse (les événements arrivent par une autre connexion). */
export const TURN_DONE_WAIT_MS = 2000;

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
  let cost: Omit<TurnCostEvent, "type"> | undefined;
  let doneResolve: () => void = () => {};
  const done = new Promise<void>((r) => (doneResolve = r));
  let connectedResolve: () => void = () => {};
  const connected = new Promise<void>((r) => (connectedResolve = r));

  const sub = session.subscribeEvents({
    onConnected: () => connectedResolve(),
    onEvent: (e: NokkerEvent) => {
      if (e.type === "turn.cost" && e.thread_id === session.threadId) {
        const { type: _t, ...rest } = e;
        void _t;
        cost = rest;
      }
      if (e.type === "turn.done" && e.thread_id === session.threadId) {
        if (e.cancelled) cancelled = true;
        doneResolve();
      }
      if (e.type !== "approval.requested") return;
      const a: Approval = e.approval;
      if (!local || !session.isLocalThread(a.thread_id)) return;
      refused.push({
        approval_id: a.id,
        tool: a.tool_name,
        effect: resolveEffect(a, []),
        target: toolTarget(a.tool_name, a.arguments),
        reason: t("no rule covers this effect: refused by default (non-interactive mode)"),
      });
      decisions.push(session.decideLocal(a.id, "reject", "once").catch(() => undefined));
    },
  });
  try {
    // Abonné AVANT le tour : sinon une carte émise tôt serait manquée et le tour resterait bloqué.
    await Promise.race([connected, new Promise((r) => setTimeout(r, 3000))]);
    const reply = await session.sendMessage(text, () => {});
    // `turn.cost` puis `turn.done` passent par /v1/events : la réponse peut arriver avant eux.
    await Promise.race([done, new Promise((r) => setTimeout(r, TURN_DONE_WAIT_MS))]);
    await Promise.all(decisions);
    const pending = (await session.listApprovals("pending")).filter((a) => !session.isLocalThread(a.thread_id));
    return {
      reply,
      thread_id: session.threadId,
      cwd: local ? cwd : null,
      pending_approvals: pending.map((a) => a.id),
      refused,
      cancelled,
      ...(cost ? { cost } : {}),
    };
  } finally {
    sub.close();
  }
}
