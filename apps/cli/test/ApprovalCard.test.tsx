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
const arm = (): Promise<void> => new Promise((r) => setTimeout(r, 700)); // > CARD_ARM_MS (600 ms de silence)
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
    expect(f).toContain("1. Once (a)");
    expect(f).toContain("2. For this session (s)");
    expect(f).toContain("4. Reject (r)");
    expect(f).toContain("choose: 1/a once · 2/s this session · 3/3b always · 4/r reject");
    expect(f).toMatch(/or ↑\/↓; then Enter · expires in \d/);
  });

  it("libellés d'après suggested_rule_kinds (noyau du 01.11) : terminal, fichier, delegate (outil seulement)", () => {
    const term = render(<ApprovalCard approval={{ ...base, suggested_rule_kinds: ["exact", "prefix"] }} local busy={false} message={null} />).lastFrame()!;
    expect(term).toContain("2. This exact command for this session");
    expect(term).toContain("3. Always this exact command");
    expect(term).toContain("3b. Always commands starting with “rm -rf”");
    const file = { ...base, tool_name: "write_file", arguments: { path: "src/a.py" }, effect: "write", suggested_rules: ["write_file(src/a.py)", "write_file(src/**)"], suggested_rule_kinds: ["file", "dir"] as Approval["suggested_rule_kinds"] };
    const ff = render(<ApprovalCard approval={file} local busy={false} message={null} />).lastFrame()!;
    expect(ff).toContain("2. This file for this session");
    expect(ff).toContain("3. Always this file");
    expect(ff).toContain("3b. Always this folder");
    const del = { ...base, tool_name: "delegate", arguments: { goal: "audit" }, effect: "write", suggested_rules: ["delegate"], suggested_rule_kinds: ["tool"] as Approval["suggested_rule_kinds"] };
    const df = render(<ApprovalCard approval={del} local busy={false} message={null} />).lastFrame()!;
    expect(df).toContain("2. This tool for this session");
    expect(df).toContain("3. Always this tool");
    expect(df).not.toContain("file");
    expect(df).not.toContain("3b.");
    // Sans le champ (noyau plus ancien) : « Always this file (rule) » d'avant pour un outil autre que terminal.
    const old = render(<ApprovalCard approval={{ ...del, suggested_rule_kinds: undefined }} local busy={false} message={null} />).lastFrame()!;
    expect(old).toContain("3. Always this file (rule)");
    setLang("fr");
    try {
      const fr = render(<ApprovalCard approval={del} local busy={false} message={null} />).lastFrame()!;
      expect(fr).toContain("2. Cet outil pour cette session");
      expect(fr).toContain("3. Toujours cet outil");
    } finally {
      setLang("en");
    }
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

  it("SÉCURITÉ : une Entrée et un texte tapés pour le composeur n'approuvent rien, à l'apparition comme plus tard", async () => {
    // Répétition du 07.11 : la carte « python -m pytest » (1. Pour cette session) a été approuvée par l'Entrée d'un
    // message envoyé au même instant ; au banc, « salut » l'approuvait aussi par sa première lettre.
    const a = { ...base, effect: "write" as const, arguments: { command: "python -m pytest" }, suggested_rules: ["terminal(python -m pytest)"] };
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={a} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    const typeFast = async (text: string): Promise<void> => {
      for (const ch of text) {
        r.stdin.write(ch);
        await tick();
      }
    };
    r.stdin.write("\r"); // la même frappe que le composeur, à l'instant de la carte
    await tick();
    await typeFast("salut a tous\r");
    expect(onLocalDecision).not.toHaveBeenCalled();
    await arm(); // la carte est affichée depuis longtemps : un texte tapé ensuite n'approuve rien non plus
    await typeFast("salut\r");
    await typeFast("as\r");
    expect(onLocalDecision).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain("Choose with a, s, r or 1-4");
  });

  it("choisir ne décide pas ; Entrée confirme seulement après le silence", async () => {
    for (const [key, expected] of [["a", ["approve", "once", undefined]], ["s", ["approve", "session", "terminal(rm -rf build)"]], ["r", ["reject", "once", undefined]], ["4", ["reject", "once", undefined]]] as const) {
      const onLocalDecision = vi.fn();
      const r = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
      await arm();
      r.stdin.write(key);
      await tick();
      expect(onLocalDecision).not.toHaveBeenCalled();
      r.stdin.write("\r"); // trop tôt après le choix
      await tick();
      expect(onLocalDecision).not.toHaveBeenCalled();
      await arm();
      r.stdin.write("\r");
      await tick();
      expect(onLocalDecision).toHaveBeenLastCalledWith(...expected);
    }
  });

  it("utilisateur rapide : « a » puis Entrée ~300 ms plus tard approuve (la carte est affichée depuis plus de 600 ms)", async () => {
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await arm();
    r.stdin.write("a");
    await new Promise((res) => setTimeout(res, 300)); // > CARD_KEY_GAP_MS (250 ms), < 600 ms
    r.stdin.write("\r");
    await tick();
    expect(onLocalDecision).toHaveBeenCalledTimes(1);
    expect(onLocalDecision).toHaveBeenLastCalledWith("approve", "once", undefined);
  });

  it("SÉCURITÉ : « a » puis Entrée en rafale (< 250 ms), ou avant 600 ms d'affichage, ne décide rien", async () => {
    const early = vi.fn();
    const r1 = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={early} />);
    await arm();
    r1.stdin.write("a");
    await new Promise((res) => setTimeout(res, 100));
    r1.stdin.write("\r");
    await tick();
    expect(early).not.toHaveBeenCalled();
    // Carte toute neuve : un choix puis une Entrée à 300 ms de son apparition ne décident pas non plus.
    const fresh = vi.fn();
    const r2 = render(<ApprovalCard approval={{ ...base, id: "appr_2" }} local busy={false} message={null} onLocalDecision={fresh} />);
    r2.stdin.write("a");
    await new Promise((res) => setTimeout(res, 300));
    r2.stdin.write("\r");
    await tick();
    expect(fresh).not.toHaveBeenCalled();
  });

  it("un collage multi-caractères (« a⏎ », « salut ») n'est pas un choix et efface le choix déjà fait", async () => {
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await arm();
    r.stdin.write("s");
    await tick();
    expect(r.lastFrame()).toMatch(/› 2\. For this session/);
    r.stdin.write("a\r"); // un seul bloc, comme un collage
    await arm();
    r.stdin.write("\r");
    await tick();
    expect(onLocalDecision).not.toHaveBeenCalled();
    expect(r.lastFrame()).not.toMatch(/›/);
  });

  it("une frappe étrangère efface le choix", async () => {
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await arm();
    r.stdin.write("a");
    await tick();
    expect(r.lastFrame()).toMatch(/› 1\. Once/);
    r.stdin.write("z");
    await arm();
    r.stdin.write("\r");
    await tick();
    expect(onLocalDecision).not.toHaveBeenCalled();
    expect(r.lastFrame()).not.toMatch(/›/);
  });

  it("3 montre la règle exacte AVANT de valider ; Entrée (après le silence) écrit celle-là", async () => {
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await arm();
    r.stdin.write("3");
    await tick();
    expect(onLocalDecision).not.toHaveBeenCalled();
    expect(r.lastFrame()).toContain("terminal(rm -rf build)");
    r.stdin.write("b");
    await tick();
    expect(r.lastFrame()).toContain("terminal(rm -rf*)");
    await arm();
    r.stdin.write("\r");
    await tick();
    expect(onLocalDecision).toHaveBeenCalledWith("approve", "always", "terminal(rm -rf*)");
  });

  it("↑/↓ puis Entrée ; Échap ne décide pas", async () => {
    const onLocalDecision = vi.fn();
    const { stdin } = render(<ApprovalCard approval={base} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await arm();
    stdin.write("\u001B");
    await tick();
    expect(onLocalDecision).not.toHaveBeenCalled();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await arm();
    stdin.write("\r");
    await tick();
    expect(onLocalDecision).toHaveBeenCalledWith("approve", "session", "terminal(rm -rf build)");
  });

  it("carte standard distante : p choisit, Entrée confirme après le silence ; un texte n'approuve rien", async () => {
    const onApproveByPhone = vi.fn();
    const { stdin } = render(<ApprovalCard approval={base} busy={false} message={null} onApproveByPhone={onApproveByPhone} />);
    for (const ch of "pour info\r") {
      stdin.write(ch);
      await tick();
    }
    await arm();
    stdin.write("\r");
    await tick();
    expect(onApproveByPhone).not.toHaveBeenCalled();
    stdin.write("p");
    await arm();
    stdin.write("\r");
    await tick();
    expect(onApproveByPhone).toHaveBeenCalledTimes(1);
  });

  it("carte forte d'une session locale : seulement Une fois / Refuser (le noyau répond 400 sinon)", () => {
    const { lastFrame } = render(<ApprovalCard approval={{ ...base, strength: "strong", suggested_rules: [] }} local busy={false} message={null} />);
    const f = lastFrame()!;
    expect(f).toContain("1. Once (a)");
    expect(f).toContain("4. Reject (r)");
    expect(f).toContain("choose: 1/a once · 4/r reject");
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

  it("commande de test (ticket T5a) : même ordre que la légende, « Une fois » en premier ; a = 1, s = 2", async () => {
    const a = { ...base, effect: "write" as const, strength: "standard" as const, arguments: { command: "pytest -q tests/" }, suggested_rules: ["terminal(pytest -q tests/)", "terminal(pytest -q*)"], suggested_rule_kinds: ["exact", "prefix"] as Approval["suggested_rule_kinds"] };
    for (const [key, expected] of [["1", ["approve", "once", undefined]], ["a", ["approve", "once", undefined]], ["2", ["approve", "session", "terminal(pytest -q tests/)"]], ["s", ["approve", "session", "terminal(pytest -q tests/)"]]] as const) {
      const onLocalDecision = vi.fn();
      const r = render(<ApprovalCard approval={a} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
      await tick();
      expect(r.lastFrame()!).toMatch(/1\. Once \(a\)[\s\S]*2\. This exact command for this session \(s\)[\s\S]*3\. Always[\s\S]*4\. Reject \(r\)/);
      await arm();
      r.stdin.write(key);
      await tick();
      expect(onLocalDecision).not.toHaveBeenCalled(); // un chiffre ou une lettre ne décide jamais
      await arm();
      r.stdin.write("\r");
      await tick();
      expect(onLocalDecision).toHaveBeenLastCalledWith(...expected);
    }
  });

  it("motif du noyau en clair (ticket T5c) : plus de « mode accept_edits : écriture demandée »", () => {
    setLang("fr");
    try {
      const a = { ...base, effect: "write" as const, arguments: { command: "python -m pytest" }, rule: "permissions:accept_edits", reason: "mode accept_edits : \u00e9criture demand\u00e9e", suggested_rules: ["terminal(python -m pytest)"] };
      const f = render(<ApprovalCard approval={a} local busy={false} message={null} />).lastFrame()!;
      expect(f).not.toContain("accept_edits");
      expect(f).toContain("attend ton accord");
      expect(f).toContain("choisis : 1/a une fois · 2/s cette session · 3 toujours · 4/r refuser");
    } finally {
      setLang("en");
    }
  });

  it("commande hors test : ordre inchangé (1 = une fois, 2 = session)", async () => {
    const a = { ...base, effect: "write" as const, strength: "standard" as const, arguments: { command: "make build" }, suggested_rules: ["terminal(make build)"] };
    const onLocalDecision = vi.fn();
    const r = render(<ApprovalCard approval={a} local busy={false} message={null} onLocalDecision={onLocalDecision} />);
    await tick();
    expect(r.lastFrame()).toMatch(/1\. Once[\s\S]*2\. For this session/);
    await arm();
    r.stdin.write("s");
    await arm();
    r.stdin.write("\r");
    await tick();
    expect(onLocalDecision).toHaveBeenLastCalledWith("approve", "session", "terminal(make build)");
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
