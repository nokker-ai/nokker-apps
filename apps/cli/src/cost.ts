/**
 * Coût par tour dans le client terminal (LOKKAL.md §7.6) — pur, sans Ink ni réseau : la ligne de fin de tour
 * (`turn.cost`) et le texte de `/cost` (`GET /v1/local/cost`). Les montants viennent du noyau, dans la devise de son
 * catalogue de prix ; rien n'est recalculé ici.
 */
import { formatCost, formatCostLine, formatTokens, type CostSummary, type LocalCostTotals, type TurnCostEvent } from "@nokker-apps/sdk";

/** Ligne discrète sous un tour : « 12,4 k jetons · 0,03 € » (jetons seuls sans prix). `null` : tour sans appel modèle. */
export function turnCostLine(e: Pick<TurnCostEvent, "total_tokens" | "cost">): string | null {
  if (!e.total_tokens) return null;
  return formatCostLine(e);
}

function detail(s: CostSummary): string {
  const parts: string[] = [];
  if (s.cached_tokens) parts.push(`dont ${formatTokens(s.cached_tokens)} en cache`);
  if (s.reasoning_tokens) parts.push(`dont ${formatTokens(s.reasoning_tokens)} de raisonnement`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function block(label: string, s: CostSummary & { turns: number }): string[] {
  const lines = [`${label} : ${s.turns} tour(s) · ${formatCostLine(s)}${detail(s)}`];
  if (s.models.length > 1) {
    for (const m of s.models) {
      const money = formatCost(m.cost);
      lines.push(`    ${m.model} : ${formatTokens(m.total_tokens)} jetons${money ? ` · ${money}` : ""}`);
    }
  }
  if (s.unpriced_models.length) lines.push(`    sans prix connu (jetons seulement) : ${s.unpriced_models.join(", ")}`);
  return lines;
}

/** Texte de `/cost`. */
export function formatCostTotals(t: LocalCostTotals): string {
  const lines = ["Coût"];
  if (t.session) lines.push(...block("  session", t.session));
  lines.push(...block(`  jour (${t.day.date}, UTC)`, t.day));
  return lines.join("\n");
}
