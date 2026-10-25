import { describe, expect, it, vi } from "vitest";
import { NokkerClient } from "../src/client.js";
import { formatAmount, formatCost, formatCostLine, formatTokens } from "../src/cost.js";
import type { FetchLike, ResponseLike } from "../src/events.js";
import { NOKKER_EVENT_TYPES } from "../src/types.js";

function jsonResponse(status: number, obj: unknown): ResponseLike {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return {
    ok: status < 400,
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

describe("mise en forme du coût par tour", () => {
  it("jetons : unités, k et M à la française", () => {
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(12_400)).toBe("12,4 k");
    expect(formatTokens(12_000)).toBe("12 k");
    expect(formatTokens(250_400)).toBe("250 k");
    expect(formatTokens(1_230_000)).toBe("1,23 M");
    expect(formatTokens(-3)).toBe("0");
  });

  it("anglais (extension VS Code) : point décimal, symbole devant, « tokens »", () => {
    expect(formatTokens(12_400, "en")).toBe("12.4k");
    expect(formatTokens(1_230_000, "en")).toBe("1.23M");
    expect(formatAmount(0.0312, "EUR", "en")).toBe("€0.03");
    expect(formatAmount(0.004, "CHF", "en")).toBe("< CHF 0.01");
    expect(formatAmount(0, "USD", "en")).toBe("$0");
    expect(formatCostLine({ total_tokens: 12_400, cost: { EUR: 0.0312 } }, "en")).toBe("12.4k tokens · €0.03");
    expect(formatCostLine({ total_tokens: 900, cost: null }, "en")).toBe("900 tokens");
    // Défaut inchangé : français.
    expect(formatCostLine({ total_tokens: 12_400, cost: { EUR: 0.0312 } })).toBe("12,4 k jetons · 0,03 €");
  });

  it("montants : devise du noyau, jamais convertie ; sous le centime affiché comme tel", () => {
    expect(formatAmount(0.0312, "EUR")).toBe("0,03 €");
    expect(formatAmount(1.5, "usd")).toBe("1,50 $");
    expect(formatAmount(0.004, "CHF")).toBe("< 0,01 CHF");
    expect(formatAmount(0, "EUR")).toBe("0 €");
    expect(formatAmount(2, "JPY")).toBe("2,00 JPY");
    expect(formatCost({ USD: 0.5, EUR: 0.03 })).toBe("0,03 € + 0,50 $");
    expect(formatCost({})).toBe("");
    expect(formatCost(null)).toBe("");
  });

  it("ligne de fin de tour : jetons · coût, ou jetons seuls sans prix", () => {
    expect(formatCostLine({ total_tokens: 12_400, cost: { EUR: 0.0312 } })).toBe("12,4 k jetons · 0,03 €");
    expect(formatCostLine({ total_tokens: 12_400, cost: {} })).toBe("12,4 k jetons");
  });

  it("turn.cost fait partie des types d'événements connus", () => {
    expect(NOKKER_EVENT_TYPES).toContain("turn.cost");
  });

  it("getLocalCost appelle GET /v1/local/cost avec le fil et le jour", async () => {
    const urls: string[] = [];
    const totals = { session: null, day: { date: "2026-10-25", turns: 0, calls: 0 } };
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse(200, totals);
    }) as unknown as FetchLike;
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl });
    expect(await c.getLocalCost()).toEqual(totals);
    await c.getLocalCost("th_a/b", "2026-10-24");
    expect(urls).toEqual(["http://x/v1/local/cost", "http://x/v1/local/cost?thread_id=th_a%2Fb&day=2026-10-24"]);
  });
});
