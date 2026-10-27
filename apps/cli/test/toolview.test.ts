import { describe, expect, it } from "vitest";
import type { NokkerEvent } from "@nokker-apps/sdk";
import { LIVE_WINDOW, applyToolEvent, formatToolLine, liveLines, previewLines, toolTarget, type ToolLine } from "../src/toolview.js";
import { approvalTarget, choiceToDecision, decisionSummary, formatRemaining, localChoices, remainingSeconds, resolveEffect } from "../src/approval-model.js";
import type { Approval } from "@nokker-apps/sdk";

const call = (id: string, name: string, args: Record<string, unknown>, effect = "write"): NokkerEvent =>
  ({ type: "tool.call", thread_id: "th_1", turn_id: "th_1:0", call_id: id, name, effect, args }) as NokkerEvent;
const result = (id: string, name: string, ok = true, ms = 120, preview = "a\nb\nc\nd"): NokkerEvent =>
  ({ type: "tool.result", thread_id: "th_1", turn_id: "th_1:0", call_id: id, name, is_error: !ok, ms, preview }) as NokkerEvent;

const delta = (id: string, seq: number, text: string, extra: Record<string, unknown> = {}): NokkerEvent =>
  ({ type: "tool.input.delta", thread_id: "th_1", turn_id: "th_1:0", call_id: id, name: "write_file", seq, text, ...extra }) as NokkerEvent;
