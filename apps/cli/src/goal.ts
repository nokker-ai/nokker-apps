/**
 * `/goal <objectif>` — pur, sans Ink : état de l'objectif de session et décision prise à la fin de chaque tour
 * (vérifier, relancer, s'arrêter). Garde-fous : `GOAL_MAX_AUTO_TURNS` tours automatiques au plus (vérifications ET
 * relances comptées), arrêt sur carte d'approbation en attente, sur Échap (ou /cancel), sur erreur, sur réponse de
 * vérification sans marqueur. Les textes envoyés au modèle sont dans `prompts.ts`.
 */
import { t } from "./i18n/index.js";
import { GOAL_CONTINUE_MARKER, GOAL_DONE_MARKER } from "./prompts.js";
import type { TurnKind } from "./promptqueue.js";
import type { KernelGoal } from "@nokker-apps/sdk";

export const GOAL_MAX_AUTO_TURNS = 10;

export interface GoalState {
  text: string;
  status: "active" | "done" | "stopped";
  /** Tours automatiques déjà envoyés (vérifications et relances). */
  autoTurns: number;
  /** Raison de l'arrêt (libellé affiché). */
  reason?: string;
  /** Objectif posé CHEZ LE NOYAU (`POST /v1/threads/{id}/goal {driver: "client"}`) : seul l'état rendu par le noyau
   * après le `goal_check` fait foi, jamais un marqueur écrit dans une réponse. */
  kernel?: boolean;
  /** Dernière note du correcteur (objectif noyau). */
  grade?: { total: number; max: number } | null;
}

export function newGoal(text: string, kernel = false): GoalState {
  return kernel ? { text, status: "active", autoTurns: 0, kernel: true, grade: null } : { text, status: "active", autoTurns: 0 };
}

/** Critères d'un `/goal` sur plusieurs lignes : la première est l'objectif, les suivantes les critères (comme dans un
 * fil du noyau). */
export function splitGoalText(raw: string): { text: string; criteria: string[] } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { text: lines[0] ?? "", criteria: lines.slice(1).map((l) => l.replace(/^[-*•]\s*|^\d+[.)]\s*/, "")).filter(Boolean) };
}

/** Libellé d'un statut d'arrêt rendu par le noyau. */
export function kernelStopLabel(k: KernelGoal): string {
  const base: Record<string, string> = {
    budget: t("budget reached"),
    blocked: t("blocked"),
    stopped: t("stopped"),
  };
  const label = base[k.status] ?? k.status;
  return k.stop_reason ? t("{0} — {1}", label, k.stop_reason) : label;
}

/** Verdict d'une réponse de vérification : le DERNIER marqueur trouvé (le modèle peut citer l'autre avant). */
export function parseGoalVerdict(reply: string): "done" | "continue" | null {
  const re = new RegExp(`(${escape(GOAL_DONE_MARKER)}|${escape(GOAL_CONTINUE_MARKER)})`, "gi");
  let last: string | null = null;
  for (const m of reply.matchAll(re)) last = m[1]!.toUpperCase();
  if (last === null) return null;
  return last.replace(/\s+/g, " ") === GOAL_DONE_MARKER ? "done" : "continue";
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");
}

export interface TurnOutcome {
  kind: TurnKind;
  reply: string;
  failed: boolean;
  cancelled: boolean;
  /** Une carte d'approbation attend une décision à la fin du tour. */
  cardPending: boolean;
}

export interface GoalStep {
  goal: GoalState;
  /** Tour automatique à envoyer (quand le fil est libre et la file vide). */
  send: "check" | "continue" | null;
  /** Ligne à afficher. */
  message: string | null;
}

function stop(goal: GoalState, reason: string): GoalStep {
  return { goal: { ...goal, status: "stopped", reason }, send: null, message: t("Goal stopped: {0}.", reason) };
}

/** Décision à la fin d'un tour, objectif actif. Objectif noyau : `kernelState` est l'objectif relu chez le noyau
 * APRÈS le `goal_check` (`undefined` : pas relu, `null` : illisible) ; la réponse du tour n'est pas lue. */
export function nextGoalStep(goal: GoalState, o: TurnOutcome, kernelState?: KernelGoal | null): GoalStep {
  if (goal.status !== "active") return { goal, send: null, message: null };
  if (o.cancelled) return stop(goal, t("turn cancelled"));
  if (o.failed) return stop(goal, t("the turn failed"));
  if (o.cardPending) return stop(goal, t("an approval card is waiting"));
  if (goal.kernel && o.kind === "goalCheck") {
    if (!kernelState) return stop(goal, t("the core did not return the goal state"));
    const g = kernelState.last_grade ? { ...goal, grade: { total: kernelState.last_grade.total, max: kernelState.last_grade.max } } : goal;
    if (kernelState.status === "done") return { goal: { ...g, status: "done" }, send: null, message: t("✓ Goal reached (graded by the core): {0}", goal.text) };
    if (kernelState.status !== "active" && kernelState.status !== "draft") {
      const reason = t("by the core: {0}", kernelStopLabel(kernelState));
      return { goal: { ...g, status: "stopped", reason }, send: null, message: t("Goal stopped: {0}.", reason) };
    }
    if (goal.autoTurns >= GOAL_MAX_AUTO_TURNS) return stop(g, t("{0} automatic turns reached", GOAL_MAX_AUTO_TURNS));
    return { goal: g, send: "continue", message: null };
  }
  if (o.kind === "goalCheck") {
    const v = parseGoalVerdict(o.reply);
    if (v === "done") return { goal: { ...goal, status: "done" }, send: null, message: t("✓ Goal reached: {0}", goal.text) };
    if (v === null) return stop(goal, t("the check answer had no GOAL marker"));
    if (goal.autoTurns >= GOAL_MAX_AUTO_TURNS) return stop(goal, t("{0} automatic turns reached", GOAL_MAX_AUTO_TURNS));
    return { goal, send: "continue", message: null };
  }
  if (goal.autoTurns >= GOAL_MAX_AUTO_TURNS) return stop(goal, t("{0} automatic turns reached", GOAL_MAX_AUTO_TURNS));
  return { goal, send: "check", message: null };
}

/** Segment de la barre d'état. */
export function goalStatusLine(goal: GoalState): string {
  const text = goal.text.length > 48 ? `${goal.text.slice(0, 47)}…` : goal.text;
  const note = goal.kernel && goal.grade ? t(", grade {0}/{1}", goal.grade.total, goal.grade.max) : "";
  if (goal.kernel && goal.status === "active") return t("goal (core): {0} · active, automatic turns {1}/{2}{3}", text, goal.autoTurns, GOAL_MAX_AUTO_TURNS, note);
  if (goal.status === "done") return t("goal: {0} · reached", text);
  if (goal.status === "stopped") return t("goal: {0} · stopped ({1})", text, goal.reason ?? "");
  return t("goal: {0} · active, automatic turns {1}/{2}", text, goal.autoTurns, GOAL_MAX_AUTO_TURNS);
}

/** `/goal` sans argument. */
export function formatGoal(goal: GoalState | null): string {
  if (!goal) return t("No goal set. /goal <objective> sets one: after each turn the agent is asked whether it is reached, and continues if not.");
  const lines = [goalStatusLine(goal), t("Full text: {0}", goal.text)];
  if (goal.kernel) lines.push(t("Graded by the core: a “GOAL: DONE” written by the model does not end it."));
  lines.push(t("/goal clear stops it."));
  return lines.join("\n");
}
