/** Mise en forme de /agents, /memory et de la confiance des skills du dépôt (pure), en anglais et en français. */
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectMemoryList } from "@nokker-apps/sdk";
import {
  applySubagentEvent,
  findMemoryEntry,
  formatMemory,
  formatMemoryStatus,
  formatMemoryView,
  formatProjectSkills,
  formatSkills,
  formatSubagent,
  formatSubagents,
  mergeSubagentViews,
} from "../src/localtools.js";
import { setLang } from "../src/i18n/index.js";

afterEach(() => setLang("en"));

const SHA = "ab".repeat(32);

describe("/agents", () => {
  it("événements du noyau (parent_thread_id, background, exit_reason) puis delegate_status (résultat complet)", () => {
    setLang("en");
    let m = applySubagentEvent(new Map(), { type: "subagent.started", child_id: "c1", child_thread_id: "th_p/sa-c1", goal: "audit the tests", background: true }, 1000);
    m = applySubagentEvent(m, { type: "subagent.progress", child_id: "c1", tool: "terminal" }, 2000);
    expect(formatSubagents(m, 4000)).toMatch(/• c1 {2}running +\(background\) {2}audit the tests {2}last tool: terminal {2}3 s/);
    expect(formatSubagents(m, 4000)).toContain("/agents cancel <id|all>");
    m = mergeSubagentViews(m, [
      { child_id: "c1", thread_id: "th_p/sa-c1", task_index: 0, goal: "audit the tests", elapsed_s: 42, status: "completed", exit_reason: "completed", summary: "Two flaky tests found.\nBoth fixed.", worktree: { path: "/w", branch: "nokker/sa-c1", commits: 2, dirty: false, kept: true }, tokens: 1200, cost: 0.02 },
    ], 50_000);
    const list = formatSubagents(m, 60_000);
    expect(list).toMatch(/• c1 {2}done +\(background\) {2}audit the tests {2}last tool: terminal {2}42 s — 2 commit\(s\)/);
    expect(list).toContain("result: Two flaky tests found. Both fixed.");
    const one = formatSubagent(m.get("c1")!, 60_000);
    expect(one).toContain("Sub-agent c1 (background)");
    expect(one).toContain("worktree: nokker/sa-c1 · 2 commit(s) · kept");
    expect(one).toContain("cost: 1200 tokens · CHF 0.02");
    expect(one).toContain("    Both fixed.");
  });

  it("annulé : interrupted / cancelled ; repris après sa carte ; anciens mocks (status ok)", () => {
    let m = applySubagentEvent(new Map(), { type: "subagent.started", child_id: "c2", goal: "g" }, 0);
    m = applySubagentEvent(m, { type: "subagent.finished", child_id: "c2", status: "interrupted", exit_reason: "cancelled", commits: 0, dirty: true, kept: true, background: true }, 5000);
    expect(formatSubagents(m, 9000)).toMatch(/c2 {2}interrupted +\(background\) .* — cancelled, 0 commit\(s\), tree modified/);
    m = applySubagentEvent(m, { type: "subagent.finished", child_id: "c2", status: "completed", exit_reason: "completed", resumed: true }, 6000);
    expect(formatSubagents(m, 9000)).toContain("resumed after its card");
    const old = applySubagentEvent(new Map(), { type: "subagent.finished", child_id: "c3", status: "ok" }, 0);
    expect(old.get("c3")!.status).toBe("completed");
    expect(formatSubagents(new Map(), 0, "(note)")).toBe("No sub-agents on this thread.\n(note)");
  });
});

