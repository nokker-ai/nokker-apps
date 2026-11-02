import { describe, expect, it } from "vitest";
import { NOKKER_EVENT_TYPES, applyPlanMode, isPlanModeRefusal } from "../src/index.js";

describe("session mode helpers", () => {
  it("leaves plan mode for the first allowed mode that writes", () => {
    expect(applyPlanMode(["default", "accept_edits", "plan"])).toBe("accept_edits");
    expect(applyPlanMode(["plan", "default"])).toBe("default");
    expect(applyPlanMode(["plan"])).toBeNull();
  });
  it("recognises a refusal by plan mode only", () => {
    expect(isPlanModeRefusal({ is_error: true, reason: "plan_mode" })).toBe(true);
    expect(isPlanModeRefusal({ is_error: true })).toBe(false);
    expect(isPlanModeRefusal({ is_error: false, reason: "plan_mode" })).toBe(false);
  });
  it("knows the new events", () => {
    expect(NOKKER_EVENT_TYPES).toContain("session.mode");
    expect(NOKKER_EVENT_TYPES).toContain("todo.updated");
  });
});
