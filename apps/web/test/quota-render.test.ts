import { describe, expect, it } from "vitest";
import { isQuotaError, QUOTA_EXCEEDED } from "@nokker-apps/sdk";

describe("quota atteint : le rendu s'accroche au code, pas au texte", () => {
  it("quota_exceeded est reconnu, retry_at facultatif", () => {
    expect(QUOTA_EXCEEDED).toBe("quota_exceeded");
    expect(isQuotaError({ code: "quota_exceeded", message: "x" })).toBe(true);
    expect(isQuotaError({ code: "quota_exceeded", message: "x", retry_at: "2026-12-01T00:00:00Z" })).toBe(true);
  });
  it("une panne, un tour réussi ou un noyau plus ancien ne sont pas un quota", () => {
    expect(isQuotaError({ code: "provider_error", message: "upstream 502" })).toBe(false);
    expect(isQuotaError({ code: "max_calls", message: "x" })).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});
