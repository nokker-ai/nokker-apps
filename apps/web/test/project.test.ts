import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { auditLine, money, triggerText, windowState } from "../src/project/ProjectExtras.js";
import { deliveryError, lastLine } from "../src/project/BriefDelivery.js";
import { budgetLabel } from "../src/team/model.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

describe("projet d'équipe (§7.27)", () => {
  it("budget : état écrit en clair, montants, libellé du plafond jour et mois", () => {
    const w = { spent: 41, cap: 50, ratio: 0.82, resets_at: "2026-11-01T00:00:00+01:00" };
    expect(windowState({ ...w, state: "warning" })).toBe("over 80%");
    expect(windowState({ ...w, state: "over" })).toMatch(/refused/);
    expect(windowState({ ...w, cap: null, state: "none" })).toBe("no cap");
    expect(money(3.1, "CHF")).toBe("3.10 CHF");
    expect(budgetLabel({ daily: 5, monthly: 50, currency: "CHF" })).toBe("5 CHF / day, 50 CHF / month");
    expect(budgetLabel(null)).toBe("none");
  });

  it("agents des autres : déclencheur réduit en clair ; journal sans texte de note", () => {
    expect(triggerText({ kind: "schedule", cron: "0 8 * * 1-5", tz: "Europe/Zurich" })).toBe("scheduled (0 8 * * 1-5, Europe/Zurich)");
    expect(triggerText({ kind: "event", event: "mail" })).toBe("on event mail");
    expect(triggerText(null)).toBe("manual");
    expect(auditLine({ id: 1, at: null, actor_account: "alice", event: "agent_disarmed", detail: { agent_id: "ag_1", name: "Veille", owner_account: "bob" } })).toBe("member's agent disarmed · “Veille” · from bob");
    expect(auditLine({ id: 2, at: null, actor_account: "alice", event: "budget_set", detail: { daily: 4, currency: "CHF" } })).toBe("cap set · 4/day CHF");
  });
});

describe("livraison du brief (§7.18.5)", () => {
  it("refus et dernière livraison en clair", () => {
    expect(deliveryError(new NokkerApiError("x", 409, { error: { code: "no_telegram", message: "m" } }))).toMatch(/Telegram/);
    expect(deliveryError(new NokkerApiError("x", 409, { error: { code: "no_mail_connector", message: "m" } }))).toMatch(/Link a mailbox/);
    expect(lastLine(null)).toBe("no delivery yet");
    expect(lastLine({ at: "2026-10-25T07:30:00Z", telegram: "sent", email: "not_armed" })).toMatch(/Telegram sent, email not signed$/);
  });

  it("en français", () => {
    setShellLang("fr");
    expect(lastLine(null)).toBe("aucune livraison pour l'instant");
    expect(lastLine({ at: "2026-10-25T07:30:00Z", telegram: "sent", email: "not_armed" })).toMatch(/Telegram envoyé, e-mail non signé$/);
    expect(windowState({ spent: 41, cap: 50, ratio: 0.82, resets_at: "2026-11-01T00:00:00+01:00", state: "warning" })).toBe("80 % passé");
    expect(triggerText({ kind: "event", event: "mail" })).toBe("sur événement mail");
    expect(auditLine({ id: 1, at: null, actor_account: "alice", event: "agent_disarmed", detail: { agent_id: "ag_1", name: "Veille", owner_account: "bob" } })).toBe("agent d'un membre désarmé · « Veille » · de bob");
  });
});
