import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerApiError, NokkerClient, isPlanModeRefusal, type NokkerEvent, type TodoResult } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: timeout");
    await wait(10);
  }
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

describe("local session mode (GET|PUT /v1/local/sessions/{thread}/mode)", () => {
  let mock: MockServerHandle;
  let dir: string;
  let client: NokkerClient;
  let events: NokkerEvent[];
  let sub: { close(): void };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-mock-mode-"));
    mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir, localRoots: ["/work"] });
    client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
    events = [];
    sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
    await wait(100);
  });
  afterAll(async () => {
    sub.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.MOCK_PROJECT_MODE;
  });

  it("reads, changes and announces the mode; refuses a mode outside the list or above the project", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/proj" })).thread_id;
    expect(await client.getLocalSessionMode(th)).toEqual({ mode: "accept_edits", modes: ["default", "accept_edits", "auto", "plan"], effective: "accept_edits" });
    expect(await client.setLocalSessionMode(th, "plan")).toMatchObject({ mode: "plan", effective: "plan" });
    await until(() => events.find((e) => e.type === "session.mode" && e.thread_id === th && e.mode === "plan" && e.effective === "plan"));
    expect(await fail(client.setLocalSessionMode(th, "yolo" as never))).toEqual({ status: 400, code: "bad_mode" });
    process.env.MOCK_PROJECT_MODE = "default";
    expect(await fail(client.setLocalSessionMode(th, "accept_edits"))).toEqual({ status: 400, code: "mode_above_project" });
    expect(await client.setLocalSessionMode(th, "default")).toMatchObject({ mode: "default", effective: "default" });
    expect(await fail(client.getLocalSessionMode("th_unknown"))).toMatchObject({ status: 404 });
  });

  it("plan mode: the patch is refused with reason plan_mode, the turn writes nothing", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/proj" })).thread_id;
    await client.setLocalSessionMode(th, "plan");
    await client.streamChatCompletion(th, [{ role: "user", content: "corrige le test add" }], () => {});
    const patch = (await until(() =>
      events.find((e) => e.type === "tool.result" && e.thread_id === th && e.name === "patch"),
    )) as Extract<NokkerEvent, { type: "tool.result" }>;
    expect(isPlanModeRefusal(patch)).toBe(true);
    const reads = events.filter((e) => e.type === "tool.result" && e.thread_id === th && (e.name === "read_file" || e.name === "search_files"));
    expect(reads.every((e) => !(e as { is_error?: boolean }).is_error)).toBe(true);
  });

  it("todo.updated after the plan changes; todo reads the new plan", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/proj" })).thread_id;
    const todos = [{ id: "1", content: "Write the test", status: "pending" }];
    const r = await fetch(`${mock.url}/v1/dev/todo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thread_id: th, todos }) });
    expect(r.status).toBe(200);
    const ev = await until(() => events.find((e) => e.type === "todo.updated" && e.thread_id === th));
    expect((ev as { items?: unknown }).items).toEqual(todos);
    const out = await client.callLocalTool(th, "todo");
    expect((JSON.parse((out as { content: string }).content) as TodoResult).todos).toEqual(todos);
  });
});

describe("code session mode (PATCH /v1/code/sessions/{cs}) and todo", () => {
  let mock: MockServerHandle;
  afterEach(async () => {
    await mock?.close();
  });

  it("changes the mode within code.modes, reads the plan, refuses todo with arguments", async () => {
    mock = await startMockServer({ speed: 0.01, code: true, configDir: null });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const s = await c.createCodeSession();
    expect(await c.setCodeSessionMode(s.id, "plan")).toEqual({ mode: "plan", modes: ["default", "accept_edits", "plan"], effective: "plan" });
    expect((await c.getCodeSession(s.id)).mode).toBe("plan");
    expect(await fail(c.setCodeSessionMode(s.id, "auto"))).toEqual({ status: 400, code: "bad_mode" });
    const plan = await c.callCodeSessionTool(s.id, "todo");
    expect((JSON.parse((plan as { content: string }).content) as TodoResult).summary?.total).toBe(3);
    expect(await fail(c.callCodeSessionTool(s.id, "todo", { add: "x" }))).toEqual({ status: 400, code: "bad_arguments" });
  });
});
