import { describe, expect, it } from "vitest";
import { fileEditsOf, hostPathOf, looksTruncated, parseV4APaths, reconstructBefore } from "../src/edits.js";
import { editorCannotDecide, localChoices, strongCardText } from "../src/approval-choices.js";

describe("éditions lues dans un tool.call", () => {
  it("patch replace (noms du noyau et du mock), write_file, V4A", () => {
    expect(fileEditsOf("patch", { path: "src/a.py", old_string: "x - y", new_string: "x + y" })).toEqual([
      { kind: "replace", path: "src/a.py", oldFragment: "x - y", newFragment: "x + y" },
    ]);
    expect(fileEditsOf("patch", { path: "src/a.py", old: "a", new: "b" })[0]).toMatchObject({ oldFragment: "a", newFragment: "b" });
    expect(fileEditsOf("write_file", { path: "n.txt", content: "bonjour" })).toEqual([{ kind: "write", path: "n.txt", content: "bonjour" }]);
    const v4a = "*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** Add File: src/b.py\n+z\n*** Delete File: old.py\n*** End Patch";
    expect(fileEditsOf("patch", { mode: "patch", patch: v4a }).map((e) => [e.op, e.path])).toEqual([
      ["update", "src/a.py"],
      ["add", "src/b.py"],
      ["delete", "old.py"],
    ]);
    expect(parseV4APaths("*** Update File: a.py\n*** Move to: b.py")).toEqual([{ op: "update", path: "b.py" }]);
    expect(fileEditsOf("terminal", { command: "ls" })).toEqual([]);
  });

  it("champ tronqué par le noyau : jamais pris pour le vrai texte", () => {
    expect(looksTruncated(`${"x".repeat(200)}…`)).toBe(true);
    const e = fileEditsOf("patch", { path: "a.py", old_string: `${"x".repeat(200)}…`, new_string: "y" })[0]!;
    expect(e.oldFragment).toBeUndefined();
    expect(reconstructBefore("y", e)).toBeNull();
    expect(fileEditsOf("write_file", { path: "a", content: "abc…" })[0]!.content).toBeUndefined();
  });

  it("reconstructBefore : seulement sans ambiguïté", () => {
    const e = fileEditsOf("patch", { path: "a.py", old_string: "a - b", new_string: "a + b" })[0]!;
    expect(reconstructBefore("def f():\n  return a + b\n", e)).toBe("def f():\n  return a - b\n");
    expect(reconstructBefore("a + b; a + b", e)).toBeNull(); // deux occurrences : on ne devine pas
    expect(reconstructBefore("rien", e)).toBeNull();
    expect(reconstructBefore("x $& y a + b", fileEditsOf("patch", { path: "a", old_string: "$1", new_string: "a + b" })[0]!)).toBe("x $& y $1");
  });

  it("hostPathOf : /workspace et relatif → dossier de la session, jamais en dehors", () => {
    expect(hostPathOf("src/a.py", "/home/alice/calc")).toBe("/home/alice/calc/src/a.py");
    expect(hostPathOf("./src/a.py", "/home/alice/calc/")).toBe("/home/alice/calc/src/a.py");
    expect(hostPathOf("/workspace/src/a.py", "/home/alice/calc")).toBe("/home/alice/calc/src/a.py");
    expect(hostPathOf("/home/alice/calc/src/a.py", "/home/alice/calc")).toBe("/home/alice/calc/src/a.py");
    expect(hostPathOf("/etc/passwd", "/home/alice/calc")).toBeNull();
    expect(hostPathOf("../secret", "/home/alice/calc")).toBeNull();
    expect(hostPathOf("/home/alice/calcul/x", "/home/alice/calc")).toBeNull();
    expect(hostPathOf("src\\a.py", "C:\\Users\\alice\\calc")).toBe("C:\\Users\\alice\\calc\\src\\a.py");
  });
});

describe("choix d'une carte (partagés CLI / VS Code / ACP)", () => {
  const base = { tool_name: "terminal", arguments: { command: "pytest -q" }, strength: "standard" as const, suggested_rules: ["terminal(pytest -q)", "terminal(pytest -q*)"] };
  it("commande de test : « Pour cette session » d'abord ; règles exactes", () => {
    const c = localChoices(base);
    expect(c.map((x) => x.id)).toEqual(["session", "once", "always", "always", "reject"]);
    expect(c[2]!.rule).toBe("terminal(pytest -q)");
  });
  it("carte forte : jamais décidée depuis un éditeur ; le texte dit où elle attend", () => {
    expect(editorCannotDecide({ strength: "strong" })).toBe(true);
    expect(editorCannotDecide({ strength: "standard" })).toBe(false);
    // Partie chez nokker.ai (machine liée) : le téléphone ; sinon (machine non liée, dépôt pas encore fait) : le terminal.
    expect(strongCardText({ forwarded: true })).toBe("Action forte : elle attend ton téléphone.");
    expect(strongCardText({ forwarded: false })).toBe("Action forte : à décider dans le terminal (`nokker`).");
    expect(strongCardText({})).toBe("Action forte : à décider dans le terminal (`nokker`).");
  });
});
