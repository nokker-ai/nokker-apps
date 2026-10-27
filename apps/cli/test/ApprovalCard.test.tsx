import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { Approval } from "@nokker-apps/sdk";
import { ApprovalCard } from "../src/ui/ApprovalCard.js";
import { setLang } from "../src/i18n/index.js";

const base: Approval = {
  id: "appr_1", thread_id: "th_1", turn_index: 0, channel: "cli", tool_name: "terminal", arguments: { command: "rm -rf build" },
  args_sha256: "", effect: "destructive", rule: "effect:destructive", reason: "Commande destructive.", advice: null, strength: "standard",
  status: "pending", created_at: "", expires_at: new Date(Date.now() + 300_000).toISOString(), decided_by: null, decided_via: null,
  decided_at: null, result_summary: null, error: null, suggested_rules: ["terminal(rm -rf build)", "terminal(rm -rf*)"],
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const DOWN = "\u001B[B";

describe("ApprovalCard locale", () => {
  it("affiche le cadre, l'outil, l'effet, la commande et les choix", () => {
    const f = render(<ApprovalCard approval={base} local busy={false} message={null} />).lastFrame()!;
    expect(f).toContain("⚠ Action to approve");
    expect(f).toContain("Tool terminal · effect destructive");
    expect(f).toContain("Command: rm -rf build");
    expect(f).toContain("1. Once");
    expect(f).toContain("2. For this session");
    expect(f).toContain("3. Always this command");
    expect(f).toContain("3b. Always commands starting with");
    expect(f).toContain("4. Reject");
    expect(f).toMatch(/↑\/↓ or 1-4 · Enter validates · expires in \d/);
  });

  it("en français (langue posée par le test)", () => {
    setLang("fr");
    try {
      const f = render(<ApprovalCard approval={base} local busy={false} message={null} />).lastFrame()!;
      expect(f).toContain("Action à approuver");
      expect(f).toContain("terminal");
      expect(f).toContain("destructif");
      expect(f).toContain("rm -rf build");
      expect(f).toContain("1. Une fois");
      expect(f).toContain("2. Pour cette session");
      expect(f).toContain("3. Toujours cette commande");
      expect(f).toContain("3b. Toujours les commandes");
      expect(f).toContain("4. Refuser");
    } finally {
      setLang("en");
    }
  });

  it("un chiffre décide (1 = une fois, 4 = refuser)", async () => {
    const onLocalDecision = vi.fn();
    const { stdin } = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await tick();
    stdin.write("1");
    await tick();
    expect(onLocalDecision).toHaveBeenLastCalledWith("approve", "once", undefined);
    stdin.write("4");
    await tick();
    expect(onLocalDecision).toHaveBeenLastCalledWith("reject", "once", undefined);
  });

  it("3 montre la règle exacte AVANT de valider ; Entrée écrit celle-là", async () => {
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await tick();
    r.stdin.write("3");
    await tick();
    expect(onLocalDecision).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain("terminal(rm -rf build)");
    r.stdin.write("b");
    await tick();
    expect(r.lastFrame()).toContain("terminal(rm -rf*)");
    r.stdin.write("\r");
    await tick();
    expect(onLocalDecision).toHaveBeenCalledWith("approve", "always", "terminal(rm -rf*)");
  });

  it("↑/↓ + Entrée ; Échap ne décide pas", async () => {
    const onLocalDecision = vi.fn();
    const { stdin } = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await tick();
    stdin.write("\u001B");
    await tick();
    expect(onLocalDecision).not.toHaveBeenCalled();
    stdin.write(DOWN);
    await tick();
    stdin.write("\r");
    await tick();
    expect(onLocalDecision).toHaveBeenCalledWith("approve", "session", undefined);
  });

  it("carte forte d'une session locale : seulement Une fois / Refuser (le noyau répond 400 sinon)", () => {
    const { lastFrame } = render(<ApprovalCard approval={{ ...base, strength: "strong", suggested_rules: [] }} local busy={false} message={null} />);
    const f = lastFrame()!;
    expect(f).toContain("1. Once");
    expect(f).toContain("4. Reject");
    expect(f).not.toContain("2. For this session");
    expect(f).not.toContain("Always");
  });

  it("carte forte : pas de choix Toujours, « décider sur téléphone », aucune signature proposée", () => {
    const { lastFrame } = render(<ApprovalCard approval={{ ...base, strength: "strong" }} busy={false} message={null} />);
    const f = lastFrame()!;
    expect(f).toContain("phone");
    expect(f).not.toContain("Always");
    expect(f).not.toContain("[p]");
  });

  it("expiration : onExpired est appelé une fois", async () => {
    const onExpired = vi.fn();
    render(<ApprovalCard approval={{ ...base, expires_at: new Date(Date.now() + 1200).toISOString() }} local busy={false} message={null} onExpired={onExpired} />);
    await new Promise((r) => setTimeout(r, 2300));
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("commande de test : « Pour cette session » en premier, touche 1 = session", async () => {
    const a = { ...base, effect: "write" as const, strength: "standard" as const, arguments: { command: "pytest -q tests/" }, suggested_rules: ["terminal(pytest -q tests/)", "terminal(pytest -q*)"] };
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={a} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await tick();
    const f = r.lastFrame()!;
    expect(f).toMatch(/1\. For this session[\s\S]*2\. Once[\s\S]*3\. Always[\s\S]*4\. Reject/);
    r.stdin.write("1");
    await tick();
    expect(onLocalDecision).toHaveBeenLastCalledWith("approve", "session", undefined);
    r.stdin.write("2");
    await tick();
    expect(onLocalDecision).toHaveBeenLastCalledWith("approve", "once", undefined);
  });

  it("commande hors test : ordre inchangé (1 = une fois, 2 = session)", async () => {
    const a = { ...base, effect: "write" as const, strength: "standard" as const, arguments: { command: "make build" }, suggested_rules: ["terminal(make build)"] };
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={a} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await tick();
    expect(r.lastFrame()).toMatch(/1\. Once[\s\S]*2\. For this session/);
    r.stdin.write("2");
    await tick();
    expect(onLocalDecision).toHaveBeenLastCalledWith("approve", "session", undefined);
  });

  it("isTestCommand : motifs reconnus, faux amis non", async () => {
    const { isTestCommand } = await import("../src/approval-model.js");
    const t = (command: string, tool = "terminal") => isTestCommand({ ...base, tool_name: tool, arguments: { command } });
    for (const c of ["pytest -q", "python -m unittest", "npm test", "pnpm test -r", "yarn test", "go test ./...", "cargo test", "make test", "npx vitest run", "jest --ci"]) expect(t(c)).toBe(true);
    expect(t("rm -rf build")).toBe(false);
    expect(t("echo mypytestfile")).toBe(false);
    expect(t("pytest", "patch")).toBe(false);
  });
});
