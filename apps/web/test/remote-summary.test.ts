import { describe, expect, it } from "vitest";
import { classBanner, isAccountConnectorTool, shortSha, truncatedSuffix } from "../src/approvals/remote.js";

describe("page /approve : ce que tu signes (X20c)", () => {
  it("bandeau seulement pour ce qui engage", () => {
    expect(classBanner("external_send")).toBe("Part chez quelqu'un d'autre");
    expect(classBanner("destructive")).toBe("Supprime");
    expect(classBanner("read")).toBeNull();
    expect(classBanner(null)).toBeNull();
  });
  it("extrait coupé, empreinte courte, connecteur du compte", () => {
    expect(truncatedSuffix(1240)).toMatch(/^… \(1.240 caractères en tout\)$/);
    expect(truncatedSuffix(undefined)).toBe("…");
    expect(shortSha("a".repeat(64))).toBe("a".repeat(12));
    expect(isAccountConnectorTool("mail_send")).toBe(true);
    expect(isAccountConnectorTool("calendar_create")).toBe(true);
    expect(isAccountConnectorTool("ssh_exec")).toBe(false);
  });
});
