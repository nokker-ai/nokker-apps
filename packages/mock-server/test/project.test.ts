/**
 * Mémoire de projet (§7.11.7), skills du dépôt (§7.21) et sous-agents en arrière-plan (§7.22) : mêmes formes et mêmes
 * statuts que le noyau. L'empreinte des skills est vérifiée contre une valeur calculée par le noyau sur le même arbre.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient, NokkerApiError, type DelegateStatusResult, type LocalToolResult, type NokkerEvent, type ProjectMemoryList } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
import { projectSkillsSha256 } from "../src/project.js";

let mock: MockServerHandle;
let dir: string;
let work: string;
let client: NokkerClient;
let events: NokkerEvent[];
let sub: { close(): void };

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: délai dépassé");
    await wait(10);
  }
}

/** L'arbre de référence (fichiers, un lien vers un fichier, un lien vers un dossier). */
async function skillsTree(root: string): Promise<void> {
  const s = join(root, ".nokker", "skills", "dev");
  await mkdir(join(s, "lint"), { recursive: true });
  await mkdir(join(s, "fmt", "scripts"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(s, "lint", "SKILL.md"), "---\nname: lint\ndescription: Run the linter\n---\n# lint\n");
  await writeFile(join(s, "fmt", "SKILL.md"), "x");
  await writeFile(join(s, "fmt", "scripts", "a.sh"), "hi\n");
  await symlink("lint", join(s, "zlink"));
  await symlink("SKILL.md", join(s, "lint", "alias.md"));
}
/** `project_skills_sha256` du noyau sur `skillsTree` (même arbre, même calcul). */
const CORE_SHA = "06c5c50984ec987f4ab71ac3d70934dd588d27ee5a806c1c22743d4d44066169";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-project-"));
  work = await mkdtemp(join(tmpdir(), "nokker-mock-work-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir, localRoots: [work], projectSkills: true });
  client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
  events = [];
  sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
  await wait(100);
});
afterAll(async () => {
  sub.close();
  await mock.close();
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

async function call(th: string, name: string, args: Record<string, unknown> = {}): Promise<LocalToolResult> {
  return (await client.callLocalTool(th, name as never, args)) as LocalToolResult;
}

describe("mémoire de projet", () => {
  it("list : notes apprises et sections des fichiers d'instructions, view, forget (memory.forgotten), section non oubliable", async () => {
    const repo = join(work, "memo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "AGENTS.md"), "# Build\n\nRun `make`.\n\n```\n# not a heading\n```\n\n## Tests\n\npytest -q\n");
    const th = (await client.createLocalSession({ cwd: repo })).thread_id;
    const list = JSON.parse((await call(th, "memory", { action: "list" })).content) as ProjectMemoryList;
    expect(list.notes.map((n) => n.kind)).toEqual(["rule", "fact"]);
    expect(list.notes[0]).toMatchObject({ scope: "project", derived_from: "user", in_core: true });
    expect(list.sources).toEqual([{ path: "AGENTS.md", sections: [expect.objectContaining({ title: "Build" }), expect.objectContaining({ title: "Tests" })] }]);
    const section = list.sources[0]!.sections[0]!;
    expect(section.name).toMatch(/^src-[0-9a-f]{8}-1$/);
    const view = JSON.parse((await call(th, "memory", { action: "view", name: section.name })).content);
    expect(view).toMatchObject({ source: "AGENTS.md", title: "Build" });
    expect(view.text).toContain("# not a heading");
    const r = await call(th, "memory", { action: "forget", name: section.name });
    expect(r).toMatchObject({ is_error: true });
    expect(r.content).toContain("modifie le fichier");
    const note = list.notes[0]!.name;
    expect(JSON.parse((await call(th, "memory", { action: "forget", name: note })).content)).toEqual({ forgotten: note });
    await until(() => events.find((e) => e.type === "memory.forgotten" && e.name === note));
    expect(await call(th, "memory", { action: "view", name: note })).toEqual({ content: `note inconnue : ${note}`, is_error: true });
  });

  it("forget en mode default : carte (202), résultat par tool.result {approval_id}", async () => {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ permissions: { mode: "default" } }));
    try {
      const th = (await client.createLocalSession({ cwd: work })).thread_id;
      const list = JSON.parse((await call(th, "memory", { action: "list" })).content) as ProjectMemoryList;
      const out = await client.callLocalTool(th, "memory", { action: "forget", name: list.notes[1]!.name });
      expect(out).toHaveProperty("approval_id");
      const id = (out as { approval_id: string }).approval_id;
      await client.decideLocalApproval(id, { decision: "approve", scope: "once" });
      const res = await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === id));
      expect(res).toMatchObject({ is_error: false, content: JSON.stringify({ forgotten: list.notes[1]!.name }) });
    } finally {
      await rm(join(dir, "settings.json"), { force: true });
    }
  });

  it("drapeau éteint : 403 comme le noyau", async () => {
    const th = (await client.createLocalSession({ cwd: work })).thread_id;
    mock.state.projectMemory = false;
    try {
      await expect(client.callLocalTool(th, "memory", { action: "list" })).rejects.toMatchObject({ status: 403 });
    } finally {
      mock.state.projectMemory = true;
    }
  });
});

