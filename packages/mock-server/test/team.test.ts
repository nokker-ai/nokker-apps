import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
});
afterEach(async () => {
  await mock.close();
});

const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } } | undefined)?.error?.code };
  }
};
const byName = async (name: string) => (await c.listProjects()).projects.find((p) => p.name === name)!;

describe("projets d'équipe (X17)", () => {
  it("sans session : 401", async () => {
    expect((await fail(new NokkerClient({ baseUrl: mock.url }).listProjects())).status).toBe(401);
  });

  it("démo : deux projets, une invitation en attente, rôles par projet", async () => {
    const l = await c.listProjects();
    expect(l.projects.map((p) => [p.name, p.role])).toEqual([
      ["Site vitrine", "owner"],
      ["Recherche", "viewer"],
    ]);
    expect(l.invitations).toBe(1);
    expect((await c.listMyInvitations()).invitations[0]).toMatchObject({ project: { name: "Compta partagée" }, role: "member" });
  });

  it("projet inconnu : 404, comme un non-membre", async () => {
    expect((await fail(c.getProject("pj_000000000000"))).status).toBe(404);
    expect((await fail(c.listProjectMembers("pj_000000000000"))).status).toBe(404);
  });

  it("lecture seule : un viewer lit tout et n'écrit rien (403 forbidden)", async () => {
    const r = await byName("Recherche");
    expect((await c.listProjectMembers(r.id)).members.length).toBeGreaterThan(1);
    expect(await fail(c.putProjectRules(r.id, { ask: ["terminal"], deny: [] }))).toEqual({ status: 403, code: "forbidden" });
    expect(await fail(c.putProjectSecret(r.id, "CLE"))).toEqual({ status: 403, code: "forbidden" });
    expect(await fail(c.inviteToProject(r.id, "x@example.com"))).toEqual({ status: 403, code: "forbidden" });
  });

  it("règles : restreindre seulement (allow ou mode auto → 400 rules_widen)", async () => {
    const s = await byName("Site vitrine");
    expect(await fail(c.putProjectRules(s.id, { ask: [], deny: [], allow: [] } as never))).toEqual({ status: 400, code: "rules_widen" });
    expect(await fail(c.putProjectRules(s.id, { mode: "auto", ask: [], deny: [] } as never))).toEqual({ status: 400, code: "rules_widen" });
    expect((await c.putProjectRules(s.id, { mode: "plan", ask: ["terminal(git push*)"], deny: [] })).rules).toMatchObject({ mode: "plan" });
  });

  it("secrets : des noms, jamais une valeur", async () => {
    const s = await byName("Site vitrine");
    const r = await fetch(`${mock.url}/v1/projects/${s.id}/secrets/CLE_X`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${(c as unknown as { token: string }).token}` },
      body: JSON.stringify({ value: "chut" }),
    });
    expect(r.status).toBe(400);
    expect(await c.putProjectSecret(s.id, "CLE_X", "essai")).toMatchObject({ name: "CLE_X" });
    expect((await c.listProjectSecrets(s.id)).secrets.map((x) => x.name)).toContain("CLE_X");
  });

  it("accepter une invitation donne le rôle de l'invitation ; le propriétaire reste fixe", async () => {
    const iv = (await c.listMyInvitations()).invitations[0]!;
    expect(await c.answerInvitation(iv.id, true)).toMatchObject({ name: "Compta partagée", role: "member" });
    expect((await c.listProjects()).invitations).toBe(0);
    const s = await byName("Site vitrine");
    const me = (await c.listProjectMembers(s.id)).members.find((m) => m.you)!;
    expect((await fail(c.setProjectMemberRole(s.id, me.account_id, "member"))).code).toBe("owner_fixed");
  });

  it("notes : seulement en miroir", async () => {
    const s = await byName("Site vitrine");
    expect((await c.listProjectNotes(s.id)).notes.length).toBeGreaterThan(0);
    expect(await fail(c.listProjectNotes((await byName("Recherche")).id))).toMatchObject({ status: 409, code: "mirror_off" });
  });
});
