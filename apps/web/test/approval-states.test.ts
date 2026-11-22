import { describe, expect, it } from "vitest";
import type { Bubble } from "@nokker-apps/sdk";
import { approvalTitle } from "../src/approvals/title.js";
import { approvalStatusLabel } from "../src/ops/model.js";
import { chipTone, statusLabel } from "../src/bubbles/kinds.js";
import { setShellLang } from "../src/i18n/index.js";

const bubble = (status: string, state: Record<string, unknown>): Bubble => ({ id: "b1", kind: "approval", status, state: { approval_id: "appr_1", tool_name: "terminal", ...state } } as unknown as Bubble);

describe("carte d'approbation : « en cours » et « interrompue » (jamais « en échec » ni le mot brut)", () => {
  it("titre : une carte en cours d'exécution n'est ni à décider ni en échec", () => {
    setShellLang("en");
    expect(approvalTitle({ state: { status: "executing", tool_name: "terminal" } })).toBe("Action in progress");
    expect(approvalTitle({ state: { status: "executing", tool_name: "terminal" } })).not.toMatch(/fail/i);
    expect(approvalTitle({ state: { status: "interrupted" } })).toBe("Action interrupted");
    expect(approvalTitle({ state: { status: "failed" } })).toBe("Action failed"); // un vrai échec le reste
    expect(approvalTitle({ state: { status: "pending" } })).toBe("Action to approve");
    setShellLang("fr");
    expect(approvalTitle({ state: { status: "executing" } })).toBe("Action en cours");
    expect(approvalTitle({ state: { status: "interrupted" } })).toBe("Action interrompue");
    setShellLang(null);
  });

  it("libellés d'état : plus de « executing » brut ; exécutée / interrompue / en échec dits", () => {
    setShellLang("en");
    expect(approvalStatusLabel("executing")).toBe("in progress");
    expect(approvalStatusLabel("executed")).toBe("executed");
    expect(approvalStatusLabel("interrupted")).toBe("interrupted");
    expect(approvalStatusLabel("failed")).toBe("failed");
    setShellLang("fr");
    expect(approvalStatusLabel("executing")).toBe("en cours");
    expect(approvalStatusLabel("executed")).toBe("exécutée");
    expect(approvalStatusLabel("interrupted")).toBe("interrompue");
    setShellLang(null);
  });

  it("en-tête de la bulle : l'état de la CARTE prime sur le statut working de la bulle", () => {
    setShellLang("en");
    // Le noyau garde la bulle `working` tant que la carte attend OU s'exécute : seul `state.status` les distingue.
    expect(statusLabel(bubble("working", { status: "pending" }), 0)).toBe("pending");
    expect(statusLabel(bubble("working", { status: "executing" }), 0)).toBe("in progress");
    expect(statusLabel(bubble("done", { status: "executed" }), 0)).toBe("executed");
    expect(statusLabel(bubble("failed", { status: "interrupted" }), 0)).toBe("interrupted");
    expect(statusLabel(bubble("failed", { status: "failed" }), 0)).toBe("failed");
    expect(statusLabel(bubble("done", { status: "approved" }), 0)).toBe("approved"); // inchangé
    expect(statusLabel(bubble("working", {}), 0)).toBe("pending"); // noyau sans state.status : comme avant
    setShellLang("fr");
    expect(statusLabel(bubble("working", { status: "executing" }), 0)).toBe("en cours");
    setShellLang(null);
  });

  it("les six états d'une carte (+ expirée) : l'en-tête, le titre et la pastille disent la même chose, jamais « approuvée » pour une refusée", async () => {
    setShellLang("en");
    const cases: Array<[string, "working" | "done" | "failed", string, string, string]> = [
      // état de la carte, statut de bulle, en-tête, titre, pastille
      ["pending", "working", "pending", "Action to approve", "to decide"],
      ["executing", "working", "in progress", "Action in progress", "in progress"],
      ["executed", "done", "executed", "Action approved", "executed"],
      ["rejected", "done", "rejected", "Action refused", "rejected"],
      ["rejected", "failed", "rejected", "Action refused", "rejected"], // quel que soit le statut de la bulle
      ["interrupted", "failed", "interrupted", "Action interrupted", "interrupted"],
      ["failed", "failed", "failed", "Action failed", "failed"],
      ["expired", "done", "expired", "Action expired", "expired"],
    ];
    for (const [card, bubbleStatus, head, title, chip] of cases) {
      const b = bubble(bubbleStatus, { status: card });
      expect([card, bubbleStatus, statusLabel(b, 0), approvalTitle(b), approvalStatusLabel(card)]).toEqual([card, bubbleStatus, head, title, chip]);
    }
    setShellLang("fr");
    expect(statusLabel(bubble("done", { status: "rejected" }), 0)).toBe("refusée");
    expect(approvalTitle(bubble("done", { status: "rejected" }))).toBe("Action refusée");
    setShellLang(null);
  });

  it("la phrase « interrompue » dit la même chose sur toutes les surfaces (texte EN gelé côté noyau : « outcome »)", async () => {
    const { FR } = await import("../src/i18n/fr.js");
    expect(FR["Interrupted: the outcome is unknown, please check."]).toBe("Interrompue : le résultat est inconnu, à vérifier.");
    expect(FR["Interrupted: the result is unknown, please check."]).toBeUndefined();
  });

  it("pastille : teinte par état (neutre en cours, à vérifier si interrompue), toujours avec son libellé", () => {
    expect(chipTone("executed")).toBe("ok");
    expect(chipTone("approved")).toBe("ok");
    expect(chipTone("executing")).toBe("running");
    expect(chipTone("interrupted")).toBe("warn");
    for (const s of ["rejected", "expired", "failed"]) expect(chipTone(s)).toBe("ko");
  });
});
