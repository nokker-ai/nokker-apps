import { describe, expect, it } from "vitest";
import { approvalContinuation, approvalContinuationText } from "../src/components/Chat.js";

// Block written by the kernel (nokker/approvals/executor.py::_approbation_block), for the model.
const block = (tool: string, status: string) =>
  ["[Approbation]", `Outil : ${tool}`, `Décision : ${status}`, "Décideur : local-owner", "Moyen : local-passkey", "Résultat : Mandat md_1 signé", "Cette action est tranchée : ne la relance pas.", "[/Approbation]"].join("\n");

describe("tour qui suit une décision (bloc [Approbation], destiné au modèle)", () => {
  it("se lit comme une décision, jamais comme un message de la personne", () => {
    expect(approvalContinuation({ role: "user", content: block("pay_request", "executed") })).toEqual({ tool: "pay_request", status: "executed" });
    expect(approvalContinuation({ role: "user", content: "Achète-moi la bouilloire" })).toBeNull();
    expect(approvalContinuation({ role: "assistant", content: block("pay_request", "executed") })).toBeNull();
    // Marked by the core (origin), even if the block's text ever changes.
    expect(approvalContinuation({ role: "user", content: "Outil : pay_request\nD\u00e9cision : rejected", origin: "approval" })).toEqual({ tool: "pay_request", status: "rejected" });
  });
  it("une ligne courte, sans rien des consignes au modèle", () => {
    expect(approvalContinuationText({ tool: "pay_request", status: "executed" })).toBe("Payment approved");
    expect(approvalContinuationText({ tool: "pay_request", status: "rejected" })).toBe("Payment refused");
    expect(approvalContinuationText({ tool: "pay_request", status: "failed" })).toBe("Payment approved, then stopped");
    expect(approvalContinuationText({ tool: "terminal", status: "executed" })).toBe("terminal: executed");
  });
});

import { approvalTitle } from "../src/approvals/title.js";

describe("titre de la bulle approval (le noyau la titre avec le nom brut de l'outil)", () => {
  it("un libellé humain, jamais le nom de l'outil", () => {
    expect(approvalTitle({ status: "working", state: { tool_name: "pay_request", status: "pending" } })).toBe("Payment to approve");
    expect(approvalTitle({ status: "done", state: { tool_name: "pay_request", status: "executed" } })).toBe("Payment approved");
    expect(approvalTitle({ status: "done", state: { tool_name: "send_email", status: "rejected" } })).toBe("Action refused");
    expect(approvalTitle({ status: "failed", state: { tool_name: "send_email", status: "expired" } })).toBe("Action expired");
    expect(approvalTitle({ status: "working", state: {} })).toBe("Action to approve");
  });
});
