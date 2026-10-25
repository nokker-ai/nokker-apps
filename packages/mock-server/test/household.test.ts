import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
const start = async (household: "off" | "payer" | "member" | "minor" | "none"): Promise<NokkerClient> => {
  mock = await startMockServer({ speed: 0.01, household });
  const c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
  return c;
};
afterEach(async () => {
  await mock.close();
});
const code = async (p: Promise<unknown>): Promise<string | number> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (!(e instanceof NokkerApiError)) throw e;
    const b = e.body as { error?: { code?: string } } | undefined;
    return b?.error?.code ?? e.status;
  }
};

describe("foyer (X23, §7.29)", () => {
  it("drapeau éteint : 404 partout, comme le noyau", async () => {
    const c = await start("off");
    expect(await code(c.getHousehold())).toBe("not_found");
    expect(await code(c.listReceivedHouseholdInvitations())).toBe("not_found");
  });

  it("payeur : quota commun = somme des tours, membres, invitation en attente comptée", async () => {
    const c = await start("payer");
    const h = await c.getHousehold();
    expect(h.you).toMatchObject({ payer: true, profile: "adult" });
    expect(h.members).toHaveLength(3);
    expect(h.quota.today).toMatchObject({ used: 14 + 22 + 9, cap: 110 });
    expect(h.quota.week.cap).toBe(550);
    expect(h).toMatchObject({
      size: 3,
      counted: 4,
      max_members: 6,
      minors: { enabled: true },
    });
    expect(h.invitations).toHaveLength(1);
  });

  it("6 au plus, payeur et invitations en attente compris", async () => {
    const c = await start("payer");
    expect(await c.inviteToHousehold("a@example.org")).toMatchObject({
      state: "pending",
    });
    expect(await c.inviteToHousehold("b@example.org")).toMatchObject({
      state: "pending",
    });
    expect(await code(c.inviteToHousehold("c@example.org"))).toBe("household_full");
    expect(await code(c.inviteToHousehold("sam@example.com"))).toBe("already_member");
  });

  it("mineur : attestation exigée, version = sha256 du texte, périmée → 409", async () => {
    const c = await start("payer");
    expect(await code(c.inviteToHousehold("kid@example.org", "child"))).toBe("attestation_required");
    expect(
      await code(
        c.inviteToHousehold("kid@example.org", "child", {
          version: "x",
          lang: "fr",
          legal_guardian: true,
        }),
      ),
    ).toBe("attestation_stale");
    const t = await c.getHouseholdConsentText("fr");
    expect(t.version).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await c.inviteToHousehold("kid@example.org", "child", {
        version: t.version,
        lang: "fr",
        legal_guardian: true,
      }),
    ).toMatchObject({ profile: "child" });
    expect((await c.listHouseholdConsents()).consents.filter((x) => x.active)).toHaveLength(2);
  });

  it("plafond : personnalisé, aucun, retour au défaut ; retrait du consentement = suspendu", async () => {
    const c = await start("payer");
    expect((await c.setHouseholdCap("sam", 25)).cap).toEqual({
      turns_per_day: 25,
      source: "custom",
    });
    expect((await c.setHouseholdCap("sam", null)).cap).toEqual({
      turns_per_day: null,
      source: "none",
    });
    expect((await c.resetHouseholdCap("sam")).cap).toEqual({
      turns_per_day: 40,
      source: "default",
    });
    expect((await c.revokeHouseholdConsent("lea")).status).toBe("suspended");
    expect(await code(c.revokeHouseholdConsent("sam"))).toBe("not_minor");
    expect(await code(c.removeHouseholdMember("alice"))).toBe("payer_fixed");
  });

  it("liste blanche : les deux listes remplacées à chaque PUT", async () => {
    const c = await start("payer");
    expect(await c.setHouseholdPolicy({ minor_agents: ["devoirs"] })).toEqual({
      minor_connectors: [],
      minor_agents: ["devoirs"],
    });
  });

  it("carte d'un mineur : défi puis preuve forte ; une clé d'appareil seule est refusée", async () => {
    const c = await start("payer");
    const [card] = (await c.listHouseholdApprovals()).approvals;
    expect(card!.member.profile).toBe("teen");
    const { challenge } = await c.householdApprovalChallenge(card!.approval.id, "lea");
    expect(
      await code(
        c.householdApprovalDecision(card!.approval.id, {
          member: "lea",
          decision: "approve",
          challenge,
          device_id: "d1",
          signature: "s",
        }),
      ),
    ).toBe("strong_device_required");
    const r = await c.householdApprovalDecision(card!.approval.id, {
      member: "lea",
      decision: "reject",
      challenge,
      device_id: "d1",
      webauthn: {
        client_data_json: "a",
        authenticator_data: "b",
        signature: "c",
      },
    });
    expect(r.status).toBe("rejected");
    expect((await c.listHouseholdApprovals()).approvals).toHaveLength(0);
  });

  it("notes : base_sha périmé → l'ancienne version part à l'historique, restaurable", async () => {
    const c = await start("payer");
    const { notes } = await c.listHouseholdNotes();
    const n = notes.find((x) => x.name === "fact-allergies-3c4d")!;
    const r = await c.putHouseholdNote(n.name, {
      kind: "fact",
      title: "Allergies",
      text: "Arachides et kiwi.",
      base_sha: "ancien",
    });
    expect(r).toMatchObject({ accepted: 1, quarantined: 1 });
    const q = (await c.listHouseholdQuarantine()).quarantine.find((x) => x.name === n.name)!;
    expect((await c.restoreHouseholdQuarantine(q.id)).note.text).toContain("arachides");
  });

  it("membre : sa ligne seulement, pas d'invitations ; quitte le foyer", async () => {
    const c = await start("member");
    const h = await c.getHousehold();
    expect(h.members.map((m) => m.account_id)).toEqual(["alice"]);
    expect(h.invitations).toBeUndefined();
    expect(await code(c.listHouseholdApprovals())).toBe("forbidden");
    expect((await c.getAccountUsage()).household).toMatchObject({
      member: { cap: 40, source: "default" },
    });
    expect(await c.removeHouseholdMember("alice")).toEqual({ removed: true });
  });

  it("mineur : ne quitte pas seul, entraînement verrouillé", async () => {
    const c = await start("minor");
    expect(await code(c.removeHouseholdMember("alice"))).toBe("minor_cannot_leave");
    expect((await c.getAccount()).consents).toEqual({
      training: false,
      training_locked: "minor",
    });
    expect(await code(c.setAccountConsent("training", true))).toBe("minor_training_refused");
  });

  it("sans foyer : invitation reçue, acceptée → membre", async () => {
    const c = await start("none");
    expect(await code(c.getHousehold())).toBe("not_found");
    const [iv] = (await c.listReceivedHouseholdInvitations()).invitations;
    const h = (await c.answerHouseholdInvitation(iv!.id, true)) as {
      name: string;
      you: { payer: boolean };
    };
    expect(h).toMatchObject({ name: "Foyer de Bob", you: { payer: false } });
  });
});
