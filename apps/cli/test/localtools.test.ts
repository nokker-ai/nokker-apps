import { describe, expect, it } from "vitest";
import {
  applySubagentEvent,
  classifyDiffLine,
  formatCheckpoints,
  formatPlan,
  formatRestore,
  formatSkills,
  formatSubagents,
  parseCheckpointDiff,
  parseCheckpointList,
  renderDiff,
  resolveCheckpoint,
} from "../src/localtools.js";

const cps = [
  { hash: "aa11".padEnd(40, "0"), short_hash: "aa110000", timestamp: "2026-10-24T10:05:00.000Z", reason: "avant patch", files_changed: 1 },
  { hash: "bb22".padEnd(40, "0"), short_hash: "bb220000", timestamp: "2026-10-24T09:00:00.000Z", reason: "début", files_changed: 0 },
];

describe("diff", () => {
  it("classe les lignes et tronque à 300 avec mention", () => {
    expect(["+a", "-b", "@@ -1 +1 @@", "--- a/x", "+++ b/x", " c"].map(classifyDiffLine)).toEqual(["add", "del", "hunk", "meta", "meta", "ctx"]);
    const big = Array.from({ length: 450 }, (_, i) => `+ligne ${i}`).join("\n");
    const d = renderDiff(big);
    expect(d.lines).toHaveLength(300);
    expect(d.omitted).toBe(150);
    expect(renderDiff("+a\n-b\n").omitted).toBe(0);
  });
});

describe("points de retour", () => {
  it("liste et résolution (n, hash, préfixe, défaut)", () => {
    const out = formatCheckpoints(cps);
    expect(out).toContain("aa110000");
    expect(out).toContain("avant patch");
    expect(out).toContain("(1 file)");
    expect(out).toContain("(0 file)");
    expect(resolveCheckpoint(cps, null)).toBe(cps[0]);
    expect(resolveCheckpoint(cps, "2")).toBe(cps[1]);
    expect(resolveCheckpoint(cps, "bb22")).toBe(cps[1]);
    expect(resolveCheckpoint(cps, cps[0]!.hash)).toBe(cps[0]);
    expect(resolveCheckpoint(cps, "zz")).toBeNull();
    expect(resolveCheckpoint(cps, "9")).toBeNull();
    expect(resolveCheckpoint([], null)).toBeNull();
  });
  it("résumé de restauration", () => {
    const t = formatRestore({ success: true, restored_files: ["a.py"], skipped_user_edits: ["b.md"] }, "aa110000");
    expect(t).toContain("1 file(s) restored");
    expect(t).toContain("restored  a.py");
    expect(t).toContain("kept  b.md");
    expect(formatRestore({ success: false, restored_files: [], skipped_user_edits: [], error: "boum" }, "x")).toContain("boum");
  });
});

describe("skills, plan, sous-agents", () => {
  it("skills groupés par famille", () => {
    const t = formatSkills([
      { name: "b", category: "dev", description: "d1", source: "builtin" },
      { name: "a", category: "data", description: "d2", source: "user" },
    ]);
    expect(t.indexOf("data")).toBeLessThan(t.indexOf("dev"));
    expect(t).toContain("[user]");
  });
  it("plan à puces avec état", () => {
    const t = formatPlan([
      { id: "1", content: "un", status: "completed" },
      { id: "2", content: "deux", status: "in_progress" },
      { id: "3", content: "trois", status: "pending" },
    ]);
    expect(t).toContain("• [x] un");
    expect(t).toContain("• [~] deux");
    expect(t).toContain("• [ ] trois");
  });
  it("sous-agents : état, dernier outil, durée, but tronqué", () => {
    let m = applySubagentEvent(new Map(), { type: "subagent.started", child_id: "sa1", goal: "x".repeat(60) }, 1000);
    m = applySubagentEvent(m, { type: "subagent.progress", child_id: "sa1", tool: "patch" }, 2000);
    expect(formatSubagents(m, 5000)).toContain("running");
    m = applySubagentEvent(m, { type: "subagent.finished", child_id: "sa1", status: "ok" }, 8000);
    const t = formatSubagents(m, 99999);
    expect(t).toContain("done");
    expect(t).toContain("last tool: patch");
    expect(t).toContain("7 s");
    expect(t).toContain("…");
    expect(formatSubagents(new Map())).toContain("No sub-agents");
  });
});

describe("formes du noyau, tolérance", () => {
  it("checkpoint_list : liste nue ou enveloppe {checkpoints}", () => {
    expect(parseCheckpointList(JSON.stringify(cps))).toHaveLength(2);
    expect(parseCheckpointList(JSON.stringify({ checkpoints: cps }))).toHaveLength(2);
    expect(parseCheckpointList("pas du json")).toBeUndefined();
    expect(parseCheckpointList("{}")).toBeUndefined();
  });
  it("checkpoint_diff : {stat, diff, message?} ou texte brut", () => {
    expect(parseCheckpointDiff(JSON.stringify({ stat: " a | 1 +", diff: "+x" }))).toEqual({ stat: "a | 1 +", diff: "+x", message: null });
    expect(parseCheckpointDiff(JSON.stringify({ stat: "", diff: "", message: "aucun changement" }))).toEqual({ stat: null, diff: "", message: "aucun changement" });
    expect(parseCheckpointDiff("+brut\n-x")).toEqual({ stat: null, diff: "+brut\n-x", message: null });
  });
});
