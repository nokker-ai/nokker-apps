import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { TEXTS, c, codeError, isFull, modeLabel, openBody, parsePoints, repoName, restoreOutcome, sortSessions } from "../src/code/model.js";

const err = (status: number, code?: string) => new NokkerApiError("x", status, code ? { error: { code, message: "x" } } : {});

// Codes d'erreur du contrat (LOKKAL §7.28, point 2) : chacun a son texte dans les deux langues.
const CODES = [
  "account_required",
  "minor_not_allowed",
  "session_limit",
  "bad_mode",
  "bad_repo",
  "bad_ref",
  "bad_depth",
  "https_required",
  "host_not_allowed",
  "credentials_in_url",
  "bad_url",
  "credential_missing",
  "secret_value_refused",
  "clone_failed",
  "git_missing",
  "vault_unavailable",
  "workspace_refused",
  "bad_name",
  "bad_value",
  "tool_not_allowed",
  "bad_arguments",
  "turn_running",
  "not_found",
];

describe("sessions de code : modèle de l'écran", () => {
  it("FR et EN ont les mêmes clés, et les variables sont remplacées", () => {
    expect(Object.keys(TEXTS.en).sort()).toEqual(Object.keys(TEXTS.fr).sort());
    expect(c("fr", "count", { n: 2, limit: 3 })).toBe("2 session(s) ouverte(s) sur 3");
    expect(c("en", "count", { n: 2, limit: 3 })).toBe("2 of 3 session(s) open");
  });

  it("chaque code d'erreur du noyau est traduit, en FR et en EN", () => {
    for (const code of CODES) {
      const status = code === "session_limit" || code === "turn_running" ? 409 : 400;
      for (const lang of ["fr", "en"] as const) {
        const text = codeError(lang, err(status, code));
        expect(text, `${lang}:${code}`).toBe(TEXTS[lang][`e_${code}` as keyof (typeof TEXTS)["fr"]]);
      }
    }
    expect(codeError("fr", err(418))).toBe("Refus du serveur (418).");
    expect(codeError("en", new Error("réseau"))).toBe("The server does not answer.");
  });

  it("corps d'ouverture : champs vides omis, pas de dépôt sans URL", () => {
    expect(openBody({ url: "  ", ref: "main", credential: "FORGE", mode: "plan" })).toEqual({ mode: "plan" });
    expect(openBody({ url: " https://git.example.org/a/b ", ref: "", credential: "", mode: "" })).toEqual({ repo: { url: "https://git.example.org/a/b" } });
    expect(openBody({ url: "https://git.example.org/a/b", ref: "v1", credential: "FORGE", mode: "default" })).toEqual({ repo: { url: "https://git.example.org/a/b", ref: "v1", credential: "FORGE" }, mode: "default" });
  });

  it("restauration : carte, exécutée, ou refusée par la porte", () => {
    expect(restoreOutcome("fr", { approval_id: "appr_1" })).toEqual({ kind: "card", approvalId: "appr_1" });
    expect(restoreOutcome("fr", { content: JSON.stringify({ success: true, restored_to: "abcd1234", skipped_user_edits: [] }), is_error: false })).toEqual({ kind: "done", text: "Retour effectué." });
    expect(restoreOutcome("en", { content: JSON.stringify({ success: true, skipped_user_edits: ["a.py", "b.py"] }), is_error: false }).kind).toBe("done");
    expect(restoreOutcome("en", { content: JSON.stringify({ success: true, skipped_user_edits: ["a.py", "b.py"] }), is_error: false })).toMatchObject({ text: expect.stringContaining("2 file(s)") });
    expect(restoreOutcome("fr", { content: "refusé par le noyau (mode plan)", is_error: true })).toEqual({ kind: "refused", text: "Retour refusé : refusé par le noyau (mode plan)" });
    expect(restoreOutcome("fr", { content: JSON.stringify({ success: false, error: "Checkpoint 'x' not found" }), is_error: true }).text).toContain("not found");
  });

  it("points, modes, plafond, tri et nom du dépôt", () => {
    expect(parsePoints("[]")).toEqual([]);
    expect(parsePoints("points de retour indisponibles")).toBeNull();
    expect(modeLabel("fr", "plan")).toBe("plan (lecture seule)");
    expect(modeLabel("en", "custom")).toBe("custom");
    expect(isFull({ sessions: [{} as never, {} as never, {} as never], limit: 3 })).toBe(true);
    expect(isFull({ sessions: [], limit: 3 })).toBe(false);
    const s = (id: string, last: string) => ({ id, last_used_at: last }) as never;
    expect(sortSessions([s("a", "2026-10-25T10:00:00Z"), s("b", "2026-10-25T11:00:00Z")]).map((x: { id: string }) => x.id)).toEqual(["b", "a"]);
    expect(repoName("https://git.example.org/acme/app.git")).toBe("acme/app");
  });
});
