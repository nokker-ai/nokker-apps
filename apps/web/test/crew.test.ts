import { describe, expect, it } from "vitest";
import type { AgentRun } from "@nokker-apps/sdk";
import { cronLabel, mergeRun, runCost, runDuration, triggerLabel } from "../src/crew/model.js";

describe("deck Crew (X14)", () => {
  it("cron lisible, sinon brut", () => {
    expect(cronLabel("0 7 * * 1-5")).toBe("chaque jour ouvré à 07:00");
    expect(cronLabel("30 6 * * *")).toBe("chaque jour à 06:30");
    expect(cronLabel("0 9 * * 1")).toBe("chaque lundi à 09:00");
    expect(cronLabel("*/15 * * * *")).toBe("toutes les 15 min");
    expect(cronLabel("5 * * * *")).toBe("chaque heure à :05");
    expect(cronLabel("0 8 1 * *")).toBe("le 1 de chaque mois à 08:00");
    expect(cronLabel("0 8 * 1 *")).toBe("cron 0 8 * 1 *");
    expect(cronLabel("bizarre")).toBe("cron bizarre");
  });
  it("déclencheurs", () => {
    expect(triggerLabel(undefined)).toBe("à la demande");
    expect(triggerLabel({ kind: "manual" })).toBe("à la demande");
    expect(triggerLabel({ kind: "event", event: "alert:disque-plein" })).toBe("sur alerte « disque-plein »");
    // `mail:<filtre>` : la relève du courrier (BUBBLES §9.5 « Courrier »).
    expect(triggerLabel({ kind: "event", event: "mail:from:factures@example.com" })).toBe("à la réception d'un mail (from:factures@example.com)");
    expect(triggerLabel({ kind: "event", event: "mail:*" })).toBe("à chaque mail reçu");
    expect(triggerLabel({ kind: "schedule", cron: "0 7 * * 1-5", tz: "Europe/Zurich" })).toBe("chaque jour ouvré à 07:00");
  });
  const run = (id: string, status: AgentRun["status"]): AgentRun => ({
    run_id: id, agent_id: "ag", trigger: "manual", scheduled_for: null, started_at: "2026-10-25T10:00:00Z", ended_at: "2026-10-25T10:00:42Z",
    status, thread_id: null, cost: { tokens_in: 1, tokens_out: 1, amount: 0.012, currency: "EUR" }, summary: null,
  });
  it("passages : durée, coût, fusion", () => {
    expect(runDuration(run("a", "succeeded"))).toBe("42 s");
    expect(runCost(run("a", "succeeded"))).toBe("0.012 EUR");
    expect(runCost({ cost: { tokens_in: 1, tokens_out: 1, amount: 0.5, currency: "EUR", calls: 3, amounts: { EUR: 0.5, CHF: 0.2 } } })).toBe("0.20 CHF + 0.50 EUR · 3 appels");
    const l = [run("b", "succeeded")];
    expect(mergeRun(l, run("a", "running")).map((r) => r.run_id)).toEqual(["a", "b"]);
    expect(mergeRun(l, run("b", "failed"))[0]!.status).toBe("failed");
  });
});
