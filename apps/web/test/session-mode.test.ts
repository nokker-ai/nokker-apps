import { describe, expect, it } from "vitest";
import { modeTarget } from "../src/modes/SessionModeBar.js";

describe("modeTarget", () => {
  it("a local session under the local token, a code session by its id, nothing for a chat thread", () => {
    expect(modeTarget("th_1", "/work/proj", true)).toEqual({ kind: "local", threadId: "th_1" });
    expect(modeTarget("th_1", "/work/proj", false)).toBeNull();
    expect(modeTarget("cs_abc", undefined, false)).toEqual({ kind: "code", threadId: "cs_abc", sessionId: "cs_abc" });
    expect(modeTarget("t_9:cs_abc", undefined, false)).toEqual({ kind: "code", threadId: "t_9:cs_abc", sessionId: "cs_abc" });
    expect(modeTarget("th_2", undefined, false)).toBeNull();
    expect(modeTarget(null, undefined, true)).toBeNull();
  });
});

describe("refusalText", () => {
  it("one sentence per core reason, a generic one otherwise", async () => {
    const { refusalText } = await import("../src/modes/SessionModeBar.js");
    const { setShellLang } = await import("../src/i18n/index.js");
    setShellLang("en");
    expect(refusalText("plan_mode")).toMatch(/^Plan mode/);
    expect(refusalText("deny_rule")).toMatch(/deny rule/);
    expect(refusalText("hardline")).toMatch(/never runs/);
    expect(refusalText("no_code_session")).toMatch(/code session/);
    expect(refusalText("quota")).toBe("An action was refused (quota).");
    setShellLang(null);
  });
});
