/**
 * Mode non interactif `nokker -p "…" [--json]` (LOKKAL-CLI.md §5) — SANS Ink.
 *
 * Dans une session locale, personne ne peut décider une carte : tout effet qui n'est pas déjà couvert par une
 * règle (le noyau n'émet une carte que pour ce qui ne l'est pas) est REFUSÉ par défaut — mode sans surveillance
 * — et le JSON le dit (`refused: [...]`). Les cartes standard/strong d'un fil ordinaire restent `pending`.
 *
 * Code de sortie (D7, `turn.done` du noyau du 01.11) : 4 si le tour a échoué (`error`), 130 s'il a été annulé
 * (`cancelled`), 3 si un effet a été refusé (`refused: true` du noyau, ou une carte rejetée par la CLI), 0 sinon. Plusieurs
 * à la fois : le premier de cet ordre gagne (une erreur dit plus qu'une annulation, une annulation plus qu'un refus).
 */
import { NokkerApiError, type Approval, type TurnDoneError, type NokkerClient, type NokkerEvent, type TurnCostEvent } from "@nokker-apps/sdk";
import type { Connection } from "./auth.js";
import { CliSession } from "./session.js";
import { toolTarget } from "./toolview.js";
import { resolveEffect } from "./approval-model.js";
import { t } from "./i18n/index.js";
import { expandAtRefs } from "./atrefs.js";
import type { LastThreadStore } from "./lastthread.js";
import { serverCwdFor, type WslContext } from "./wslcwd.js";

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
  /** Échec du tour (`turn.done.error`) ; `null` si le tour a réussi ou si le noyau (plus ancien) ne le dit pas. */
  error: TurnDoneError | null;
  /** Code de sortie du processus (`printExitCode`). */
  exit_code: number;
  /** `turn.cost` du tour tel que publié par le noyau (sans `type`) ; absent si le serveur n'en publie pas. */
  cost?: Omit<TurnCostEvent, "type">;
}

/** Attente maximale de `turn.done` après la fin du flux de réponse (les événements arrivent par une autre connexion). */
export const TURN_DONE_WAIT_MS = 2000;

/** Codes de sortie de `nokker -p`. */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 3;
export const EXIT_TURN_ERROR = 4;
export const EXIT_CANCELLED = 130;

/** Priorité : erreur (4) > annulation (130) > refus (3) > succès (0). */
export function printExitCode(r: { error: TurnDoneError | null; cancelled: boolean; refusedByCore: boolean; refused: readonly unknown[] }): number {
  if (r.error) return EXIT_TURN_ERROR;
  if (r.cancelled) return EXIT_CANCELLED;
  if (r.refusedByCore || r.refused.length > 0) return EXIT_REFUSED;
  return EXIT_OK;
}

export async function runPrint(
  text: string,
  client: NokkerClient,
  conn: Connection,
  cwd: string,
  lastThreads?: LastThreadStore,
  wsl: WslContext = { platform: process.platform, wslDistro: null },
): Promise<PrintResult> {
  const session = new CliSession(client, conn.identity, undefined, conn.user);
  // Windows + Lokkal dans WSL : le noyau reçoit le chemin Linux ; les @refs se lisent toujours dans `cwd` (local).
  const target = serverCwdFor(cwd, wsl);
  let local = target.kind !== "other-distro";
  try {
    if (local) await session.openLocal(target.cwd, lastThreads);
  } catch (err) {
    if (!(err instanceof NokkerApiError) || ![403, 404, 405].includes(err.status)) throw err;
    local = false;
  }

  const refused: RefusedEffect[] = [];
  const decisions: Promise<unknown>[] = [];
  let cancelled = false;
  let refusedByCore = false;
  let error: TurnDoneError | null = null;
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
        if (e.refused) refusedByCore = true;
        if (e.error && typeof e.error === "object") error = { code: String(e.error.code ?? "internal_error"), message: String(e.error.message ?? "") };
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
    // Références `@chemin` développées comme dans la session interactive (dossier de la session de code seulement).
    const refs = await expandAtRefs(text, local ? cwd : null).catch(() => null);
    const reply = await session.sendMessage(refs?.text ?? text, () => {}, { attachments: refs?.attachments });
    // `turn.cost` puis `turn.done` passent par /v1/events : la réponse peut arriver avant eux.
    await Promise.race([done, new Promise((r) => setTimeout(r, TURN_DONE_WAIT_MS))]);
    await Promise.all(decisions);
    const pending = (await session.listApprovals("pending")).filter((a) => !session.isLocalThread(a.thread_id));
    return {
      reply,
      thread_id: session.threadId,
      cwd: local ? target.cwd : null,
      pending_approvals: pending.map((a) => a.id),
      refused,
      cancelled,
      error,
      exit_code: printExitCode({ error, cancelled, refusedByCore, refused }),
      ...(cost ? { cost } : {}),
    };
  } finally {
    sub.close();
  }
}
