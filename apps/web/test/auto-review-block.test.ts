import { describe, expect, it } from "vitest";
import { rollbackReasonText } from "../src/approvals/AutoReviewBlock.js";

describe("raisons du point de retour (écrites en français par le noyau)", () => {
  it("les raisons connues passent par la traduction, les autres restent telles quelles", () => {
    expect(rollbackReasonText("aucun point de retour pour cette carte")).toBe("No restore point for this action.");
    expect(rollbackReasonText(undefined)).toBe("No restore point for this action.");
    expect(rollbackReasonText("restauration déjà appliquée")).toBe("The restore was already applied.");
    expect(rollbackReasonText("écriture non terminée")).toBe("The write did not finish: nothing to restore.");
    expect(rollbackReasonText("point incomplet")).toBe("The restore point is incomplete.");
    expect(rollbackReasonText("fichier trop gros")).toBe("fichier trop gros");
  });
});

import { appliedOf, isAutoDecided } from "../src/approvals/AutoReviewBlock.js";
import type { Approval } from "@nokker-apps/sdk";

describe("carte du relecteur automatique", () => {
  const card = (over: Partial<Approval>): Approval => ({ decided_via: "auto-review", auto_review: { decision: "approve", reason: "ok", at: null }, ...over }) as Approval;
  it("compacte tant que la décision automatique tient ; pleine une fois révoquée, escaladée ou décidée par un humain", () => {
    expect(isAutoDecided(card({}))).toBe(true);
    expect(isAutoDecided(card({ auto_review: { decision: "reject", reason: "", at: null } }))).toBe(true);
    expect(isAutoDecided(card({ auto_review: { decision: "approve", reason: "", at: null, revoked_by: "alice" } }))).toBe(false);
    expect(isAutoDecided(card({ auto_review: { decision: "escalate", reason: "", at: null } }))).toBe(false);
    expect(isAutoDecided(card({ decided_via: "webauthn" }))).toBe(false);
  });
  it("point déjà appliqué lu dans GET : applied true + listes, ou applied objet", () => {
    expect(appliedOf({ available: true, checkpoint_id: "c", files: ["a"] })).toBeNull();
    expect(appliedOf({ available: false, checkpoint_id: "c", applied: true, restored: ["a"], conflicts: ["b"] })).toEqual({ restored: ["a"], conflicts: ["b"] });
    expect(appliedOf({ available: false, checkpoint_id: "c", applied: { restored: ["a"] } })).toEqual({ restored: ["a"], conflicts: [] });
  });
});
