import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock?.close();
});
async function boot(): Promise<NokkerClient> {
  mock = await startMockServer({ speed: 0.01, code: true, configDir: null });
  const c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
  return c;
}
const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } }).error?.code };
  }
};
const dev = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${mock.url}/v1/dev/code-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = <T>(r: unknown): T => JSON.parse((r as { content: string }).content) as T;

describe("sessions de code : skills du dépôt (§7.28.13)", () => {
  it("sans dépôt : absent ; avec dépôt : untrusted, confiance pour CETTE empreinte, puis skill_list et skill_view", async () => {
    const c = await boot();
    const bare = await c.createCodeSession();
    expect(bare.skills).toMatchObject({ enabled: true, project: "absent", sha256: null, count: 0 });
    expect(bare.subagents).toEqual({ limit: 3, live: 0 });
    expect(await fail(c.trustCodeSessionSkills(bare.id, "x"))).toEqual({ status: 404, code: "skills_absent" });

    const s = await c.createCodeSession({ repo: { url: "https://git.example.org/acme/app.git" } });
    expect(s.skills).toMatchObject({ project: "untrusted", root: "/workspace", count: 2 });
    expect(json<{ skills: unknown[] }>(await c.callCodeSessionTool(s.id, "skill_list")).skills).toEqual([]);
    expect(await fail(c.trustCodeSessionSkills(s.id, "0".repeat(64)))).toEqual({ status: 409, code: "skills_changed" });
    expect(await c.trustCodeSessionSkills(s.id, s.skills!.sha256!)).toEqual({ thread_id: s.id, root: "/workspace", sha256: s.skills!.sha256, trusted: true });
    expect((await c.getCodeSession(s.id)).skills?.project).toBe("trusted");
    const list = json<{ skills: { name: string; source: string }[] }>(await c.callCodeSessionTool(s.id, "skill_list"));
    expect(list.skills.map((k) => [k.name, k.source])).toEqual([
      ["release-notes", "project"],
      ["test-runner", "project"],
    ]);
    const view = json<{ content: string; linked_files: string[] }>(await c.callCodeSessionTool(s.id, "skill_view", { name: "release-notes" }));
    expect(view.content).toContain("# Notes de version");
    expect(view.linked_files).toEqual(["templates/changelog.md"]);
    expect(await c.callCodeSessionTool(s.id, "skill_view", { name: "nope" })).toMatchObject({ is_error: true });
  });

  it("arbre réécrit : untrusted de nouveau, nouvelle empreinte, événement skill.untrusted ; lien symbolique : invalid", async () => {
    const c = await boot();
    const events: NokkerEvent[] = [];
    const sub = c.subscribeEvents({ onEvent: (e) => events.push(e) });
    const s = await c.createCodeSession({ repo: { url: "https://git.example.org/acme/app.git" } });
    await c.trustCodeSessionSkills(s.id, s.skills!.sha256!);
    await dev({ skills: { session: s.id, action: "rewrite" } });
    const again = await c.getCodeSession(s.id);
    expect(again.skills?.project).toBe("untrusted");
    expect(again.skills?.sha256).not.toBe(s.skills!.sha256);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.find((e) => e.type === "skill.untrusted")).toMatchObject({ session_id: s.id, sha256: again.skills!.sha256, count: 2 });
    await dev({ skills: { session: s.id, action: "invalid" } });
    expect((await c.getCodeSession(s.id)).skills?.project).toBe("invalid");
    expect(await fail(c.trustCodeSessionSkills(s.id, "x"))).toEqual({ status: 404, code: "skills_absent" });
    sub.close();
  });
});

describe("sessions de code : sous-agents (§7.28.14)", () => {
  it("vivants sur plafond, état, arrêt, événements, carte sur le fil de l'enfant, arrêt à la fermeture", async () => {
    const c = await boot();
    const events: NokkerEvent[] = [];
    const sub = c.subscribeEvents({ onEvent: (e) => events.push(e) });
    const s = await c.createCodeSession({ repo: { url: "https://git.example.org/acme/app.git" } });
    await dev({ spawn: { session: s.id, goal: "corriger les tests" } });
    await dev({ spawn: { session: s.id, card: true } });
    expect((await c.getCodeSession(s.id)).subagents).toEqual({ limit: 3, live: 2 });
    const st = json<{ children: { child_id: string; status: string; goal: string; thread_id: string }[]; running: number }>(await c.callCodeSessionTool(s.id, "delegate_status"));
    expect(st.running).toBe(2);
    expect(st.children[0]).toMatchObject({ child_id: "sa1", status: "running", goal: "corriger les tests", thread_id: `${s.id}/sa-sa1` });
    expect(await fail(c.callCodeSessionTool(s.id, "delegate_status", { wait_s: 5 }))).toEqual({ status: 400, code: "bad_arguments" });
    expect(await fail(c.callCodeSessionTool(s.id, "delegate" as never))).toEqual({ status: 403, code: "tool_not_allowed" });
    // La carte de l'enfant est sur SON fil, dans le flux habituel des cartes.
    const cards = (await c.listApprovals("pending")).filter((a) => a.thread_id === `${s.id}/sa-sa2`);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ tool_name: "terminal", strength: "strong" });
    // Arrêt d'un enfant.
    expect(json(await c.callCodeSessionTool(s.id, "delegate_cancel", { ids: ["sa1", "zz"] }))).toEqual({ cancelled: ["sa1"], unknown: ["zz"] });
    expect((await c.getCodeSession(s.id)).subagents?.live).toBe(1);
    await dev({ finish: { session: s.id, child: "sa2" } });
    expect((await c.getCodeSession(s.id)).subagents?.live).toBe(0);
    // Plafond.
    for (let i = 0; i < 3; i++) await dev({ spawn: { session: s.id } });
    expect((await dev({ spawn: { session: s.id } })).status).toBe(409);
    // Fermeture : les enfants sont arrêtés.
    await c.closeCodeSession(s.id);
    await new Promise((r) => setTimeout(r, 50));
    const types = events.filter((e) => e.type.startsWith("subagent.")).map((e) => e.type);
    expect(types.filter((t) => t === "subagent.started")).toHaveLength(5);
    expect(types.filter((t) => t === "subagent.finished")).toHaveLength(5);
    sub.close();
  });
});
