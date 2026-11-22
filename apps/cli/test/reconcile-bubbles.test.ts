/** Reprise d'un fil : une bulle d'approbation « working » dont la carte n'existe plus ne tourne pas sans fin. */
import { describe, expect, it } from "vitest";
import { CliSession } from "../src/session.js";

const bubble = (id: string, approval: string) => ({ id, kind: "approval", title: "sites_connect", status: "working", closed_at: null, state: { approval_id: approval } }) as never;

function session(client: Record<string, unknown>): CliSession {
  return new CliSession(client as never, null, "th_x");
}

describe("reconcileBubbles", () => {
  it("la route des cartes du noyau refuse le jeton : la liste locale décide, la carte disparue n'anime plus", async () => {
    const s = session({
      listApprovals: async () => { throw new Error("403"); },
      listLocalApprovals: async () => [{ id: "appr_open", status: "pending" }],
      getApproval: async () => { throw new Error("404"); },
    });
    const out = await s.reconcileBubbles([bubble("b1", "appr_gone"), bubble("b2", "appr_open")]);
    expect(out.find((b) => b.id === "b1")!.status).toBe("idle");
    expect(out.find((b) => b.id === "b2")!.status).toBe("working"); // encore en attente : le spinner reste
  });

  it("aucune des deux routes ne répond : état inconnu, rien n'est inventé", async () => {
    const s = session({ listApprovals: async () => { throw new Error("x"); }, listLocalApprovals: async () => { throw new Error("x"); } });
    const list = [bubble("b1", "appr_gone")];
    expect(await s.reconcileBubbles(list)).toBe(list);
  });
});
