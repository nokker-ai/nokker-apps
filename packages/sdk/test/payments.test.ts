import { describe, expect, it } from "vitest";
import { NOKKER_EVENT_TYPES, formatMinor, isPayApproval, minorToUnits, unitsToMinor } from "../src/index.js";

describe("payments amounts (core to_minor / format_minor)", () => {
  it("formats minor units like the core", () => {
    expect(formatMinor(12990, "CHF")).toBe("129.90 CHF");
    expect(formatMinor(5, "chf")).toBe("0.05 CHF");
    expect(formatMinor(1500, "JPY")).toBe("1500 JPY");
  });
  it("reads units: comma, apostrophe, half-up; refuses zero, negatives and junk", () => {
    expect(unitsToMinor("49.90", "CHF")).toBe(4990);
    expect(unitsToMinor("49,9", "CHF")).toBe(4990);
    expect(unitsToMinor("1'000", "CHF")).toBe(100000);
    expect(unitsToMinor(200, "CHF")).toBe(20000);
    expect(unitsToMinor("0.005", "CHF")).toBe(1);
    expect(unitsToMinor("10.994", "CHF")).toBe(1099);
    expect(unitsToMinor("1500", "JPY")).toBe(1500);
    for (const bad of ["0", "-5", "abc", "", "1e3", "12.3.4"]) expect(unitsToMinor(bad, "CHF")).toBeNull();
  });
  it("round-trips to the text a PUT takes", () => {
    expect(minorToUnits(20000, "CHF")).toBe("200");
    expect(minorToUnits(4990, "CHF")).toBe("49.90");
    expect(minorToUnits(1500, "JPY")).toBe("1500");
  });
  it("recognises a « to pay » card (also a minor's, whose rule is the guardian's) and the events", () => {
    expect(isPayApproval({ rule: "payments:to_pay", tool_name: "pay_request" })).toBe(true);
    expect(isPayApproval({ rule: "household:guardian", tool_name: "pay_request" })).toBe(true);
    expect(isPayApproval({ rule: "effect:destructive", tool_name: "infra_disk_purge" })).toBe(false);
    for (const t of ["payment.to_pay", "payment.mandate_signed", "payment.rejected", "payment.refused", "payment.budget_changed", "payment.agent"] as const) expect(NOKKER_EVENT_TYPES).toContain(t);
  });
});

describe("payment agent routes (core PAY-AGENT §8)", () => {
  it("calls the method and revoke routes with the contract's shapes", async () => {
    const { NokkerClient } = await import("../src/index.js");
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ challenge: "c", method: null, removed: true, publishable_key: "pk_test_x" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const c = new NokkerClient({ baseUrl: "http://core.example", fetchImpl });
    await c.getPayMethod();
    await c.payMethodChallenge("pm_1");
    await c.putPayMethod("pm_1", { challenge: "c", device_id: "dev_1", client_data_json: "a", authenticator_data: "b", signature: "s" });
    await c.deletePayMethod();
    await c.revokeAgentPayment("md_0123456789abcdef");
    expect(calls.map((x) => `${x.method} ${x.url.replace("http://core.example", "")}`)).toEqual([
      "GET /v1/payments/method",
      "POST /v1/payments/method/challenge",
      "PUT /v1/payments/method",
      "DELETE /v1/payments/method",
      "POST /v1/payments/mandates/md_0123456789abcdef/revoke",
    ]);
    expect(calls[1]!.body).toEqual({ payment_method: "pm_1" });
    expect(calls[2]!.body).toEqual({ payment_method: "pm_1", proof: { challenge: "c", device_id: "dev_1", client_data_json: "a", authenticator_data: "b", signature: "s" } });
  });
});
