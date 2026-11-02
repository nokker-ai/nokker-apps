import { describe, expect, it } from "vitest";
import type { ImportItem, ImportReport } from "@nokker-apps/sdk";
import { groupReport, hostCommand, itemLabel, mcpRequest, nothingVisible } from "../src/onboarding/importModel.js";
import { t } from "../src/onboarding/i18n.js";

const it_ = (kind: string, status: ImportItem["status"], source: string, detail: Record<string, unknown> = {}): ImportItem => ({ kind, status, source, target: null, reason: "r", detail });
const rep = (items: ImportItem[]): ImportReport => ({ origin: "claude-code", counts: {} as ImportReport["counts"], items });

describe("écran d'import", () => {
  it("regroupe : repris, MCP à ajouter dans une session, pas repris ; lignes de fichier retirées", () => {
    const mcp = it_("mcp", "planned", "~/.claude.json#mcpServers.docs", { entry: { name: "docs", url: "https://m.example.org" } });
    const g = groupReport(rep([it_("skill", "planned", "/s/pdf", { name: "pdf" }), mcp, it_("mcp", "unsupported", "x#mcpServers.fs"), it_("source-file", "skipped", "/x.json"), it_("note", "native", "CLAUDE.md")]));
    expect(g.taken.map((i) => i.kind)).toEqual(["skill", "note"]);
    expect(g.mcp).toEqual([mcp]);
    expect(g.left.map((i) => i.source)).toEqual(["x#mcpServers.fs"]);
    expect(mcpRequest(mcp, "fr")).toBe("Ajoute le serveur MCP docs (https://m.example.org)");
    expect(mcpRequest(mcp, "en")).toBe("Add the MCP server docs (https://m.example.org)");
  });
  it("après apply, un MCP sauté (à faire dans une session) reste dans sa section", () => {
    const g = groupReport(rep([it_("mcp", "skipped", "a#mcpServers.docs", { entry: { name: "docs", url: "u" } })]));
    expect(g.mcp.length).toBe(1);
  });
  it("rien de visible → commande de l'hôte ; libellés ; commandes", () => {
    expect(nothingVisible(rep([it_("unaccounted-source", "unsupported", "/x")]))).toBe(true);
    expect(nothingVisible(rep([it_("skill", "planned", "/s")]))).toBe(false);
    expect(itemLabel(it_("user-note", "planned", "~/.claude/CLAUDE.md#Git", { title: "Git" }))).toBe("Git");
    expect(itemLabel(it_("secret-name", "skipped", "/h/.env#OPENAI_API_KEY"))).toBe("OPENAI_API_KEY");
    expect(itemLabel(it_("runtime", "skipped", "/h/.claude/projects"))).toBe("projects");
    expect(hostCommand("hermes", false)).toBe("nokker import hermes");
    expect(hostCommand("hermes", true)).toBe("nokker import hermes --apply");
  });
  it("textes FR/EN", () => {
    for (const l of ["fr", "en"] as const) expect(t(l, "impLeft", { n: "3" })).toMatch(/3/);
  });
});

describe("raisons traduites par code", () => {
  it("chaque code a FR et EN, mêmes clés", async () => {
    const { IMPORT_REASONS } = await import("../src/onboarding/i18n.js");
    expect(Object.keys(IMPORT_REASONS.en).sort()).toEqual(Object.keys(IMPORT_REASONS.fr).sort());
    expect(IMPORT_REASONS.en.mcp_stdio).toMatch(/no equivalent/);
    expect(Object.keys(IMPORT_REASONS.fr).length).toBeGreaterThanOrEqual(50);
  });
});
