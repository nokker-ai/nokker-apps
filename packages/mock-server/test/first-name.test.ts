import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock.close();
});
const err = (e: unknown): unknown => {
  const b = (e as NokkerApiError).body as { error?: unknown };
  return typeof b?.error === "string" ? b.error : (b?.error as { code?: string })?.code;
};

describe("prénom du membre (noyau p2/member-first-name ebb9ae3)", () => {
  it("Mon compte : prénom posé, refusé (chiffre, balisage, > 40), effacé ; le nom montré retombe sur l'adresse", async () => {
    mock = await startMockServer({ speed: 0.01, household: "payer" });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const a = await c.getAccount();
    expect(a.first_name).toBe("");
    expect(a.name).toBe(a.email.split("@")[0]);
    expect(await c.setFirstName("  Anne-Marie  O'Neil ")).toEqual({ first_name: "Anne-Marie O'Neil", name: "Anne-Marie O'Neil" });
    expect((await c.getAccount()).name).toBe("Anne-Marie O'Neil");
    for (const bad of ["R2D2", "<b>x</b>", "x".repeat(41)]) expect(err(await c.setFirstName(bad).catch((e) => e))).toBe("bad_first_name");
    expect((await c.setFirstName("")).name).toBe(a.email.split("@")[0]);
  });
  it("foyer : prénom à l'invitation ; `name` de chaque membre (prénom, sinon la partie locale)", async () => {
    mock = await startMockServer({ speed: 0.01, household: "payer" });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const h = await c.getHousehold();
    const byId = Object.fromEntries(h.members.map((m) => [m.account_id, m]));
    expect([byId.lea?.first_name, byId.lea?.name]).toEqual(["Léa", "Léa"]);
    expect([byId.sam?.first_name, byId.sam?.name]).toEqual(["", "sam"]);
    const iv = await c.inviteToHousehold("camille@example.org", "adult", undefined, "Camille");
    expect(iv.first_name).toBe("Camille");
    expect(err(await c.inviteToHousehold("x@example.org", "adult", undefined, "X1").catch((e) => e))).toBe("bad_first_name");
  });
});
