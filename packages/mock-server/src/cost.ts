/**
 * Coût par tour du mock (LOKKAL.md §7.6) : un `turn.cost` juste avant chaque `turn.done`, et `GET /v1/local/cost`
 * (totaux de la session et du jour UTC). Jetons simulés (caractères du message et de la réponse, plus un préfixe fixe),
 * prix tirés d'une petite grille en EUR comme celle du noyau ; un modèle hors grille donne des jetons seulement.
 */
import type { CostByCurrency, CostSummary, LocalCostTotals, ModelCost, TurnCostEvent } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

/** € par million de jetons — repris du catalogue de prix du noyau (entrée en EUR, pas de cache). */
export const MOCK_PRICES: Record<string, { input: number; output: number; currency: string }> = {
  "Qwen3.5-397B-A17B": { input: 0.6, output: 3.6, currency: "EUR" },
};
export const MOCK_COST_MODEL = "Qwen3.5-397B-A17B";
/** Préfixe système simulé : un vrai tour de code transporte des milliers de jetons, pas la longueur du message. */
export const MOCK_PREFIX_TOKENS = 12_000;

interface CostRow {
  thread_id: string;
  turn_id: string;
  model: string;
  input: number;
  output: number;
  day: string;
}

interface CostBook {
  rows: CostRow[];
  /** Modèle des prochains tours (tests : un modèle hors grille donne des jetons seulement). */
  model: string;
}

const books = new WeakMap<MockState, CostBook>();

export function costBook(state: MockState): CostBook {
  let b = books.get(state);
  if (!b) books.set(state, (b = { rows: [], model: MOCK_COST_MODEL }));
  return b;
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function summarize(rows: CostRow[]): CostSummary {
  const byModel = new Map<string, ModelCost>();
  const total: CostByCurrency = {};
  for (const r of rows) {
    let m = byModel.get(r.model);
    if (!m) {
      m = { model: r.model, tiers: ["deep"], calls: 0, input_tokens: 0, cached_tokens: null, output_tokens: 0, reasoning_tokens: null, total_tokens: 0, cost: null, price_source: null };
      byModel.set(r.model, m);
    }
    m.calls += 1;
    m.input_tokens += r.input;
    m.output_tokens += r.output;
    m.total_tokens += r.input + r.output;
    const price = MOCK_PRICES[r.model];
    if (price) {
      const amount = (r.input * price.input + r.output * price.output) / 1_000_000;
      m.cost = { ...(m.cost ?? {}), [price.currency]: (m.cost?.[price.currency] ?? 0) + amount };
      m.price_source = "catalog";
      total[price.currency] = (total[price.currency] ?? 0) + amount;
    }
  }
  const round = (c: CostByCurrency): CostByCurrency => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));
  const models = [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)).map((m) => ({ ...m, cost: m.cost ? round(m.cost) : null }));
  return {
    calls: rows.length,
    input_tokens: models.reduce((s, m) => s + m.input_tokens, 0),
    cached_tokens: null,
    output_tokens: models.reduce((s, m) => s + m.output_tokens, 0),
    reasoning_tokens: null,
    total_tokens: models.reduce((s, m) => s + m.total_tokens, 0),
    cost: round(total),
    unpriced_models: models.filter((m) => m.cost === null).map((m) => m.model),
    models,
  };
}

/** Enregistre le tour et publie son `turn.cost` (à appeler juste avant `turn.done`). */
export function publishTurnCost(state: MockState, threadId: string, turnId: string, userText: string, reply: string): TurnCostEvent {
  const book = costBook(state);
  const row: CostRow = { thread_id: threadId, turn_id: turnId, model: book.model, input: MOCK_PREFIX_TOKENS + userText.length, output: reply.length, day: utcDay() };
  book.rows.push(row);
  const event: TurnCostEvent = { type: "turn.cost", thread_id: threadId, turn_id: turnId, subagent_calls: 0, ...summarize([row]) };
  state.publish(event);
  return event;
}

function withTurns(rows: CostRow[]): CostSummary & { turns: number } {
  return { ...summarize(rows), turns: new Set(rows.filter((r) => !r.thread_id.includes("/sa-")).map((r) => r.turn_id)).size };
}

/** `GET /v1/local/cost?thread_id=&day=` : 400 si `day` n'est pas AAAA-MM-JJ. */
export function localCostTotals(state: MockState, threadId: string | null, day: string | null): LocalCostTotals | null {
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const rows = costBook(state).rows;
  const d = day || utcDay();
  return {
    session: threadId ? { thread_id: threadId, ...withTurns(rows.filter((r) => r.thread_id === threadId || r.thread_id.startsWith(`${threadId}/sa-`))) } : null,
    day: { date: d, ...withTurns(rows.filter((r) => r.day === d)) },
  };
}
