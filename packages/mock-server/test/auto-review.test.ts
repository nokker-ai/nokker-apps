import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";
import { autoReviewDemo } from "../src/auto-review.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01, seed: false });
  c = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
});
afterEach(async () => {
  await mock.close();
});

const lastCard = (tool: string) => [...mock.state.approvals.values()].filter((a) => a.tool_name === tool).at(-1)!;

describe("relecteur automatique : révocation et restauration (APPROVALS.md §8)", () => {
  it("écriture de fichier : révoquer propose le point, restaurer rend restored + conflicts, une seule fois", async () => {
    expect(autoReviewDemo(mock.state, "t1", "auto-review")).toBeTruthy();
    const card = lastCard("write_file");
    expect(card).toMatchObject({ status: "executed", decided_via: "auto-review", auto_review: { decision: "approve" } });
    await expect(c.rollbackAutoReview(card.id)).rejects.toMatchObject({ status: 409 }); // pas encore révoquée
    const r = await c.revokeAutoReview(card.id);
    expect(r.status).toBe("executed");
    expect(r.auto_review?.revoked_by).toBeTruthy();
    expect(r.rollback).toEqual({ available: true, checkpoint_id: card.id, files: ["notes/plan.md", "src/settings.json"], applied: false });
    await expect(c.revokeAutoReview(card.id)).rejects.toMatchObject({ status: 409 });
    const bubble = () => [...mock.state.bubbles.values()].find((b) => b.kind === "approval" && b.state.approval_id === card.id)!;
    expect(bubble()).toMatchObject({ title: "write_file", status: "done", state: { decided_via: "auto-review", decision: "approve", revoked: true } });
    expect(await c.rollbackAutoReview(card.id)).toEqual({ approval_id: card.id, checkpoint_id: card.id, restored: ["notes/plan.md"], conflicts: ["src/settings.json"] });
    await expect(c.rollbackAutoReview(card.id)).rejects.toMatchObject({ status: 409 });
    // Après un rechargement : la carte porte son point, appliqué, avec ce qui a été remis en place.
    expect(bubble().state).toMatchObject({ revoked: true, rollback_applied: true });
    expect((await c.getApproval(card.id)).rollback).toMatchObject({ available: false, applied: true, restored: ["notes/plan.md"], conflicts: ["src/settings.json"] });
  });

  it("GET d'une approbation révoquée non restaurée : le point est proposé ; non révoquée : aucun point", async () => {
    autoReviewDemo(mock.state, "t1", "auto-review");
    const card = lastCard("write_file");
    expect((await c.getApproval(card.id)).rollback).toBeUndefined();
    await c.revokeAutoReview(card.id);
    expect((await c.getApproval(card.id)).rollback).toMatchObject({ available: true, files: ["notes/plan.md", "src/settings.json"], applied: false });
  });

  it("écriture hors fichiers : pas de point, available false avec la raison", async () => {
    autoReviewDemo(mock.state, "t1", "auto-review agenda");
    const r = await c.revokeAutoReview(lastCard("calendar_create_event").id);
    expect(r.rollback).toMatchObject({ available: false, reason: "aucun point de retour pour cette carte" });
  });

  it("refus révoqué : la carte revient en attente, sans point de retour", async () => {
    autoReviewDemo(mock.state, "t1", "auto-review refus");
    const card = lastCard("write_file");
    expect(card.status).toBe("rejected");
    expect([...mock.state.bubbles.values()].some((b) => b.kind === "approval" && b.state.approval_id === card.id)).toBe(false); // pas de bulle pour un refus
    const r = await c.revokeAutoReview(card.id);
    expect(r).toMatchObject({ status: "pending", decided_via: null });
    expect(r.rollback).toBeUndefined();
  });

  it("relecteur éteint : 404", async () => {
    process.env.MOCK_AUTO_REVIEW = "off";
    try {
      await expect(c.revokeAutoReview("appr_x")).rejects.toMatchObject({ status: 404 });
    } finally {
      delete process.env.MOCK_AUTO_REVIEW;
    }
  });
});
