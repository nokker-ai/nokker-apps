/**
 * Coût par tour dans le client terminal (LOKKAL.md §7.6) — pur, sans Ink ni réseau : la ligne de fin de tour
 * (`turn.cost`) et le texte de `/cost` (`GET /v1/local/cost`). Les montants viennent du noyau, dans la devise de son
 * catalogue de prix ; rien n'est recalculé ici.
 */
import { formatCost, formatCostLine, formatTokens, type CostSummary, type LocalCostTotals, type TurnCostEvent } from "@nokker-apps/sdk";
import { costLang, t } from "./i18n/index.js";

/** Ligne discrète sous un tour : « 12.4k tokens · €0.03 » (fr : « 12,4 k jetons · 0,03 € » ; jetons seuls sans prix). `null` : tour sans appel modèle. */
export function turnCostLine(e: Pick<TurnCostEvent, "total_tokens" | "cost">): string | null {
  if (!e.total_tokens) return null;
  return formatCostLine(e, costLang());
}

function detail(s: CostSummary): string {
  const parts: string[] = [];
  if (s.cached_tokens) parts.push(t("{0} of them cached", formatTokens(s.cached_tokens, costLang())));
  if (s.reasoning_tokens) parts.push(t("{0} of them reasoning", formatTokens(s.reasoning_tokens, costLang())));
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function block(label: string, s: CostSummary & { turns: number }): string[] {
  const lines = [t("{0}: {1} turn(s) · {2}{3}", label, s.turns, formatCostLine(s, costLang()), detail(s))];
  if (s.models.length > 1) {
    for (const m of s.models) {
      const money = formatCost(m.cost, costLang());
      lines.push(`    ${t("{0}: {1} tokens", m.model, formatTokens(m.total_tokens, costLang()))}${money ? ` · ${money}` : ""}`);
    }
  }
  if (s.unpriced_models.length) lines.push(`    ${t("no known price (tokens only): {0}", s.unpriced_models.join(", "))}`);
  return lines;
}

/** Texte de `/cost`. */
export function formatCostTotals(totals: LocalCostTotals): string {
  const lines = [t("Cost")];
  if (totals.session) lines.push(...block(`  ${t("session")}`, totals.session));
  lines.push(...block(`  ${t("day ({0}, UTC)", totals.day.date)}`, totals.day));
  return lines.join("\n");
}
