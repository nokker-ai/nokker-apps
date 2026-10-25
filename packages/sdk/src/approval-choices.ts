/**
 * Choix d'une carte d'approbation locale (LOKKAL.md §7.4.3) — partagés par le client terminal, l'extension VS Code et
 * le pont ACP, pour qu'ils proposent les MÊMES options dans le même ordre. Pur, sans I/O.
 */
import type { Approval, ApprovalScope } from "./types.js";

export type LocalChoiceId = "once" | "session" | "always" | "reject";

export interface LocalChoice {
  id: LocalChoiceId;
  /** Numéro affiché ET touche : 3 / 3b absents sur une carte forte ou destructive (« forte-locale »), 4 reste « Refuser ». */
  key: string;
  label: string;
  /** « Toujours » : la règle EXACTE qui sera écrite dans les réglages. */
  rule?: string;
}

/** Commande de test : « Pour cette session » passe en premier (la relancer est le geste normal d'une boucle de correction). */
export const TEST_COMMAND_RE = /\b(?:pytest|unittest|npm test|pnpm test|yarn test|go test|cargo test|make test|vitest|jest)\b/;

export function isTestCommand(a: Pick<Approval, "tool_name" | "arguments">): boolean {
  return a.tool_name === "terminal" && typeof a.arguments.command === "string" && TEST_COMMAND_RE.test(a.arguments.command);
}

/** `1. Une fois · 2. Pour cette session · 3. Toujours cette commande · 3b. Toujours les commandes qui commencent
 * par X* · 4. Refuser`. Pas de 3/3b sur une carte `strong` ni quand le noyau ne propose aucune règle (destructif). */
export function localChoices(a: Pick<Approval, "tool_name" | "arguments" | "strength" | "suggested_rules">): LocalChoice[] {
  // Carte forte : `once` seulement (le noyau répond 400 pour session/always) — Une fois ou Refuser.
  if (a.strength === "strong") {
    return [
      { id: "once", key: "1", label: "Une fois" },
      { id: "reject", key: "4", label: "Refuser" },
    ];
  }
  // Commande de test : 1. Pour cette session · 2. Une fois ; sinon 1. Une fois · 2. Pour cette session.
  const once: LocalChoice = { id: "once", key: "1", label: "Une fois" };
  const session: LocalChoice = { id: "session", key: "2", label: "Pour cette session" };
  const choices: LocalChoice[] = isTestCommand(a) ? [{ ...session, key: "1" }, { ...once, key: "2" }] : [once, session];
  const rules = a.suggested_rules ?? [];
  const file = a.tool_name !== "terminal";
  if (rules[0]) choices.push({ id: "always", key: "3", label: file ? "Toujours ce fichier (règle)" : "Toujours cette commande", rule: rules[0] });
  if (rules[1]) {
    choices.push({
      id: "always",
      key: "3b",
      label: file ? "Toujours ce dossier (règle)" : "Toujours les commandes qui commencent par ce préfixe",
      rule: rules[1],
    });
  }
  choices.push({ id: "reject", key: "4", label: "Refuser" });
  return choices;
}

export function choiceToDecision(id: LocalChoiceId): { decision: "approve" | "reject"; scope: ApprovalScope } {
  return id === "reject" ? { decision: "reject", scope: "once" } : { decision: "approve", scope: id };
}

/** Une carte FORTE ne se décide pas depuis un éditeur (VS Code, client ACP). Le client terminal, lui, peut la décider
 * une fois (preuve du propriétaire de la machine) ; machine liée, elle part aussi au téléphone (LOKKAL.md §7.3). */
export function editorCannotDecide(a: Pick<Approval, "strength">): boolean {
  return a.strength === "strong";
}

export const STRONG_PHONE_TEXT = "Action forte : elle attend ton téléphone.";
export const STRONG_TERMINAL_TEXT = "Action forte : à décider dans le terminal (`nokker`).";

/** Texte affiché par un éditeur à la place des boutons d'une carte forte : « téléphone » seulement si le noyau l'a
 * déposée chez nokker.ai (`forwarded`, ou l'événement `approval.forwarded`) ; sinon elle se décide au terminal. */
export function strongCardText(a: Pick<Approval, "forwarded">): string {
  return a.forwarded === true ? STRONG_PHONE_TEXT : STRONG_TERMINAL_TEXT;
}