describe("skills du dépôt", () => {
  it("empreinte identique à celle du noyau sur le même arbre", async () => {
    const repo = join(work, "skt");
    await skillsTree(repo);
    expect(projectSkillsSha256(join(repo, ".nokker", "skills"))).toEqual({ sha256: CORE_SHA, count: 2, why: null });
  });

  it("ouverture : skills untrusted + skill.untrusted ; trust 409/200 ; trusted ensuite et skills visibles (source project)", async () => {
    const repo = join(work, "skt");
    const opened = await client.createLocalSession({ cwd: join(repo) });
    expect(opened.skills).toMatchObject({ enabled: true, project: "untrusted", root: repo, sha256: CORE_SHA, count: 2 });
    const ev = await until(() => events.find((e) => e.type === "skill.untrusted" && e.thread_id === opened.thread_id));
    expect(ev).toMatchObject({ root: repo, sha256: CORE_SHA, count: 2 });
    const before = JSON.parse((await call(opened.thread_id, "skill_list")).content) as { skills: { source: string }[] };
    expect(before.skills.some((s) => s.source === "project")).toBe(false);
    await expect(client.trustProjectSkills(opened.thread_id, "0".repeat(64))).rejects.toMatchObject({ status: 409 });
    expect(await client.trustProjectSkills(opened.thread_id, CORE_SHA)).toEqual({ thread_id: opened.thread_id, root: repo, sha256: CORE_SHA, trusted: true });
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
    expect(settings.trusted_project_skills).toEqual([{ root: repo, sha256: CORE_SHA }]);
    const after = JSON.parse((await call(opened.thread_id, "skill_list")).content) as { skills: { name: string; source: string; description: string }[] };
    expect(after.skills.find((s) => s.name === "lint")).toMatchObject({ source: "project", description: "Run the linter" });
    // Une autre session sur le même dossier et la même empreinte : déjà fiable.
    expect((await client.createLocalSession({ cwd: repo })).skills).toMatchObject({ project: "trusted", notice: null });
    // L'arbre change : redevient untrusted à la lecture du catalogue, avec un nouvel avis.
    await writeFile(join(repo, ".nokker", "skills", "dev", "lint", "SKILL.md"), "changed");
    const n = events.length;
    const changed = JSON.parse((await call(opened.thread_id, "skill_list")).content) as { skills: { source: string }[] };
    expect(changed.skills.some((s) => s.source === "project")).toBe(false);
    await until(() => events.slice(n).find((e) => e.type === "skill.untrusted" && e.thread_id === opened.thread_id));
    await rm(join(dir, "settings.json"), { force: true });
  });

  it("sans arbre : absent ; fil sans skills : 404 ; drapeau éteint : pas de clé skills, route 404", async () => {
    const plain = await client.createLocalSession({ cwd: work });
    expect(plain.skills).toMatchObject({ project: "absent", sha256: null, count: 0 });
    await expect(client.trustProjectSkills(plain.thread_id, CORE_SHA)).rejects.toMatchObject({ status: 404 });
    mock.state.projectSkills = false;
    try {
      const off = await client.createLocalSession({ cwd: work });
      expect(off.skills).toBeUndefined();
      const err = await client.trustProjectSkills(off.thread_id, CORE_SHA).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NokkerApiError);
      expect((err as NokkerApiError).serverMessage).toContain("local.project_skills");
    } finally {
      mock.state.projectSkills = true;
    }
  });
});

