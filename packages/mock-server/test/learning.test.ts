import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let local: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01, seed: false });
  local = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
});
afterEach(async () => {
  await mock.close();
});

describe("apprentissage (mock, formes du noyau)", () => {
  it("notes en attente : approuver écrit le journal, deux fois = 409", async () => {
    const { notes } = await local.listPendingMemory();
    expect(notes).toHaveLength(2);
    const r = await local.decidePendingMemory(notes[0]!.id, "approve");
    expect(r.note.status).toBe("approved");
    expect(r.note.result).toBeTruthy();
    await expect(local.decidePendingMemory(notes[0]!.id, "reject")).rejects.toMatchObject({ status: 409 });
    expect((await local.listPendingMemory()).notes).toHaveLength(1);
    expect((await local.getLearningJournal(1)).entries[0]!.kind).toBe("memory.approved");
  });

  it("skills : versions, diff, retour, désactivation (0), 409 unchanged", async () => {
    const { skills } = await local.listLearnedSkills();
    expect(skills[0]).toMatchObject({ name: "deploy-docs", version: 2, active: true });
    const d = await local.getLearnedSkill("deploy-docs", { version: 2, diffFrom: 1 });
    expect(d.versions).toHaveLength(2);
    expect(d.version?.content).toContain("Vérifier les liens");
    expect(d.diff).toMatch(/^--- deploy-docs@v1\n\+\+\+ deploy-docs@v2/);
    expect(d.diff).toContain("+2. Vérifier les liens.");
    const r = await local.revertLearnedSkill("deploy-docs", 1);
    expect(r).toMatchObject({ op: "revert", version: 3, reverted_to: 1, active: true });
    await expect(local.revertLearnedSkill("deploy-docs", 1)).rejects.toMatchObject({ status: 409 });
    expect(await local.revertLearnedSkill("deploy-docs", 0)).toMatchObject({ op: "disable", active: false });
    expect((await local.listLearnedSkills()).skills[0]!.active).toBe(false);
  });

  it("règles suggérées : accepter en local, 409 no_rule_store au nuage, écarter partout", async () => {
    const s = await local.listApprovalSuggestions();
    expect(s.rule_store).toBe("user_settings");
    expect((await local.decideApprovalSuggestion(s.suggestions[0]!.id, "accept")).state).toBe("accepted");
    const cloud = new NokkerClient({ baseUrl: mock.url, token: "us_demo_token" });
    const c = await cloud.listApprovalSuggestions().catch((e) => e);
    if (c && "suggestions" in c) {
      expect(c.rule_store).toBeNull();
      await expect(cloud.decideApprovalSuggestion(c.suggestions[0]!.id, "accept")).rejects.toMatchObject({ status: 409 });
      expect((await cloud.decideApprovalSuggestion(c.suggestions[0]!.id, "dismiss")).state).toBe("dismissed");
    }
  });
});
