/**
 * Logique pure de la carte d'approbation locale (LOKKAL-CLI.md §2.2) — testée sans Ink.
 */
import type { Approval, ApprovalScope } from "@nokker-apps/sdk";
import { EFFECT_LABEL, toolTarget, type ToolLine } from "./toolview.js";

// Choix de la carte : partagés avec l'extension VS Code et le pont ACP (SDK, `approval-choices.ts`).
export { TEST_COMMAND_RE, choiceToDecision, isTestCommand, localChoices } from "@nokker-apps/sdk";
export type { LocalChoice, LocalChoiceId } from "@nokker-apps/sdk";

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
