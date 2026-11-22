import { describe, expect, it } from "vitest";
import { approvalTargetOf, withTarget } from "../src/approval-target.js";
import type { Approval } from "@nokker-apps/sdk";

describe("target d'une carte (mock aligné sur le noyau)", () => {
  it("la cible lisible selon l'outil, jamais l'objet d'arguments", () => {
    expect(approvalTargetOf("terminal", { command: "sh livrer.sh 2.1 && echo ok" })).toBe("sh livrer.sh 2.1 && echo ok");
    expect(approvalTargetOf("write_file", { path: "src/app.py", content: "secret" })).toBe("src/app.py");
    expect(approvalTargetOf("fetch", { url: "https://example.org/x" })).toBe("https://example.org/x");
    expect(approvalTargetOf("send_email_bulk", { to: "a@b.ch", subject: "Hello", body: "never shown" })).toBe("a@b.ch — Hello");
    expect(approvalTargetOf("inconnu", { x: 1 })).toBe("");
    expect(approvalTargetOf("browser_navigate", { url: "https://example.org" })).toBe("https://example.org");
    expect(approvalTargetOf("read_file", { path: "a.txt" })).toBe("a.txt");
    expect(approvalTargetOf("maison_action_forte", { domain: "light", service: "turn_on", entity: "salon" })).toBe("light.turn_on \u2014 salon");
  });
  it("NFC, sans retour à la ligne ni caractère de contrôle (contrat du noyau)", () => {
    expect(approvalTargetOf("terminal", { command: "echo e\u0301\nls\t-la\u0000x" })).toBe("echo \u00e9 ls -la x");
  });
  it("clé ABSENTE (jamais null) pour un outil sans cible ; une cible périmée est retirée", () => {
    const a = { tool_name: "inconnu", arguments: { x: 1 } } as unknown as Approval;
    expect("target" in withTarget(a)).toBe(false);
    expect("target" in withTarget({ ...a, target: "vieux" } as Approval)).toBe(false);
  });
  it("200 caractères au plus (visibles) ; une carte sans cible reste telle quelle", () => {
    expect([...approvalTargetOf("terminal", { command: "x".repeat(500) })]).toHaveLength(200);
    expect([...approvalTargetOf("terminal", { command: "\u{1F600}".repeat(300) })]).toHaveLength(200);
    const a = { tool_name: "inconnu", arguments: {} } as unknown as Approval;
    expect(withTarget(a)).toBe(a);
    expect(withTarget({ tool_name: "terminal", arguments: { command: "ls" } } as unknown as Approval).target).toBe("ls");
  });
});
