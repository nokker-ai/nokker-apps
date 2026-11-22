import { describe, expect, it } from "vitest";
import { cardTarget, faceTarget, isCommandTool, TARGET_FACE_MAX } from "../src/index.js";

describe("cible d'une carte sur sa face", () => {
  it("cardTarget : la chaîne du noyau, rognée ; rien si absente ou pas du texte (jamais d'objet, jamais arguments)", () => {
    expect(cardTarget({ target: "  sh livrer.sh 2.1  " })).toBe("sh livrer.sh 2.1");
    expect(cardTarget({})).toBe("");
    expect(cardTarget({ target: { command: "ls" } })).toBe("");
    expect(cardTarget({ target: 42 })).toBe("");
  });
  it("faceTarget : 120 caractères VISIBLES puis « … » ; tel quel s'il tient ; une seule ligne", () => {
    expect(TARGET_FACE_MAX).toBe(120);
    expect(faceTarget("sh livrer.sh 2.1")).toBe("sh livrer.sh 2.1");
    const long = "a".repeat(200);
    expect(faceTarget(long)).toBe("a".repeat(120) + "…");
    expect([...faceTarget("\u{1F600}".repeat(200))]).toHaveLength(121); // 120 emojis + « … » : jamais coupé au milieu d'un caractère
    expect(faceTarget("a".repeat(120))).toBe("a".repeat(120));
    expect(faceTarget("ligne 1\nligne 2\r\n  ligne 3")).toBe("ligne 1 ligne 2 ligne 3");
  });
  it("isCommandTool : le terminal exécute, le reste est une cible", () => {
    for (const t of ["terminal", "shell", "bash", "exec", "run_command"]) expect(isCommandTool(t)).toBe(true);
    for (const t of ["write_file", "send_email_bulk", "terminal2", ""]) expect(isCommandTool(t)).toBe(false);
  });
});
