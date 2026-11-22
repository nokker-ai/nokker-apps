import { describe, expect, it } from "vitest";
import type { NokkerEvent } from "@nokker-apps/sdk";
import { LIVE_WINDOW, applyToolEvent, formatToolLine, liveLines, previewLines, stripEnvelope, toolTarget, type ToolLine } from "../src/toolview.js";
import { approvalTarget, cardChoices, choiceToDecision, choicesLegend, decisionSummary, formatRemaining, localChoices, reasonText, remainingSeconds, resolveEffect } from "../src/approval-model.js";
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
    // delegate : le but des tâches (sinon la carte affiche « Cible : » vide)
    expect(toolTarget("delegate", { tasks: [{ goal: "count lines" }], background: true })).toBe("count lines");
    expect(toolTarget("delegate", { tasks: [{ goal: "a" }, { goal: "b" }] })).toBe("a (+1)");
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
    // Le noyau donne la cible lisible et caviardée (`target`) : elle prime ; sans elle, la logique locale reste le repli.
    expect(approvalTarget({ ...card(), target: "rm -rf build  # nettoyage" } as Approval)).toBe("rm -rf build  # nettoyage");
    expect(approvalTarget({ ...card(), target: "   " } as Approval)).toBe("rm -rf build");
    expect(approvalTarget({ ...card(), target: { command: "x" } } as unknown as Approval)).toBe("rm -rf build"); // jamais un objet
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

describe("enveloppe du noyau masquée à l'affichage (ticket T4)", () => {
  const pytest = '{"returncode": 0}\n<untrusted-data kind="terminal:output" id="9f2c1a">\n===== 7 passed in 0.12s =====\n</untrusted-data id="9f2c1a">';
  it("les lignes de balise disparaissent, le contenu reste intact", () => {
    expect(stripEnvelope(pytest)).toBe('{"returncode": 0}\n===== 7 passed in 0.12s =====');
    expect(previewLines(pytest)).toEqual(['{"returncode": 0}', "===== 7 passed in 0.12s ====="]);
    expect(stripEnvelope('a <untrusted-data kind="x" id="1">b</untrusted-data id="1"> c')).toBe("a b c");
    expect(stripEnvelope("pas d'enveloppe\n<div>html</div>")).toBe("pas d'enveloppe\n<div>html</div>");
    expect(stripEnvelope("[balise retirée] reste")).toBe("[balise retirée] reste");
  });
  it("aperçu d'un tool.result terminal sans enveloppe", () => {
    const lines = applyToolEvent(applyToolEvent([], call("c1", "terminal", { command: "pytest -q" })), result("c1", "terminal", true, 900, pytest));
    expect(previewLines(lines[0]!.preview).join("\n")).not.toContain("untrusted-data");
    expect(lines[0]!.preview).toContain("7 passed"); // la donnée elle-même n'est pas touchée
  });
});

describe("carte du terminal : ordre fixe, légende, motif (ticket T5)", () => {
  const card = (command: string): Approval =>
    ({ tool_name: "terminal", arguments: { command }, strength: "standard", suggested_rules: [`terminal(${command})`], suggested_rule_kinds: ["exact"] }) as unknown as Approval;
  it("commande de test : Une fois en premier partout (CLI, VS Code, ACP) ; l'ordre inverse seulement sur demande", () => {
    expect(cardChoices(card("pytest -q")).map((c) => [c.key, c.id])).toEqual([["1", "once"], ["2", "session"], ["3", "always"], ["4", "reject"]]);
    expect(localChoices(card("pytest -q")).map((c) => c.id)).toEqual(["once", "session", "always", "reject"]);
    expect(localChoices(card("pytest -q"), { sessionFirstForTests: true }).map((c) => c.id)).toEqual(["session", "once", "always", "reject"]);
  });
  it("légende construite d'après les choix", () => {
    expect(choicesLegend(cardChoices(card("pytest -q")), "4:59")).toBe("choose: 1/a once · 2/s this session · 3 always · 4/r reject\nor ↑/↓; then Enter · expires in 4:59");
  });
  it("motifs du noyau reformulés ; motif inconnu inchangé", () => {
    expect(reasonText("mode accept_edits : \u00e9criture demand\u00e9e", "terminal")).toBe("File edits go through without asking, but a command that can change files waits for your OK.");
    expect(reasonText("mode default : \u00e9criture demand\u00e9e", "terminal")).toBe("In this mode, every change and every command waits for your OK.");
    expect(reasonText("r\u00e8gle ask terminal(git push*)", "terminal")).toBe("Your settings ask for your OK on terminal(git push*).");
    expect(reasonText("Commande destructive.", "terminal")).toBe("Commande destructive.");
  });
});

