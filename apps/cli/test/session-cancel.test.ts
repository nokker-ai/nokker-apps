/** `/cancel` et Échap : le noyau répond `cancelled: "<id du fil>"` (chaîne), pas un booléen — la CLI disait alors
 * « No turn in progress. » alors que l'annulation était bien prise en compte. */
import { describe, expect, it } from "vitest";
import type { NokkerClient } from "@nokker-apps/sdk";
import { CliSession } from "../src/session.js";

const sessionWith = (reply: unknown): CliSession => new CliSession({ cancelTurn: async () => reply } as unknown as NokkerClient, null, "th_x");

describe("CliSession.cancel", () => {
  it("id de fil (noyau) ou booléen (mock) = annulation prise en compte", async () => {
    expect(await sessionWith({ cancelled: "th_x", approvals_cancelled: 0 }).cancel()).toBe(true);
    expect(await sessionWith({ cancelled: true, approvals_cancelled: 0 }).cancel()).toBe(true);
  });
  it("rien d'annulé : false", async () => {
    expect(await sessionWith({ cancelled: false, approvals_cancelled: 0 }).cancel()).toBe(false);
    expect(await sessionWith({ cancelled: "", approvals_cancelled: 0 }).cancel()).toBe(false);
  });
  it("noyau du 01.11 : `running` décide, l'id du fil n'est qu'un accusé de réception", async () => {
    expect(await sessionWith({ cancelled: "th_x", approvals_cancelled: 0, running: false }).cancel()).toBe(false);
    expect(await sessionWith({ cancelled: "th_x", approvals_cancelled: 0, running: true }).cancel()).toBe(true);
    // Une carte retirée sans tour en cours : rien ne tournait.
    expect(await sessionWith({ cancelled: "th_x", approvals_cancelled: 1, running: false }).cancel()).toBe(false);
  });
});
