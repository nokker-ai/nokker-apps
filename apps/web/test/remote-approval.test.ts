import { describe, expect, it } from "vitest";
import { isFinal, minutesLeftUntil, remoteTargetFrom } from "../src/approvals/remote.js";

describe("approbation à distance", () => {
  it("lien de notification et lien de passerelle", () => {
    expect(remoteTargetFrom("/approve/mc_0123abcd/ap_1", "")).toEqual({ kind: "id", machineId: "mc_0123abcd", approvalId: "ap_1" });
    expect(remoteTargetFrom("/approve", "?host=Atelier.nokker.app&approval=ap_1")).toEqual({ kind: "host", host: "atelier.nokker.app", approvalId: "ap_1" });
    expect(remoteTargetFrom("/approve/mc_x/../etc", "")).toBeNull();
    expect(remoteTargetFrom("/approve/mc%2Fx/ap", "")).toBeNull();
    expect(remoteTargetFrom("/approve", "?host=a.nokker.app")).toBeNull();
    expect(remoteTargetFrom("/approvals/x", "")).toBeNull();
  });
  it("statuts et délai", () => {
    expect(isFinal("forwarded")).toBe(false);
    expect(isFinal("expired")).toBe(true);
    expect(minutesLeftUntil(new Date(90_000).toISOString(), 0)).toBe(2);
    expect(minutesLeftUntil(new Date(0).toISOString(), 5)).toBe(0);
  });
});