describe("chemins du bac à sable affichés en chemins locaux (ajout T4)", () => {
  it("/workspace/… → dossier local (~ pour le dossier personnel) ; rien sans session ; pas de faux amis", async () => {
    const { homedir } = await import("node:os");
    const { displayPath, setWorkspaceView } = await import("../src/toolview.js");
    try {
      expect(displayPath("/workspace/calc.py")).toBe("/workspace/calc.py"); // aucune session : inchangé
      setWorkspaceView(`${homedir()}/nokker/calc`);
      expect(displayPath("/workspace/calc.py")).toBe("~/nokker/calc/calc.py");
      expect(displayPath("/workspace")).toBe("~/nokker/calc");
      expect(displayPath('File "/workspace/tests/test_calc.py", line 3')).toBe('File "~/nokker/calc/tests/test_calc.py", line 3');
      expect(displayPath("cd /workspace && pytest")).toBe("cd ~/nokker/calc && pytest");
      expect(displayPath("/workspaces/x /data/workspace/y")).toBe("/workspaces/x /data/workspace/y");
      expect(toolTarget("read_file", { path: "/workspace/src/a.py" })).toBe("~/nokker/calc/src/a.py");
      expect(previewLines("/workspace/calc.py:3: E1 error")).toEqual(["~/nokker/calc/calc.py:3: E1 error"]);
      setWorkspaceView("/srv/projets/calc");
      expect(displayPath("/workspace/calc.py")).toBe("/srv/projets/calc/calc.py");
      // Montage rendu par le noyau (`workspace`) : c'est lui qui est traduit, plus le /workspace supposé.
      setWorkspaceView("/srv/projets/calc", "/sandbox/ws");
      expect(displayPath("/sandbox/ws/calc.py")).toBe("/srv/projets/calc/calc.py");
      expect(displayPath("/workspace/calc.py")).toBe("/workspace/calc.py");
      // `workspace: null` : pas de montage, chemins déjà réels, rien n'est traduit.
      setWorkspaceView("/srv/projets/calc", null);
      expect(displayPath("/workspace/calc.py")).toBe("/workspace/calc.py");
    } finally {
      setWorkspaceView(null);
    }
    expect(displayPath("/workspace/calc.py")).toBe("/workspace/calc.py");
  });
});

describe("appel refusé d'emblée (status: refused)", () => {
  const refused = (id: string, extra: Record<string, unknown>): NokkerEvent =>
    ({ type: "tool.result", thread_id: "th_1", turn_id: "th_1:0", call_id: id, name: "terminal", is_error: true, ms: 23, preview: "refused", ...extra }) as NokkerEvent;
  it("status refused : ✗ et la raison courte, pas « ✓ … 23 ms »", () => {
    let lines = applyToolEvent([], call("r1", "terminal", { command: "ls" }, "destructive"));
    lines = applyToolEvent(lines, refused("r1", { status: "refused", reason: "permissions:no_code_session" }));
    expect(formatToolLine(lines[0]!)).toBe("✗ terminal ls — refused: no code session open");
  });
  it("même sans status (noyau plus ancien) : is_error + reason permissions: = refus", () => {
    let lines = applyToolEvent([], call("r2", "terminal", { command: "ls" }));
    lines = applyToolEvent(lines, refused("r2", { reason: "permissions:plan_mode" }));
    expect(formatToolLine(lines[0]!)).toBe("✗ terminal ls — refused: plan mode: read-only");
  });
  it("refus par la personne sur la carte (reason declined) : « refused by you », sans « refused: » devant", () => {
    let lines = applyToolEvent([], call("r4", "terminal", { command: "rm -rf build" }, "destructive"));
    lines = applyToolEvent(lines, refused("r4", { status: "refused", reason: "declined" }));
    expect(formatToolLine(lines[0]!)).toBe("✗ terminal rm -rf build — refused by you");
  });
  it("une erreur ordinaire garde « ✗ … ms »", () => {
    let lines = applyToolEvent([], call("r3", "terminal", { command: "false" }));
    lines = applyToolEvent(lines, refused("r3", { reason: undefined, status: "error" }));
    expect(formatToolLine(lines[0]!)).toBe("✗ terminal false 23 ms");
  });
});
