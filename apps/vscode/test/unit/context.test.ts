/**
 * Pièces de contexte (tirées de l'éditeur, jamais inventées), barre d'état et notifications de cartes : logique pure.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_TERMINAL_LINES,
  TerminalLog,
  composeMessage,
  contextBlock,
  contextLabel,
  excerptAround,
  imageMentions,
  stripAnsi,
  tailOutput,
  type ContextItem,
  type DiagnosticsContext,
  type TerminalContext,
} from "../../src/context.js";
import { english, fromBundle } from "../../src/i18n.js";
import { LiveWrites, livePath } from "../../src/live.js";
import type { ViewCard } from "../../src/protocol.js";
import { cardNotification, mainModel, statusBar, EMPTY_STATUS } from "../../src/status.js";

const T = fromBundle(JSON.parse(readFileSync(join(__dirname, "..", "..", "l10n", "bundle.l10n.fr.json"), "utf-8")) as Record<string, string>);

describe("fichiers (@chemin) et images", () => {
  it("fichier enregistré = chemin lu par le noyau ; non enregistré = son texte ; image = pièce jointe par chemin", () => {
    const items: ContextItem[] = [
      { kind: "file", id: "1", relPath: "src/app.py", image: false },
      { kind: "file", id: "2", relPath: "src/draft.py", image: false, unsavedText: "x = 1", languageId: "python" },
      { kind: "file", id: "3", relPath: "docs/capture.png", image: true },
    ];
    const out = composeMessage("relis ça", items);
    expect(out.attachments).toEqual([{ path: "docs/capture.png" }]);
    expect(out.text).toBe("File `src/draft.py` with changes not saved yet in the editor:\n```python\nx = 1\n```\n\nrelis ça\n\n@src/app.py @docs/capture.png");
    expect(items.map((c) => contextLabel(c))).toEqual(["@src/app.py", "@src/draft.py", "@docs/capture.png"]);
    // Déjà cité dans le texte : pas répété ; images citées et jointes : sans doublon, 4 au plus.
    const again = composeMessage("vois @src/app.py et @docs/capture.png @a.png @b.png @c.png @d.png", items.filter((c) => c.id !== "2"));
    expect(again.text).toBe("vois @src/app.py et @docs/capture.png @a.png @b.png @c.png @d.png");
    expect(again.attachments.map((a) => ("path" in a ? a.path : ""))).toEqual(["docs/capture.png", "a.png", "b.png", "c.png"]);
  });

  it("images citées : jamais hors du dossier", () => {
    expect(imageMentions("regarde @capture.png et @docs/a.webp, pas @../x.png ni mail@x.png")).toEqual([{ path: "capture.png" }, { path: "docs/a.webp" }]);
  });
});

describe("problèmes du panneau Problèmes", () => {
  const diag: DiagnosticsContext = {
    kind: "diagnostics",
    id: "1",
    relPath: "src/app.py",
    languageId: "python",
    items: [
      { line: 2, column: 12, severity: "error", message: "\"b\" is not defined", source: "Pyright", code: "reportUndefinedVariable" },
      { line: 3, column: 1, severity: "warning", message: "unused\n  import" },
    ],
    excerpt: excerptAround(["def add(a):", "    return a + b", "import os", "x = 1", "y = 2", "z = 3"], [{ line: 2 }, { line: 3 }]),
  };
  it("lignes réelles du document autour des problèmes, numérotées ; message, source et code tels quels", () => {
    expect(diag.excerpt).toEqual({ startLine: 1, lines: ["def add(a):", "    return a + b", "import os", "x = 1", "y = 2"] });
    expect(contextLabel(diag)).toBe("Problems: src/app.py (2)");
    expect(contextBlock(diag)).toBe(
      [
        "Problems reported by the editor in `src/app.py`:",
        '- line 2, column 12 [error] "b" is not defined (Pyright reportUndefinedVariable)',
        "- line 3, column 1 [warning] unused import",
        "```python",
        "1 | def add(a):",
        "2 |     return a + b",
        "3 | import os",
        "4 | x = 1",
        "5 | y = 2",
        "```",
      ].join("\n"),
    );
    expect(contextBlock(diag, T)!.split("\n")[1]).toBe('- ligne 2, colonne 12 [erreur] "b" is not defined (Pyright reportUndefinedVariable)');
  });
});

describe("dernière sortie du terminal", () => {
  it("séquences ANSI et OSC de l'intégration du shell retirées, retours chariot repliés", () => {
    expect(stripAnsi("\u001b]633;C\u0007\u001b[32mok\u001b[0m 1 passed\r\n50%\r100%\n")).toBe("ok 1 passed\n100%\n");
  });
  it("dernières lignes seulement, et le dit", () => {
    const long = Array.from({ length: MAX_TERMINAL_LINES + 50 }, (_, i) => `ligne ${i}`).join("\n");
    const { text, cut } = tailOutput(long);
    expect(cut).toBe(true);
    expect(text.split("\n")).toHaveLength(MAX_TERMINAL_LINES);
    expect(text.endsWith(`ligne ${MAX_TERMINAL_LINES + 49}`)).toBe(true);
  });
  it("commande, code de sortie et sortie dans un bloc", () => {
    const log = new TerminalLog("pytest -q");
    log.append("\u001b[31mF\u001b[0m\n");
    log.append("1 failed\n");
    log.finish(1);
    const c: TerminalContext = { kind: "terminal", id: "1", name: "bash", commandLine: log.commandLine, exitCode: log.exitCode, output: log.output };
    expect(contextLabel(c)).toBe("Terminal bash: pytest -q");
    expect(contextBlock(c)).toBe("Last output of the terminal `bash` (command `pytest -q`, exit code 1):\n```\nF\n1 failed\n```");
    expect(contextBlock(c, T)).toBe("Dernière sortie du terminal `bash` (commande `pytest -q`, code de sortie 1) :\n```\nF\n1 failed\n```");
  });
});

describe("écriture en direct", () => {
  it("deltas accumulés par appel, seq déjà vu ignoré, fermé par le tool.result, abandon signalé", () => {
    const seen: string[] = [];
    const lw = new LiveWrites((v) => seen.push(`${v.callId}:${v.done ? "fin" : "en cours"}${v.discarded ? ":abandon" : ""}`));
    const d = (call: string, seq: number, text: string, extra: Record<string, unknown> = {}) =>
      ({ type: "tool.input.delta", thread_id: "th", turn_id: "th:0", call_id: call, name: "write_file", seq, text, path: "/workspace/src/a.py", field: "content", ...extra }) as const;
    lw.apply(d("c1", 0, ""));
    lw.apply(d("c1", 1, "a = 1\n"));
    lw.apply(d("c1", 1, "doublon\n"));
    lw.apply(d("c1", 2, "b = 2\n"));
    expect(lw.get("c1")).toMatchObject({ text: "a = 1\nb = 2\n", path: "/workspace/src/a.py", done: false });
    expect(livePath(lw.get("c1")!.path)).toBe("src/a.py");
    expect(lw.tail("c1", 1)).toEqual(["b = 2"]);
    lw.apply({ type: "tool.result", thread_id: "th", call_id: "c1", name: "write_file", is_error: false });
    expect(lw.get("c1")!.done).toBe(true);
    lw.apply(d("c2", 0, "x"));
    lw.apply(d("c2", 1, "", { discarded: true }));
    expect(lw.get("c2")).toMatchObject({ done: true, discarded: true });
    expect(seen).toEqual(["c1:en cours", "c1:en cours", "c1:en cours", "c1:fin", "c2:en cours", "c2:fin:abandon"]);
  });
});

describe("barre d'état et notifications", () => {
  const card = (choices: ViewCard["choices"], forwarded = false): ViewCard => ({
    id: "ap_1",
    tool: "terminal",
    target: "pytest -q",
    effect: "write",
    reason: "r",
    choices,
    forwarded,
    strongText: choices ? null : forwarded ? "Strong action: it waits for your phone." : "Strong action: decide it in the terminal (`nokker`).",
    expiresAt: "",
  });
  it("palier, modèle, coût du tour ; cartes en attente ; déconnecté", () => {
    expect(statusBar(english, { ...EMPTY_STATUS, connected: true, tier: "ship", model: "qwen", turnCost: "12.4k tokens · €0.03", cards: 2 }).text).toBe("Nokker · ship · qwen · 12.4k tokens · €0.03 $(bell) 2");
    expect(statusBar(english, { ...EMPTY_STATUS, connected: true, busy: true }).text).toBe("$(sync~spin) Nokker");
    expect(statusBar(T, EMPTY_STATUS).tooltip).toBe("Nokker : pas connecté au noyau local");
    expect(mainModel({ models: [{ model: "a", tiers: ["deep"], calls: 1, input_tokens: 1, cached_tokens: null, output_tokens: 1, reasoning_tokens: null, total_tokens: 2, cost: null, price_source: null }, { model: "b", tiers: ["ship"], calls: 1, input_tokens: 9, cached_tokens: null, output_tokens: 1, reasoning_tokens: null, total_tokens: 10, cost: null, price_source: null }] })).toEqual({ model: "b", tier: "ship" });
  });
  it("carte standard : Une fois · Pour cette session · Refuser ; carte forte : aucun bouton, où elle attend", () => {
    const std = card([
      { index: 0, id: "session", key: "1", label: "For this session" },
      { index: 1, id: "once", key: "2", label: "Once" },
      { index: 2, id: "always", key: "3", label: "Always this command", rule: "terminal(pytest -q)" },
      { index: 3, id: "reject", key: "4", label: "Reject" },
    ]);
    expect(cardNotification(T, std)).toEqual({
      text: "Nokker : une action attend ton approbation (terminal pytest -q)",
      actions: [
        { label: "Une fois", index: 1 },
        { label: "Pour cette session", index: 0 },
        { label: "Refuser", index: 3 },
      ],
      severity: "info",
    });
    expect(cardNotification(english, card(null))).toEqual({ text: "Strong action: decide it in the terminal (`nokker`). (terminal pytest -q)", actions: [], severity: "warning" });
    expect(cardNotification(english, card(null, true)).actions).toEqual([]);
  });
});
