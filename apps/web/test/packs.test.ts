import { describe, expect, it } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { countLine, needLabel, packError } from "../src/packs/PacksTab.js";

describe("packs d'agents (§7.30)", () => {
  it("besoins de la machine et comptes en clair", () => {
    expect(needLabel({ kind: "mcp", name: "monitoring" })).toBe("le serveur MCP « monitoring »");
    expect(needLabel({ kind: "gpu" })).toBe("un GPU");
    expect(countLine(2, 1)).toBe("2 compétences, 1 agent");
    expect(countLine(0, 0)).toBe("");
  });

  it("refus : machine_only garde ce qui reste à la machine, scan_refused son rapport", () => {
    const machine = { skills: ["x"], agents: [], linked: [], handoff: null, next: "ouvre Lokkal" };
    const mo = packError(new NokkerApiError("x", 409, { error: { code: "machine_only", message: "m", machine } }));
    expect(mo).toMatchObject({ code: "machine_only", machine });
    const sr = packError(new NokkerApiError("x", 422, { error: { code: "scan_refused", message: "m", report: ["r1"] } }));
    expect(sr.report).toEqual(["r1"]);
    expect(packError(new NokkerApiError("x", 503, { error: { code: "no_scanner", message: "m" } })).text).toMatch(/scanner/);
    expect(packError(new Error("réseau")).text).toBe("le serveur ne répond pas");
  });
});
