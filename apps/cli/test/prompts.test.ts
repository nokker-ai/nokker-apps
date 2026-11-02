/** Textes fixes envoyés au modèle (apps/cli/src/prompts.ts) : figés ici mot pour mot, toute retouche se voit. */
import { describe, expect, it } from "vitest";
import { BTW_THREAD_TITLE, btwPrompt } from "../src/prompts.js";
import { parseSlashCommand } from "../src/commands.js";

describe("/btw", () => {
  it("contexte court (dossier, titre), jamais d'historique ; texte exact", () => {
    expect(BTW_THREAD_TITLE).toBe("annexe");
    expect(btwPrompt({ cwd: "/w/calc", threadTitle: "Fix the parser" }, "what is a PEG?")).toBe(
      [
        "[Question annexe]",
        "Question posée par l'utilisateur pendant une autre session ; elle ne fait pas partie de la tâche de cette session.",
        "Contexte de cette session : dossier de travail /w/calc, fil « Fix the parser ». Tu n'as pas son historique.",
        "Réponds brièvement et directement. Ne modifie aucun fichier et ne lance aucune commande pour cette question.",
        "",
        "what is a PEG?",
        "[/Question annexe]",
      ].join("\n"),
    );
    expect(btwPrompt({ cwd: null, threadTitle: null }, "q")).toContain("Contexte de cette session : aucun.");
    expect(parseSlashCommand("/btw what is  X?")).toEqual({ kind: "btw", question: "what is  X?" });
  });
});
