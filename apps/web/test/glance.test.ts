import { afterEach, describe, expect, it } from "vitest";
import { cleanSummary, pagesOf, step, strengthHint, summaryLines, toolLabel, type GlanceData } from "../src/glance/model.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));
const card = (id: string, strength: "strong" | "standard" = "standard") => ({ id, tool_name: "ssh_run", reason: "restart nginx", strength, created_at: "2026-11-01T08:00:00Z" });

describe("glance model", () => {
  it("pages: summary, then the brief if it has a text, then one per waiting card", () => {
    const d: GlanceData = { brief: { summary: "x", ended_at: null, status: "succeeded" }, cards: [card("a"), card("b")], liveIncidents: [] };
    expect(pagesOf(d).map((p) => p.kind)).toEqual(["summary", "brief", "card", "card"]);
    expect(pagesOf({ brief: null, cards: [], liveIncidents: null })).toEqual([{ kind: "summary" }]);
    expect(pagesOf({ brief: { summary: null, ended_at: null, status: "failed" }, cards: [], liveIncidents: null })).toEqual([{ kind: "summary" }]);
  });
  it("steps wrap around both ways", () => {
    expect(step(0, 3, 1)).toBe(1);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(0, 0, 1)).toBe(0);
  });
  it("summary lines say what waits, in the interface language", () => {
    setShellLang("en");
    expect(summaryLines({ brief: null, cards: [], liveIncidents: null })).toEqual(["Nothing waits for you.", "No brief yet today."]);
    expect(summaryLines({ brief: { summary: "x", ended_at: null, status: "succeeded" }, cards: [card("a"), card("b")], liveIncidents: [{ id: "i", title: "disk" }] })).toEqual(["2 cards wait for you.", "1 live incident."]);
    setShellLang("fr");
    expect(summaryLines({ brief: null, cards: [card("a")], liveIncidents: [{ id: "1", title: "a" }, { id: "2", title: "b" }] })).toEqual(["1 carte t'attend.", "2 incidents en cours.", "Pas encore de brief aujourd'hui."]);
  });
  it("small helpers", () => {
    setShellLang("en");
    expect(cleanSummary("(demo) Three things today.")).toBe("Three things today.");
    expect(toolLabel("checkpoint_restore")).toBe("checkpoint restore");
    expect(strengthHint("strong")).toMatch(/phone/);
  });
});

describe("fromView (GET /v1/glance → pages)", () => {
  it("keeps the brief only if there is a brief agent, and incidents only if they could be read", async () => {
    const { fromView } = await import("../src/glance/model.js");
    const run = { summary: "x", ended_at: null, status: "succeeded" } as never;
    const base = { approvals: [], incidents: [{ id: "i", title: "disk" }] as never[], at: "2026-11-02T07:30:00Z" };
    expect(fromView({ ...base, brief: { agent: { id: "ag" } as never }, brief_last_run: run, unavailable: [] }).brief).toBe(run);
    expect(fromView({ ...base, brief: { agent: null }, brief_last_run: run, unavailable: [] }).brief).toBeNull();
    expect(fromView({ ...base, brief: null, brief_last_run: null, unavailable: ["incidents", "brief"] }).liveIncidents).toBeNull();
  });
});
