import { describe, expect, it } from "vitest";
import type { CostSummary, LocalCostTotals } from "@nokker-apps/sdk";
import { formatCostTotals, turnCostLine } from "../src/cost.js";

const base: CostSummary = {
  calls: 2,
  input_tokens: 12_000,
  cached_tokens: null,
  output_tokens: 400,
  reasoning_tokens: null,
  total_tokens: 12_400,
  cost: { EUR: 0.0312 },
  unpriced_models: [],
  models: [
    { model: "Qwen3.5-397B-A17B", tiers: ["deep"], calls: 2, input_tokens: 12_000, cached_tokens: null, output_tokens: 400, reasoning_tokens: null, total_tokens: 12_400, cost: { EUR: 0.0312 }, price_source: "catalog" },
  ],
};

describe("coût par tour (client terminal)", () => {
  it("ligne de fin de tour : jetons · coût, jetons seuls sans prix, rien sans appel modèle", () => {
    expect(turnCostLine(base)).toBe("12,4 k jetons · 0,03 €");
    expect(turnCostLine({ ...base, cost: {} })).toBe("12,4 k jetons");
    expect(turnCostLine({ ...base, total_tokens: 0, cost: {} })).toBeNull();
  });

  it("/cost : session et jour, détail par modèle et modèles sans prix", () => {
    const mixed: CostSummary = {
      ...base,
      cached_tokens: 4_000,
      reasoning_tokens: 1_500,
      unpriced_models: ["acme/inconnu"],
      models: [
        base.models[0]!,
        { ...base.models[0]!, model: "acme/inconnu", cost: null, price_source: null, total_tokens: 2_000 },
      ],
    };
    const t: LocalCostTotals = { session: { thread_id: "th_a", turns: 3, ...base }, day: { date: "2026-10-25", turns: 7, ...mixed } };
    expect(formatCostTotals(t)).toBe(
      [
        "Coût",
        "  session : 3 tour(s) · 12,4 k jetons · 0,03 €",
        "  jour (2026-10-25, UTC) : 7 tour(s) · 12,4 k jetons · 0,03 € (dont 4 k en cache, dont 1,5 k de raisonnement)",
        "    Qwen3.5-397B-A17B : 12,4 k jetons · 0,03 €",
        "    acme/inconnu : 2 k jetons",
        "    sans prix connu (jetons seulement) : acme/inconnu",
      ].join("\n"),
    );
    expect(formatCostTotals({ session: null, day: { date: "2026-10-25", turns: 0, ...base, total_tokens: 0, cost: {}, models: [] } })).toBe(
      "Coût\n  jour (2026-10-25, UTC) : 0 tour(s) · 0 jetons",
    );
  });
});