describe("/checkpoints et redémarrage", () => {
  it("le tour du point quand le noyau le relie (25.10), rien sinon (rc.6)", async () => {
    const { formatCheckpoints } = await import("../src/localtools.js");
    const linked = { hash: "a".repeat(40), short_hash: "aaaaaaaa", timestamp: "2026-10-25T10:00:00+00:00", reason: "avant patch", files_changed: 1, thread_id: "th_1", turn_index: 2, tool: "patch" };
    const old = { ...linked, hash: "b".repeat(40), short_hash: "bbbbbbbb", thread_id: undefined, turn_index: undefined, tool: undefined };
    const out = formatCheckpoints([linked, old]).split("\n");
    expect(out[1]).toMatch(/aaaaaaaa .*\(1 file\)  · turn 3$/);
    expect(out[2]).toMatch(/bbbbbbbb .*\(1 file\)$/);
  });
  it("enfant relu après redémarrage : interrupted / restart", () => {
    let m = applySubagentEvent(new Map(), { type: "subagent.started", child_id: "c9", goal: "g", background: true }, 0);
    m = mergeSubagentViews(m, [{ child_id: "c9", thread_id: "th_p/sa-c9", task_index: 0, goal: "g", elapsed_s: 3, status: "interrupted", exit_reason: "restart", worktree: { path: "/w", branch: "nokker/sa-c9", kept: true } }]);
    expect(formatSubagents(m)).toContain("interrupted");
    expect(formatSubagents(m)).toContain("the core restarted: worktree kept, not inspected");
  });
});

describe("/memory", () => {
  const list: ProjectMemoryList = {
    project: "example.org/team/app",
    notes: [
      { name: "rule-tests-1a2b", kind: "rule", scope: "user", title: "Run tests first", derived_from: "user", in_core: true },
      { name: "fact-port-3c4d", kind: "fact", scope: "project", title: "Port 5173", derived_from: "repo", in_core: false },
    ],
    sources: [{ path: "AGENTS.md", sections: [{ name: "src-0011aabb-1", title: "Build", in_core: true }] }],
  };

  it("liste : notes, portée, origine, noyau, sections, mémoire longue", () => {
    setLang("en");
    const out = formatMemory(list, { mode: "direct", ok: true, store: { ok: true, notes: 7 } });
    expect(out).toContain("Project memory — example.org/team/app");
    expect(out).toContain("  • [rule] Run tests first  (rule-tests-1a2b) · all your projects · from you · always in context");
    expect(out).toContain("  • [fact] Port 5173  (fact-port-3c4d) · this project · from the repository · recalled when relevant");
    expect(out).toContain("    • Build  (src-0011aabb-1) · always in context");
    expect(out).toContain("Long-term memory: direct, healthy, 7 indexed note(s).");
    setLang("fr");
    expect(formatMemory({ project: null, notes: [], sources: [] })).toContain("Notes apprises : aucune pour l'instant.");
    expect(formatMemoryStatus({ mode: "direct", ok: false, error: "embed injoignable" })).toContain("EN PANNE (embed injoignable)");
    expect(formatMemoryStatus(null)).toBeNull();
  });

  it("note ou section par nom exact ou préfixe unique ; vue d'une section", () => {
    expect(findMemoryEntry(list, "fact")).toEqual({ name: "fact-port-3c4d", title: "Port 5173", learned: true });
    expect(findMemoryEntry(list, "src-0011aabb-1")).toMatchObject({ learned: false });
    expect(findMemoryEntry(list, "nope")).toBeNull();
    setLang("en");
    expect(formatMemoryView({ name: "src-0011aabb-1", source: "AGENTS.md", title: "Build", text: "Run make." })).toBe("Build  (src-0011aabb-1)\nfrom AGENTS.md — edit the file to change it\n\nRun make.");
  });
});

describe("skills du dépôt", () => {
  it("états : untrusted, trusted, invalid, absent, off, unknown", () => {
    setLang("en");
    const base = { enabled: true, root: "/w/app", sha256: SHA, count: 3, notice: null };
    expect(formatProjectSkills({ ...base, project: "untrusted" })).toBe(`Repository skills (/w/app): 3 NOT trusted, ignored — fingerprint ${SHA.slice(0, 12)}…. /skills trust to review and trust them.`);
    expect(formatProjectSkills({ ...base, project: "trusted" })).toContain("3 trusted");
    expect(formatProjectSkills({ ...base, project: "invalid", notice: "too many files" })).toBe("Repository skills ignored: too many files");
    expect(formatProjectSkills({ ...base, project: "absent", sha256: null, count: 0 })).toBe("No repository skills (.nokker/skills) in /w/app.");
    expect(formatProjectSkills("off")).toContain("local.project_skills is off");
    expect(formatProjectSkills("unknown")).toContain("resumed session");
    setLang("fr");
    expect(formatSkills([{ name: "lint", category: "dev", description: "d", source: "project" }], { ...base, project: "trusted" })).toMatch(/^Skills du dépôt \(\/w\/app\) : 3 de confiance/);
  });
});
