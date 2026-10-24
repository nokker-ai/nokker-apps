/**
 * Logique pure de la carte d'approbation locale (LOKKAL-CLI.md §2.2) — testée sans Ink.
 */
import type { Approval, ApprovalScope } from "@nokker-apps/sdk";
import { EFFECT_LABEL, toolTarget, type ToolLine } from "./toolview.js";

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

export function isTestCommand(a: Approval): boolean {
  return a.tool_name === "terminal" && typeof a.arguments.command === "string" && TEST_COMMAND_RE.test(a.arguments.command);
}

/** `1. Une fois · 2. Pour cette session · 3. Toujours cette commande · 3b. Toujours les commandes qui commencent
 * par X* · 4. Refuser`. Pas de 3/3b sur une carte `strong` ni quand le noyau ne propose aucune règle (destructif). */
export function localChoices(a: Approval): LocalChoice[] {
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

export function effectLabel(effect: string | null): string {
  return (effect && (EFFECT_LABEL as Record<string, string>)[effect]) || effect || "inconnu";
}

export function approvalTarget(a: Approval): string {
  return toolTarget(a.tool_name, a.arguments);
}

/** Secondes restantes avant `expires_at` (jamais négatif). */
export function remainingSeconds(a: Approval, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(a.expires_at) - now) / 1000));
}

/** Ligne résumé laissée dans le fil une fois la carte fermée. */
export function decisionSummary(a: Approval, outcome: "approved" | "rejected" | "expired", scope?: ApprovalScope, rule?: string): string {
  const what = `${a.tool_name} ${approvalTarget(a)}`.trim();
  if (outcome === "expired") return `⌛ Approbation expirée — refusée : ${what}`;
  if (outcome === "rejected") return `✗ Refusé : ${what}`;
  const where = scope === "session" ? " (pour cette session)" : scope === "always" ? ` (règle ${rule ?? ""} enregistrée)`.replace(" )", ")") : "";
  return `✓ Approuvé${where} : ${what}`;
}

const sameArgs = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const norm = (o: Record<string, unknown>): string => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  return norm(a) === norm(b);
};

/** Effet d'une carte dont `effect` est null côté noyau : celui du `tool.call` de même outil et mêmes arguments (sinon le
 * dernier appel en cours du même outil), sinon déduit de `rule` (`permissions:accept_edits` → écriture, `effect:xxx` →
 * xxx). `null` en dernier recours seulement. */
export function resolveEffect(a: Approval, lines: ToolLine[]): string | null {
  if (a.effect) return a.effect;
  const same = lines.filter((l) => l.name === a.tool_name && l.effect);
  const hit = [...same].reverse().find((l) => sameArgs(l.args, a.arguments)) ?? [...same].reverse().find((l) => l.ok === null);
  if (hit?.effect) return hit.effect;
  const rule = a.rule ?? "";
  if (/accept_edits/.test(rule)) return "write";
  const m = rule.match(/^effect:(\w+)/);
  return m ? m[1]! : null;
}

/** « 24 h » au-delà d'une heure, « 59 min » sous l'heure, « m:ss » sous 10 min. */
export function formatRemaining(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  if (seconds >= 600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