const done = (turn = "th_1:0"): NokkerEvent =>
  ({ type: "turn.done", thread_id: "th_1", turn_id: turn, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) as NokkerEvent;

describe("écriture en direct (X22)", () => {
  it("le premier delta crée la ligne, les suivants défilent ; tool.call complète sans doublon ; tool.result replie", () => {
    let lines: ToolLine[] = applyToolEvent([], delta("c1", 0, "", { path: "index.html", field: "content" }));
    expect(formatToolLine(lines[0]!)).toBe("⟳ write_file index.html (write)");
    const body = Array.from({ length: 10 }, (_, i) => `ligne ${i + 1}\n`).join("");
    lines = applyToolEvent(lines, delta("c1", 1, body.slice(0, 40)));
    lines = applyToolEvent(lines, delta("c1", 1, "doublon ignoré"));
    lines = applyToolEvent(lines, delta("c1", 2, body.slice(40)));
    expect(liveLines(lines[0]!)).toEqual(["ligne 5", "ligne 6", "ligne 7", "ligne 8", "ligne 9", "ligne 10"]);
    expect(liveLines(lines[0]!).length).toBe(LIVE_WINDOW);
    lines = applyToolEvent(lines, call("c1", "write_file", { path: "index.html", content: "…" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.called).toBe(true);
    expect(liveLines(lines[0]!)).toHaveLength(LIVE_WINDOW); // en attente d'exécution (ou de carte) : toujours visible
    lines = applyToolEvent(lines, result("c1", "write_file"));
    expect(liveLines(lines[0]!)).toEqual([]);
    expect(formatToolLine(lines[0]!)).toBe("✓ write_file index.html 120 ms");
  });

  it("lignes coupées à la largeur ; truncated fige le bloc", () => {
    let lines = applyToolEvent([], delta("c1", 0, "x".repeat(50) + "\n", { path: "a.html" }));
    expect(liveLines(lines[0]!, 6, 10)).toEqual(["xxxxxxxxx…"]);
    lines = applyToolEvent(lines, delta("c1", 1, "", { truncated: true }));
    expect(lines[0]!.truncated).toBe(true);
    expect(applyToolEvent(lines, delta("c1", 2, "plus\n"))).toBe(lines);
  });

  it("discarded retire une ligne jamais appelée ; turn.done replie et retire les lignes sans tool.call", () => {
    let lines = applyToolEvent([], delta("c1", 0, "a\n", { path: "a.py" }));
    lines = applyToolEvent(lines, delta("c1", 1, "", { discarded: true }));
    expect(lines).toEqual([]);
    lines = applyToolEvent([], call("c0", "read_file", { path: "x" }, "read"));
    lines = applyToolEvent(lines, delta("c2", 0, "b\n", { path: "b.py", name: "patch", field: "new_string" }));
    lines = applyToolEvent(lines, delta("c3", 0, "c\n", { path: "c.py" }));
    lines = applyToolEvent(lines, call("c3", "write_file", { path: "c.py" }));
    expect(applyToolEvent(lines, done("th_1:7"))).toBe(lines);
    lines = applyToolEvent(lines, done());
    expect(lines.map((l) => l.callId)).toEqual(["c0", "c3"]);
    expect(lines.every((l) => liveLines(l).length === 0)).toBe(true);
  });
});

describe("lignes d'outil", () => {
  it("⟳ avec l'effet en clair puis ✓ avec la durée", () => {
    let lines: ToolLine[] = applyToolEvent([], call("c1", "patch", { path: "src/app.py" }));
    expect(formatToolLine(lines[0]!)).toBe("⟳ patch src/app.py (write)");
    lines = applyToolEvent(lines, result("c1", "patch"));
    expect(formatToolLine(lines[0]!)).toBe("✓ patch src/app.py 120 ms");
  });

  it("relie par call_id, pas par nom : deux terminal simultanés", () => {
    let lines = applyToolEvent([], call("c1", "terminal", { command: "pytest -q" }));
    lines = applyToolEvent(lines, call("c2", "terminal", { command: "rm -rf build" }, "destructive"));
    lines = applyToolEvent(lines, result("c1", "terminal", true, 480));
    expect(lines.map((l) => l.ok)).toEqual([true, null]);
    expect(formatToolLine(lines[1]!)).toBe("⟳ terminal rm -rf build (destructive)");
    lines = applyToolEvent(lines, result("c2", "terminal", false, 0));
    expect(lines[1]!.ok).toBe(false);
    expect(formatToolLine(lines[1]!).startsWith("✗")).toBe(true);
  });

  it("aperçu : 3 lignes au plus", () => {
    const lines = applyToolEvent(applyToolEvent([], call("c1", "x", {})), result("c1", "x"));
    expect(previewLines(lines[0]!.preview)).toEqual(["a", "b", "c"]);
  });

  it("ancien noyau (args_preview, sans effet) : affichable", () => {
    const lines = applyToolEvent([], { type: "tool.call", thread_id: "t", turn_id: "t:0", call_id: "k", name: "web_search", args_preview: "{\"q\":1}" } as NokkerEvent);
    expect(formatToolLine(lines[0]!)).toContain("web_search");
  });

  it("cible : la commande pour terminal", () => {
    expect(toolTarget("terminal", { command: "ls -la" })).toBe("ls -la");
    expect(toolTarget("search_files", { pattern: "def add", path: "src" })).toBe("src");
  });
});

const card = (over: Partial<Approval> = {}): Approval => ({
  id: "appr_1", thread_id: "th_1", turn_index: 0, channel: "cli", tool_name: "terminal", arguments: { command: "rm -rf build" },
  args_sha256: "", effect: "destructive", rule: "effect:destructive", reason: "r", advice: null, strength: "standard", status: "pending",
  created_at: "", expires_at: new Date(Date.now() + 300_000).toISOString(), decided_by: null, decided_via: null, decided_at: null,
  result_summary: null, error: null, suggested_rules: ["terminal(rm -rf build)", "terminal(rm -rf*)"], ...over,
});

describe("modèle de la carte locale", () => {
  it("1 · 2 · 3 · 3b · 4 sur une carte locale", () => {
    expect(localChoices(card()).map((c) => c.key)).toEqual(["1", "2", "3", "3b", "4"]);
  });
  it("carte forte : Une fois / Refuser seulement ; sans règle proposée : pas de 3", () => {
    expect(localChoices(card({ strength: "strong" })).map((c) => c.key)).toEqual(["1", "4"]);
    expect(localChoices(card({ suggested_rules: [] })).map((c) => c.key)).toEqual(["1", "2", "4"]);
  });
  it("décisions et résumés", () => {
    expect(choiceToDecision("session")).toEqual({ decision: "approve", scope: "session" });
    expect(choiceToDecision("reject")).toEqual({ decision: "reject", scope: "once" });
    expect(approvalTarget(card())).toBe("rm -rf build");
    expect(decisionSummary(card(), "approved", "always", "terminal(rm -rf*)")).toContain("terminal(rm -rf*)");
    expect(decisionSummary(card(), "expired")).toContain("expired");
    expect(remainingSeconds(card())).toBeGreaterThan(290);
    expect(remainingSeconds(card({ expires_at: new Date(Date.now() - 5000).toISOString() }))).toBe(0);
  });

  it("effet d'une carte à effect null : celui du tool.call (même outil, mêmes args), sinon la règle, sinon null", () => {
    const lines: ToolLine[] = [
      { callId: "a", name: "terminal", args: { command: "ls" }, effect: "read", ok: true, ms: 1, preview: null, depth: 0 },
      { callId: "b", name: "terminal", args: { command: "pytest -q" }, effect: "write", ok: null, ms: null, preview: null, depth: 0 },
    ];
    const c = card({ effect: null, tool_name: "terminal", arguments: { command: "pytest -q" }, rule: "permissions:accept_edits" });
    expect(resolveEffect(c, lines)).toBe("write");
    expect(resolveEffect(card({ effect: null, arguments: { command: "autre" } }), lines)).toBe("write"); // dernier appel en cours du même outil
    expect(resolveEffect(card({ effect: null, rule: "permissions:accept_edits", tool_name: "x" }), [])).toBe("write");
    expect(resolveEffect(card({ effect: null, rule: "effect:spend", tool_name: "x" }), [])).toBe("spend");
    expect(resolveEffect(card({ effect: null, rule: "autre", tool_name: "x" }), [])).toBeNull();
    expect(resolveEffect(card({ effect: "destructive" }), lines)).toBe("destructive");
  });

  it("compte à rebours : 24 h, 59 min, mm:ss", () => {
    expect(formatRemaining(86400)).toBe("24 h");
    expect(formatRemaining(3599)).toBe("59 min");
    expect(formatRemaining(3540)).toBe("59 min");
    expect(formatRemaining(599)).toBe("9:59");
    expect(formatRemaining(300)).toBe("5:00");
    expect(formatRemaining(0)).toBe("0:00");
  });
});

describe("carte posée par le modèle (LOKKAL.md §7.4.9)", () => {
  const pending = (id: string, appr: string): NokkerEvent =>
    ({ type: "tool.result", thread_id: "th_1", turn_id: "th_1:0", call_id: id, name: "terminal", is_error: false, ms: 0, preview: `EN ATTENTE D'APPROBATION HUMAINE (effect:write) [approval:${appr}]. L'action n'a pas été exécutée.` }) as NokkerEvent;
  const decided = (appr: string, decision: string): NokkerEvent =>
    ({ type: "approval.decided", approval_id: appr, decision, by: "local", via: "local" }) as NokkerEvent;

  it("en attente, approuvée, puis la vraie sortie de l'exécuteur (même call_id, approval_id)", () => {
    let lines = applyToolEvent([], call("c1", "terminal", { command: "pytest -q" }));
    lines = applyToolEvent(lines, pending("c1", "appr_1"));
    expect(lines[0]!.ok).toBeNull();
    expect(formatToolLine(lines[0]!)).toBe("⏸ terminal pytest -q (waiting for approval)");
    lines = applyToolEvent(lines, done());
    expect(lines).toHaveLength(1); // la fin du tour qui a posé la carte ne la retire pas
    lines = applyToolEvent(lines, decided("appr_1", "approved"));
    expect(formatToolLine(lines[0]!)).toBe("⟳ terminal pytest -q (approved, running…)");
    lines = applyToolEvent(lines, { type: "tool.result", thread_id: "th_1", turn_id: "th_1:0", call_id: "c1", approval_id: "appr_1", name: "terminal", ok: true, is_error: false, ms: 480, preview: "1 passed" } as NokkerEvent);
    expect(formatToolLine(lines[0]!)).toBe("✓ terminal pytest -q 480 ms");
    expect(lines[0]!.preview).toBe("1 passed");
    expect(lines[0]!.approvalId).toBeNull();
  });

  it("refusée ou expirée : la ligne se ferme sans tool.result", () => {
    let lines = applyToolEvent([], call("c1", "terminal", { command: "rm -rf build" }));
    lines = applyToolEvent(lines, pending("c1", "appr_2"));
    expect(applyToolEvent(lines, decided("appr_x", "rejected"))).toBe(lines);
    const rejected = applyToolEvent(lines, decided("appr_2", "rejected"));
    expect(formatToolLine(rejected[0]!)).toBe("✗ terminal rm -rf build");
    expect(rejected[0]!.preview).toBe("rejected — not run");
    expect(applyToolEvent(lines, decided("appr_2", "expired"))[0]!.preview).toBe("approval expired — not run");
  });
});
