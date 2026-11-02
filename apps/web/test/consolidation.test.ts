import { afterEach, describe, expect, it } from "vitest";
import { nightSummary, opKindLabel } from "../src/learning/Consolidations.js";
import { setShellLang } from "../src/i18n/index.js";

afterEach(() => setShellLang(null));

describe("consolidations", () => {
  it("the night in words, in the interface language (the core's summary is French)", () => {
    setShellLang("en");
    expect(nightSummary({ counts: { merge: 2, correct: 1, archive: 0, lesson: 1 } })).toBe("2 merges, 1 correction, 1 lesson");
    expect(nightSummary({ counts: {} })).toBe("nothing to change");
    setShellLang("fr");
    expect(nightSummary({ counts: { archive: 3, summarize: 1 } })).toBe("3 notes archivées, 1 résumé");
  });
  it("one label per operation kind", () => {
    setShellLang("en");
    expect((["merge", "correct", "archive", "summarize", "lesson"] as const).map(opKindLabel)).toEqual(["merge", "correction", "archive", "summary", "lesson"]);
  });
});
