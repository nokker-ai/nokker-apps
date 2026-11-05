import { afterEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
import { approvalBubble, settleApprovalBubbles } from "../src/demo.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const card = (thread: string) => ({ id: "appr_x", thread_id: thread, tool_name: "send_email", status: "pending", decided_via: null }) as never;

describe("bulle approval posée par le noyau (drapeau approval_bubbles, noyau p2/approval-bubble)", () => {
  it("éteint : aucune bulle ; un client n'en pose jamais (400, drapeau éteint aussi)", async () => {
    mock = await startMockServer({ speed: 0.01, seed: false });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const t = await c.createThread("t");
    expect(approvalBubble(mock.state, card(t.id))).toBeNull();
    await expect(c.createBubble(t.id, { kind: "approval", state: { approval_id: "x" } } as never)).rejects.toMatchObject({ status: 400 });
  });

  it("allumé : titre = outil, état {approval_id, tool_name, status}, working ; décidée → done + vrai moyen, jamais fermée ; expirée → failed", async () => {
    mock = await startMockServer({ speed: 0.01, seed: false, approvalBubbles: true });
    const rec = mock.state.createThread("t", { members: ["alice"] });
    const b = approvalBubble(mock.state, card(rec.thread.id))!;
    expect(b).toMatchObject({ kind: "approval", title: "send_email", status: "working", state: { approval_id: "appr_x", tool_name: "send_email", status: "pending" } });
    settleApprovalBubbles(mock.state, { ...(card(rec.thread.id) as object), status: "rejected", decided_via: "webauthn" } as never);
    expect(mock.state.bubbles.get(b.id)).toMatchObject({ status: "done", closed_at: null, state: { status: "rejected", decided_via: "webauthn" } });
    settleApprovalBubbles(mock.state, { ...(card(rec.thread.id) as object), status: "expired" } as never);
    expect(mock.state.bubbles.get(b.id)?.status).toBe("failed");
  });
});