describe("sous-agents en arrière-plan", () => {
  it("delegate background : ids tout de suite, events background, delegate_status (running → completed), wait_s 400, delegate_cancel 403", async () => {
    const th = (await client.createLocalSession({ cwd: work })).thread_id;
    await client.streamChatCompletion(th, [{ role: "user", content: "run two sub-agents in the background" }], () => {});
    const started = events.filter((e) => e.type === "subagent.started" && e.parent_thread_id === th);
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ background: true, thread_id: th, parent_turn: 0 });
    expect((started[0] as { child_thread_id: string }).child_thread_id).toMatch(new RegExp(`^${th}/sa-`));
    const st = JSON.parse((await call(th, "delegate_status")).content) as DelegateStatusResult;
    expect(st.children).toHaveLength(2);
    expect(st.running + st.finished).toBe(2);
    await expect(client.callLocalTool(th, "delegate_status", { wait_s: 5 })).rejects.toMatchObject({ status: 400 });
    await expect(client.callLocalTool(th, "delegate_cancel", {})).rejects.toMatchObject({ status: 403 });
    await until(() => events.filter((e) => e.type === "subagent.finished" && e.parent_thread_id === th).length === 2);
    const fin = events.find((e) => e.type === "subagent.finished" && e.parent_thread_id === th);
    expect(fin).toMatchObject({ status: "completed", background: true, exit_reason: "completed", commits: 1, kept: true });
    const done = JSON.parse((await call(th, "delegate_status")).content) as DelegateStatusResult;
    expect(done).toMatchObject({ running: 0, finished: 2 });
    expect(done.children[0]).toMatchObject({ status: "completed", exit_reason: "completed", worktree: { commits: 1 } });
    expect(done.children[0]!.summary).toBeTruthy();
    const unknown = JSON.parse((await call(th, "delegate_status", { ids: ["nope"] })).content) as DelegateStatusResult;
    expect(unknown).toMatchObject({ children: [], unknown: ["nope"] });
  });

  it("annulation du fil : enfants arrêtés (subagents_cancelled), interrupted / cancelled, worktree conservé", async () => {
    Object.assign(mock.state, { speed: 0.2 });
    try {
      const th = (await client.createLocalSession({ cwd: work })).thread_id;
      await client.streamChatCompletion(th, [{ role: "user", content: "en arrière-plan, s'il te plaît" }], () => {});
      const r = await client.cancelTurn(th);
      expect(r.subagents_cancelled).toBe(2);
      await until(() => events.filter((e) => e.type === "subagent.finished" && e.parent_thread_id === th).length === 2);
      const st = JSON.parse((await call(th, "delegate_status")).content) as DelegateStatusResult;
      expect(st.children.map((c) => [c.status, c.exit_reason, c.worktree?.kept])).toEqual([
        ["interrupted", "cancelled", true],
        ["interrupted", "cancelled", true],
      ]);
    } finally {
      Object.assign(mock.state, { speed: 0.01 });
    }
  });

  it("redémarrage du noyau : enfants non finis interrupted / restart (fond ET premier plan), worktree conservé non inspecté", async () => {
    Object.assign(mock.state, { speed: 0.5 });
    try {
      const th = (await client.createLocalSession({ cwd: work })).thread_id;
      await client.streamChatCompletion(th, [{ role: "user", content: "background please" }], () => {});
      const r = await fetch(`${mock.url}/v1/dev/local-machine-mock`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${mock.localToken}` }, body: JSON.stringify({ restart_subagents: true }) });
      expect(r.status).toBe(200);
      const st = JSON.parse((await call(th, "delegate_status")).content) as DelegateStatusResult;
      expect(st).toMatchObject({ running: 0, finished: 2 });
      expect(st.children[0]).toMatchObject({ status: "interrupted", exit_reason: "restart", worktree: { kept: true } });
      expect(st.children[0]!.worktree).not.toHaveProperty("commits");
    } finally {
      Object.assign(mock.state, { speed: 0.01 });
    }
  });

  it("premier plan : forme du noyau (parent_thread_id, status completed, sans background)", async () => {
    const th = (await client.createLocalSession({ cwd: work })).thread_id;
    await client.streamChatCompletion(th, [{ role: "user", content: "délègue ça à un sous-agent" }], () => {});
    const fin = events.find((e) => e.type === "subagent.finished" && e.parent_thread_id === th);
    expect(fin).toMatchObject({ status: "completed", commits: 1, dirty: false, kept: true });
    expect(fin).not.toHaveProperty("background");
    const prog = events.find((e) => e.type === "subagent.progress" && e.parent_thread_id === th);
    expect(prog).toMatchObject({ tool: "read_file" });
    // delegate_status ne voit que les enfants de fond
    expect(JSON.parse((await call(th, "delegate_status")).content)).toEqual({ children: [], running: 0, finished: 0 });
  });
});
