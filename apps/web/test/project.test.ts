import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { auditLine, money, triggerText, windowState } from "../src/project/ProjectExtras.js";
import { deliveryError, lastLine } from "../src/project/BriefDelivery.js";
import { budgetLabel } from "../src/team/model.js";

describe("projet d'équipe (§7.27)", () => {
  it("budget : état écrit en clair, montants, libellé du plafond jour et mois", () => {
    const w = { spent: 41, cap: 50, ratio: 0.82, resets_at: "2026-11-01T00:00:00+01:00" };
    expect(windowState({ ...w, state: "warning" })).toBe("80 % passé");
    expect(windowState({ ...w, state: "over" })).toMatch(/refusés/);
    expect(windowState({ ...w, cap: null, state: "none" })).toBe("pas de plafond");
    expect(money(3.1, "CHF")).toBe("3.10 CHF");
    expect(budgetLabel({ daily: 5, monthly: 50, currency: "CHF" })).toBe("5 CHF / jour, 50 CHF / mois");
    expect(budgetLabel(null)).toBe("aucun");
  });

  it("agents des autres : déclencheur réduit en clair ; journal sans texte de note", () => {
    expect(triggerText({ kind: "schedule", cron: "0 8 * * 1-5", tz: "Europe/Zurich" })).toBe("planifié (0 8 * * 1-5, Europe/Zurich)");
    expect(triggerText({ kind: "event", event: "mail" })).toBe("sur événement mail");
    expect(triggerText(null)).toBe("manuel");
    expect(auditLine({ id: 1, at: null, actor_account: "alice", event: "agent_disarmed", detail: { agent_id: "ag_1", name: "Veille", owner_account: "bob" } })).toBe("agent d'un membre désarmé · « Veille » · de bob");
    expect(auditLine({ id: 2, at: null, actor_account: "alice", event: "budget_set", detail: { daily: 4, currency: "CHF" } })).toBe("plafond posé · 4/jour CHF");
  });
});

describe("livraison du brief (§7.18.5)", () => {
  it("refus et dernière livraison en clair", () => {
    expect(deliveryError(new NokkerApiError("x", 409, { error: { code: "no_telegram", message: "m" } }))).toMatch(/Telegram/);
    expect(deliveryError(new NokkerApiError("x", 409, { error: { code: "no_mail_connector", message: "m" } }))).toMatch(/boîte mail/);
    expect(lastLine(null)).toBe("aucune livraison pour l'instant");
    expect(lastLine({ at: "2026-10-25T07:30:00Z", telegram: "sent", email: "not_armed" })).toMatch(/Telegram envoyé, e-mail non signé$/);
  });
});
