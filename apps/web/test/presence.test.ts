import { afterEach, describe, expect, it } from "vitest";
import type { PresenceEntry, PresenceView } from "@nokker-apps/sdk";
import { activityText, applyChange, attentionCount, canOpen, destination, entryName, grouped, groupTitle, statusText } from "../src/presence/model.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

const e = (id: string, status: PresenceEntry["status"], type: PresenceEntry["target"]["type"] = "thread", kind: PresenceEntry["kind"] = "thread"): PresenceEntry => ({
  id, kind, name: id, status, activity: null, since: null, target: { type, id },
});
const view = (entries: PresenceEntry[], read_only = false): PresenceView => ({
  viewer: { household: read_only, payer: false, read_only },
  entries,
  counts: { awaiting_approval: entries.filter((x) => x.status === "awaiting_approval").length, blocked: entries.filter((x) => x.status === "blocked").length, working: entries.filter((x) => x.status === "working").length, paused: 0, idle: entries.filter((x) => x.status === "idle").length },
  next_waiting: null,
});

describe("« Who does what » view model", () => {
  it("groups by what needs a human first, hides empty groups", () => {
    const g = grouped([e("a", "idle"), e("b", "awaiting_approval"), e("c", "blocked"), e("d", "working")]);
    expect(g.map((x) => x.id)).toEqual(["needs", "working", "idle"]);
    expect(g[0]!.entries.map((x) => x.id)).toEqual(["b", "c"]);
  });
  it("the badge counts cards and blocked", () => {
    expect(attentionCount(view([e("a", "awaiting_approval"), e("b", "blocked"), e("c", "working")]))).toBe(2);
    expect(attentionCount(null)).toBe(0);
  });
  it("a click goes to the thread, the Crew or the house", () => {
    expect(destination(e("th_1", "idle"))).toEqual({ view: "chat", thread: "th_1" });
    expect(destination(e("agent:x", "idle", "agent", "agent"))).toEqual({ view: "crew" });
    expect(destination(e("house:maison", "idle", "house", "house"))).toEqual({ view: "house" });
  });
  it("a read-only viewer cannot open an agent, but can open a thread and the house", () => {
    const v = view([], true);
    expect(canOpen(v, e("agent:x", "idle", "agent", "agent"))).toBe(false);
    expect(canOpen(v, e("th", "idle"))).toBe(true);
    expect(canOpen(v, e("house:a", "idle", "house", "house"))).toBe(true);
    expect(canOpen(view([], false), e("agent:x", "idle", "agent", "agent"))).toBe(true);
  });
  it("applies presence.changed without a round trip", () => {
    const v = view([e("a", "idle"), e("b", "working")]);
    const n = applyChange(v, "a", "awaiting_approval");
    expect(n.entries[0]!.status).toBe("awaiting_approval");
    expect(n.counts).toMatchObject({ idle: 0, awaiting_approval: 1 });
    expect(applyChange(v, "zz", "idle")).toBe(v);
    expect(applyChange(v, "a", "idle")).toBe(v);
  });
  it("is in the interface language", () => {
    setShellLang("fr");
    expect(statusText("awaiting_approval")).toBe("attend ton approbation");
    expect(groupTitle("needs", 2)).toBe("T'attendent · 2");
    setShellLang("en");
    expect(statusText("blocked")).toBe("blocked");
  });
  it("words the activity from the core's code, in the interface language, never a core sentence", () => {
    setShellLang("fr");
    expect(activityText({ code: "approval", tool: "mail_envoyer" })).toBe("attend ton approbation : mail_envoyer");
    expect(activityText({ code: "run_failed" })).toBe("le dernier passage a échoué");
    expect(activityText({ code: "snippet", text: "je lis" })).toBe("je lis");
    setShellLang("en");
    expect(activityText({ code: "approval", tool: "mail_envoyer" })).toBe("waiting for your approval: mail_envoyer");
    expect(activityText({ code: "agent_paused" })).toBe("agent paused");
    expect(activityText({ code: "future_code" })).toBeNull();
    expect(activityText(null)).toBeNull();
    expect(entryName({ ...e("c", "idle"), name: "", kind: "code" })).toBe("Code session");
  });
});
