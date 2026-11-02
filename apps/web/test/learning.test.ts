import { describe, expect, it } from "vitest";
import { NokkerApiError, type JournalEntry } from "@nokker-apps/sdk";
import { diffRows, errorCode, journalLine, learningError } from "../src/learning/model.js";
import { setShellLang } from "../src/i18n/index.js";

const e = (kind: JournalEntry["kind"], extra: Partial<JournalEntry> = {}): JournalEntry => ({ id: "lj_1", kind, subject: "deploy-docs", at: "2026-11-01T10:00:00Z", actor: "agent", version: 2, detail: {}, ...extra });

describe("apprentissage — modèle", () => {
  it("journal : libellé, sujet (titre de la note), provenance", () => {
    setShellLang("en");
    expect(journalLine(e("skill.updated"))).toEqual({ what: "Skill updated (v2)", subject: "deploy-docs", origin: "by Nina, card approved" });
    expect(journalLine(e("skill.reverted", { actor: "owner", detail: { reverted_to: 1 } })).what).toBe("Skill back to v1");
    expect(journalLine(e("memory.approved", { subject: "mp_x", actor: "owner", detail: { title: "Tutoiement" } }))).toMatchObject({ subject: "Tutoiement", origin: "by you" });
    setShellLang("fr");
    expect(journalLine(e("memory.rejected", { detail: { title: "x" } })).what).toBe("Note écartée");
    setShellLang(null);
  });
  it("diff unifié → lignes typées", () => {
    const rows = diffRows("--- a@v1\n+++ a@v2\n@@ -1,2 +1,3 @@\n x\n-y\n+z\n");
    expect(rows.map((r) => r.type)).toEqual(["head", "head", "hunk", "ctx", "del", "add"]);
    expect(rows[5]).toEqual({ type: "add", text: "z" });
    expect(diffRows("")).toEqual([]);
  });
  it("erreurs du noyau → messages clairs", () => {
    setShellLang("en");
    const err = (status: number, code?: string) => new NokkerApiError("x", status, code ? { error: { code, message: "x" } } : { error: { message: "not found" } });
    expect(errorCode(err(409, "no_rule_store"))).toBe("no_rule_store");
    expect(learningError(err(409, "no_rule_store"))).toMatch(/Lokkal machine/);
    expect(learningError(err(403, "machine_only"))).toMatch(/machine itself/);
    expect(learningError(err(404))).toBe("server refused (404)");
    setShellLang(null);
  });
});
