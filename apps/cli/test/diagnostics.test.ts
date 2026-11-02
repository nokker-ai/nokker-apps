import { describe, expect, it } from "vitest";
import { applyDiagnostics, formatDiagnosticsResult, formatDiagnosticsState, stateFromResult, type DiagnosticsState } from "../src/diagnostics.js";
import { parseSlashCommand } from "../src/commands.js";

const err = (line: number) => ({ line, col: 5, severity: "error", code: "reportX", message: `bad ${line}` });

describe("diagnostics de langage (pur)", () => {
  it("ligne quand il y a des erreurs, « no errors » seulement pour un fichier qui en avait, dernier état gardé", () => {
    let s: DiagnosticsState = new Map();
    let r = applyDiagnostics(s, { path: "a.py", counts: { error: 0, warning: 1 }, items: [] });
    expect(r.line).toBeNull();
    s = r.state;
    r = applyDiagnostics(s, { path: "src/calc.py", counts: { error: 2, warning: 0 }, items: [err(1), err(2)] });
    expect(r.line).toBe("⚠ 2 errors in src/calc.py");
    s = r.state;
    expect(applyDiagnostics(s, { path: "b.py", counts: { error: 1, warning: 0 }, items: [err(1)] }).line).toBe("⚠ 1 error in b.py");
    r = applyDiagnostics(s, { path: "src/calc.py", counts: { error: 0, warning: 0 }, items: [] });
    expect(r.line).toBe("✓ src/calc.py: no errors");
    expect(r.state.get("src/calc.py")).toEqual({ errors: 0, warnings: 0, items: [] });
    expect(applyDiagnostics(r.state, { path: "src/calc.py", counts: { error: 0, warning: 0 }, items: [] }).line).toBeNull();
  });

  it("textes de /diagnostics : état, réponse de l'outil (items, pending, serveurs)", () => {
    expect(formatDiagnosticsState(new Map())).toMatch(/No language diagnostics/);
    const s = applyDiagnostics(new Map(), { path: "src/calc.py", counts: { error: 2, warning: 0 }, items: [err(12), err(18)] }).state;
    const text = formatDiagnosticsState(s);
    expect(text).toContain("⚠ src/calc.py — 2 error(s), 0 warning(s)");
    expect(text).toContain("12:5 error reportX: bad 12");
    const res = { files: [{ path: "x.ts", errors: 0, warnings: 0, items: [] }], language_servers: ["typescript-language-server"], pending: ["y.ts"] };
    const out = formatDiagnosticsResult(res);
    expect(out).toContain("✓ x.ts — 0 error(s), 0 warning(s)");
    expect(out).toContain("Still analysing: y.ts");
    expect(out).toContain("Language servers: typescript-language-server");
    expect(stateFromResult(s, res).get("x.ts")).toEqual({ errors: 0, warnings: 0, items: [] });
  });

  it("/diagnostics [chemin] et l'alias /diag", () => {
    expect(parseSlashCommand("/diagnostics")).toEqual({ kind: "diagnostics", path: null });
    expect(parseSlashCommand("/diagnostics src/calc.py")).toEqual({ kind: "diagnostics", path: "src/calc.py" });
    expect(parseSlashCommand('/diag "my dir/a.py"')).toEqual({ kind: "diagnostics", path: "my dir/a.py" });
  });
});
