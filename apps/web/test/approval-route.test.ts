import { describe, expect, it } from "vitest";
import { approvalIdFromPath } from "../src/approvals/path.js";

describe("route /approvals/:id", () => {
  it("extrait l'identifiant", () => {
    expect(approvalIdFromPath("/approvals/abc-123")).toBe("abc-123");
    expect(approvalIdFromPath("/approvals/abc-123/")).toBe("abc-123");
    expect(approvalIdFromPath("/approvals/a%20b")).toBe("a b");
  });
  it("ignore les autres chemins", () => {
    for (const p of ["/", "/invite", "/approvals", "/approvals/", "/approvals/a/b", "/x/approvals/a", "/approvals/%E0%A4%A"]) {
      expect(approvalIdFromPath(p)).toBeNull();
    }
  });
});
