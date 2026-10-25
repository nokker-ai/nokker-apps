import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient, type Approval, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let dir: string;
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
const pendingCard = (thread: string): Approval | undefined =>
  (events.filter((e) => e.type === "approval.requested") as Array<{ approval: Approval }>)
    .map((e) => e.approval)
    .find((a) => a.thread_id === thread && a.status === "pending");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-local-"));
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

const state_has_turn = (th: string): boolean => mock.state.activeTurns.has(th);
async function newSession(cwd = "/work/proj"): Promise<string> {
  return (await client.createLocalSession({ cwd })).thread_id;
}
function startTurn(thread: string, text: string): Promise<void> {
  return client.streamChatCompletion(thread, [{ role: "user", content: text }], () => {});
}

describe("jeton local", () => {
  it("est écrit en 0600, accepté en loopback, refusé si faux ou si Host étranger", async () => {
    const mode = (await stat(join(dir, "local-token"))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await readFile(join(dir, "local-token"), "utf-8")).trim()).toBe(mock.localToken);
    await client.listThreads();
    await expect(new NokkerClient({ baseUrl: mock.url, token: "faux" }).listThreads()).rejects.toMatchObject({ status: 401 });
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(
        { host: "127.0.0.1", port: mock.port, path: "/v1/threads", headers: { Host: "evil.example", Authorization: `Bearer ${mock.localToken}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      r.on("error", reject);
      r.end();
    });
    expect(status).toBe(401);
  });
});

describe("sessions locales", () => {
  it("crée, liste, reprend ; 403 hors racine", async () => {
    const a = await client.createLocalSession({ cwd: "/work/proj" });
    expect(a.thread_id).toMatch(/^th_/);
    expect(a.cwd).toBe("/work/proj");
    const raw = await (await fetch(`${mock.url}/v1/local/sessions`, { headers: { Authorization: `Bearer ${mock.localToken}` } })).json();
    expect(Array.isArray((raw as { sessions: unknown }).sessions)).toBe(true); // forme du noyau
    const list = await client.listLocalSessions();
    expect(list.find((s) => s.thread_id === a.thread_id)).toMatchObject({ cwd: "/work/proj", title: "proj", last_turn_at: null });
    const again = await client.createLocalSession({ cwd: "/work/proj", resume: a.thread_id });
    expect(again.thread_id).toBe(a.thread_id);
    await expect(client.createLocalSession({ cwd: "/etc" })).rejects.toMatchObject({ status: 403 });
    await expect(client.createLocalSession({ cwd: "/work/proj", resume: "th_inconnu" })).rejects.toMatchObject({ status: 404 });
  });
});

/** Lance un tour et répond à chaque carte avec `answer` jusqu'à la fin du tour. */
async function drive(
  thread: string,
  text: string,
  answer: (card: Approval) => Promise<unknown>,
): Promise<Approval[]> {
  let finished = false;
  const allCards = (): Approval[] => (events.filter((e) => e.type === "approval.requested") as Array<{ approval: Approval }>).map((e) => e.approval);
  const before = new Set(allCards().map((c) => c.id)); // cartes des tours précédents : à ignorer
  const turn = startTurn(thread, text).finally(() => (finished = true));
  const seen: Approval[] = [];
  while (!finished) {
    const ev = allCards().find((a) => a.thread_id === thread && !before.has(a.id) && !seen.some((c) => c.id === a.id));
    if (ev) {
      expect(ev.suggested_rules).toBeUndefined(); // l'événement ne les porte pas : GET /v1/local/approvals
      const card = (await client.listLocalApprovals()).find((a) => a.id === ev.id)!;
      seen.push(card);
      await answer(card);
    }
    await wait(5);
  }
  await turn;
  return seen;
}
const once = (c: Approval): Promise<unknown> => client.decideLocalApproval(c.id, { decision: "approve", scope: "once" });
const resultsOf = (th: string): Array<Extract<NokkerEvent, { type: "tool.result" }>> =>
  events.filter((e) => e.type === "tool.result" && e.thread_id === th) as never;

describe("suite d'outils et cartes locales (mode accept_edits)", () => {
  it("patch sans carte ; la carte arrive sur pytest (terminal write), puis sur rm -rf build (destructif, sans always)", async () => {
    const th = await newSession();
    const cards = await drive(th, "corrige le test add", once);
    expect(cards.map((c) => [c.tool_name, c.effect, c.strength])).toEqual([
      ["terminal", "write", "standard"],
      ["terminal", "destructive", "strong"],
    ]);
    expect(cards[0]!.suggested_rules).toEqual(["terminal(pytest -q tests/test_add.py)", "terminal(pytest -q*)"]);
    expect(cards[1]!.suggested_rules).toEqual([]);
    const calls = events.filter((e) => e.type === "tool.call" && e.thread_id === th) as Array<Extract<NokkerEvent, { type: "tool.call" }>>;
    expect(calls.map((c) => [c.name, c.effect])).toEqual([
      ["read_file", "read"],
      ["search_files", "read"],
      ["patch", "write"],
      ["terminal", "write"],
      ["terminal", "destructive"],
    ]);
    const results = resultsOf(th);
    expect(results.map((r) => r.call_id)).toEqual(calls.map((c) => c.call_id));
    expect(results.every((r) => !r.is_error && (r.preview ?? "").split("\n").length <= 3)).toBe(true);
    const done = (await until(() => events.filter((e) => e.type === "turn.done" && e.thread_id === th).at(-1))) as { cancelled?: boolean };
    expect(done.cancelled).toBeUndefined();
  });

  it("écriture en direct (X22) : tool.input.delta du patch, chemin d'abord, seq croissant, avant son tool.call", async () => {
    const th = await newSession();
    await drive(th, "corrige le test add", once);
    const i = events.findIndex((e) => e.type === "tool.call" && e.thread_id === th && e.name === "patch");
    const call = events[i] as Extract<NokkerEvent, { type: "tool.call" }>;
    const deltas = events.filter((e) => e.type === "tool.input.delta" && e.thread_id === th) as Array<Extract<NokkerEvent, { type: "tool.input.delta" }>>;
    expect(deltas.length).toBeGreaterThan(2);
    expect(deltas.every((d) => d.call_id === call.call_id && d.name === "patch" && d.path === "src/app.py" && d.field === "new_string")).toBe(true);
    expect(deltas.map((d) => d.seq)).toEqual(deltas.map((_, k) => k));
    expect(deltas[0]!.text).toBe("");
    expect(deltas.map((d) => d.text).join("")).toContain("return a + b\n");
    expect(events.indexOf(deltas.at(-1)!)).toBeLessThan(i);
  });

  it("scope session : plus de carte pour la même commande dans ce fil, mais une carte dans un autre fil", async () => {
    const th = await newSession();
    await drive(th, "corrige le test add", (c) => client.decideLocalApproval(c.id, { decision: "approve", scope: c.suggested_rules?.length ? "session" : "once" }));
    const again = await drive(th, "corrige le test add", once);
    expect(again.map((c) => c.effect)).toEqual(["destructive"]); // pytest couvert, rm -rf build jamais (pas de règle destructive)
    const other = await newSession();
    const c3 = await drive(other, "corrige le test add", (c) => client.decideLocalApproval(c.id, { decision: "reject", scope: "once" }));
    expect(c3.length).toBe(2);
  });

  it("scope always : rule ∈ suggested_rules sinon 400 ; écrite dans settings.json (dédoublonnée) ; plus de carte pytest nulle part", async () => {
    const th = await newSession();
    await drive(th, "corrige le test add", async (c) => {
      if (c.suggested_rules?.length) {
        await expect(client.decideLocalApproval(c.id, { decision: "approve", scope: "always", rule: "terminal(*)" })).rejects.toMatchObject({ status: 400 });
        await expect(client.decideLocalApproval(c.id, { decision: "approve", scope: "always" })).rejects.toMatchObject({ status: 400 });
        await client.decideLocalApproval(c.id, { decision: "approve", scope: "always", rule: "terminal(pytest -q*)" });
      } else {
        // carte destructive : « toujours » n'a aucune règle à proposer
        await expect(client.decideLocalApproval(c.id, { decision: "approve", scope: "always", rule: "terminal(rm -rf build)" })).rejects.toMatchObject({ status: 400 });
        await once(c);
      }
    });
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["terminal(pytest -q*)"]);
    const next = await drive(await newSession(), "corrige le test add", once);
    expect(next.map((c) => c.effect)).toEqual(["destructive"]);
  });

  it("refuser pytest laisse le tour finir, avec un résultat en erreur", async () => {
    const th = await newSession();
    await drive(th, "corrige le test mul", (c) => client.decideLocalApproval(c.id, { decision: "reject", scope: "once" }));
    expect(resultsOf(th).filter((r) => r.is_error).length).toBeGreaterThanOrEqual(1);
  });
});

describe("hardline, annulation", () => {
  it("hardline : refus direct SANS carte, tool.result en erreur", async () => {
    const th = await newSession();
    const before = events.filter((e) => e.type === "approval.requested").length;
    await startTurn(th, "lance rm -rf /");
    expect(events.filter((e) => e.type === "approval.requested").length).toBe(before);
    const r = resultsOf(th);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ is_error: true, preview: "refusé : commande interdite (hardline)" });
  });

  it("cancel pendant une carte : 202 {cancelled, approvals_cancelled}, turn.done {cancelled:true}", async () => {
    const th = await newSession();
    const t = startTurn(th, "corrige le test add");
    const card = await until(() => pendingCard(th));
    expect(await client.cancelTurn(th)).toEqual({ cancelled: true, approvals_cancelled: 1 });
    await t;
    const done = (await until(() => events.filter((e) => e.type === "turn.done" && e.thread_id === th).at(-1))) as { cancelled?: boolean };
    expect(done.cancelled).toBe(true);
    expect((await client.getApproval(card.id)).status).toBe("rejected");
    expect(await client.cancelTurn(th)).toEqual({ cancelled: false, approvals_cancelled: 0 });
  });

  it("routes : /v1/approvals/{id}/decision refuse le jeton local ; /v1/local/approvals/{id}/decide : 400 strong≠once, 409 déjà décidée, 404 inconnue", async () => {
    mock.state.approvals.set("appr_s", {
      id: "appr_s", thread_id: "th_x", turn_index: 0, channel: "web", tool_name: "wire", arguments: {}, args_sha256: "", effect: "spend",
      rule: "effect:spend", reason: "t", advice: null, strength: "strong", status: "pending", created_at: "", expires_at: "",
      decided_by: null, decided_via: null, decided_at: null, result_summary: null, error: null,
    });
    await expect(client.decideApproval("appr_s", { decision: "approve", scope: "once" } as never)).rejects.toMatchObject({ status: 403 });
    await expect(client.decideLocalApproval("appr_s", { decision: "approve", scope: "once" })).rejects.toMatchObject({ status: 404 }); // pas une carte locale

    await (await import("node:fs/promises")).writeFile(join(dir, "settings.json"), "{}"); // oublie les règles « always » des tests précédents
    const th = await newSession();
    const t = startTurn(th, "corrige le test add");
    const ev = await until(() => pendingCard(th));
    await expect(client.decideLocalApproval(ev.id, { decision: "approve", scope: "bizarre" as never })).rejects.toMatchObject({ status: 400 });
    const res = await client.decideLocalApproval(ev.id, { decision: "approve", scope: "once" });
    expect(res).toMatchObject({ scope: "once", status: "approved" });
    await expect(client.decideLocalApproval(ev.id, { decision: "approve", scope: "once" })).rejects.toMatchObject({ status: 409 });
    const strong = await until(() => (events.filter((e) => e.type === "approval.requested") as Array<{ approval: Approval }>).map((e) => e.approval).find((a) => a.thread_id === th && a.strength === "strong"));
    await expect(client.decideLocalApproval(strong.id, { decision: "approve", scope: "session" })).rejects.toMatchObject({ status: 400 });
    await client.decideLocalApproval(strong.id, { decision: "reject", scope: "once" });
    await t;
  });

  it("sous-agents : started / progress / finished", async () => {
    const th = await newSession();
    await startTurn(th, "délègue ça à un sous-agent");
    const types = events.filter((e) => e.type.startsWith("subagent.")).map((e) => e.type);
    expect(types[0]).toBe("subagent.started");
    expect(types.at(-1)).toBe("subagent.finished");
    expect(types).toContain("subagent.progress");
  });
});

describe("token_path de lokkal.json", () => {
  it("le jeton est écrit là où token_path pointe quand lokkal.json existe", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const d = await mkdtemp(join(tmpdir(), "nokker-mock-tp-"));
    const tp = join(d, "state", "sub", "local-token");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "lokkal.json"), JSON.stringify({ token_path: tp }));
    const m = await startMockServer({ port: 0, seed: false, configDir: d });
    try {
      expect(m.localTokenPath).toBe(tp);
      expect((await readFile(tp, "utf-8")).trim()).toBe(m.localToken);
      expect((await stat(tp)).mode & 0o777).toBe(0o600);
      await expect(readFile(join(d, "local-token"))).rejects.toBeTruthy();
    } finally {
      await m.close();
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("POST /v1/local/tools/call", () => {
  const call = (thread: string, name: string, args: Record<string, unknown> = {}, token: string | null = mock.localToken): Promise<Response> =>
    fetch(`${mock.url}/v1/local/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ thread_id: thread, name, arguments: args }),
    });

  it("lecture : 200 {content, is_error} ; liste, diff, skills, todo", async () => {
    const th = await newSession();
    const list = (await (await call(th, "checkpoint_list")).json()) as { content: string; is_error: boolean };
    expect(list.is_error).toBe(false);
    const cps = JSON.parse(list.content) as Array<{ hash: string; short_hash: string; timestamp: string; reason: string; files_changed: number; insertions: number; deletions: number }>; // liste NUE
    expect(Array.isArray(cps)).toBe(true);
    expect(cps[0]).toHaveProperty("insertions");
    expect(cps).toHaveLength(3);
    expect(cps[0]).toMatchObject({ short_hash: cps[0]!.hash.slice(0, 8) });
    expect(cps[0]!.hash).toHaveLength(40);
    const diff = (await (await call(th, "checkpoint_diff", { hash: cps[1]!.hash })).json()) as { content: string };
    const dj = JSON.parse(diff.content) as { stat: string; diff: string };
    expect(dj.diff).toContain("--- a/src/app.py");
    expect(dj.stat).toContain("1 file changed");
    const skills = JSON.parse(((await (await call(th, "skill_list")).json()) as { content: string }).content).skills as Array<{ name: string }>;
    expect(skills).toHaveLength(4);
    const view = (await (await call(th, "skill_view", { name: skills[0]!.name })).json()) as { content: string; is_error: boolean };
    expect(view.content).toMatch(/^# /);
    const bad = (await (await call(th, "skill_view", { name: "nope" })).json()) as { is_error: boolean };
    expect(bad.is_error).toBe(true);
    const todoRes = JSON.parse(((await (await call(th, "todo")).json()) as { content: string }).content) as { todos: unknown[]; revision: number; summary: Record<string, number> };
    expect(todoRes.todos).toHaveLength(3);
    expect(todoRes.summary).toEqual({ total: 3, pending: 1, in_progress: 1, completed: 1, cancelled: 0 });
    expect(typeof todoRes.revision).toBe("number");
  });

  it("403 hors liste blanche et sans jeton local ; 404 fil non local ; 400 todo avec arguments", async () => {
    const th = await newSession();
    expect((await call(th, "terminal", { command: "ls" })).status).toBe(403);
    const ordinary = await client.createThread("ordinaire");
    expect((await call(ordinary.id, "checkpoint_list")).status).toBe(404);
    expect((await call("th_inconnu", "todo")).status).toBe(404);
    const user = await fetch(`${mock.url}/v1/dev/demo-session`, { method: "POST" }).then((r) => r.json() as Promise<{ token: string }>);
    expect((await call(th, "todo", {}, user.token)).status).toBe(403);
  });

  it("checkpoint_restore : 202 + carte forte-locale ; approbation -> tool.result avec le résultat ; refus -> is_error", async () => {
    const th = await newSession();
    const first = JSON.parse(((await (await call(th, "checkpoint_list")).json()) as { content: string }).content)[1].hash as string;
    const r = await call(th, "checkpoint_restore", { hash: first, safe: true });
    expect(r.status).toBe(202);
    const { approval_id } = (await r.json()) as { approval_id: string };
    const card = await until(() => pendingCard(th));
    expect(card).toMatchObject({ id: approval_id, tool_name: "checkpoint_restore", effect: "destructive", strength: "strong", channel: "local-direct" });
    const pending = (await client.listLocalApprovals()).find((a) => a.id === approval_id);
    expect(pending).toBeTruthy();
    await client.decideLocalApproval(approval_id, { decision: "approve", scope: "once" });
    const ev = (await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === approval_id))) as { is_error: boolean; content: string };
    expect(ev.is_error).toBe(false);
    expect(JSON.parse(ev.content)).toEqual({ success: true, restored_files: ["src/app.py", "tests/test_app.py"], skipped_user_edits: ["notes.md"] });
    // un point « avant retour » a été ajouté
    const after = JSON.parse(((await (await call(th, "checkpoint_list")).json()) as { content: string }).content) as Array<{ reason: string }>;
    expect(after[0]!.reason).toContain("avant retour");

    const r2 = await call(th, "checkpoint_restore", { hash: first, safe: true });
    const id2 = ((await r2.json()) as { approval_id: string }).approval_id;
    await client.decideLocalApproval(id2, { decision: "reject", scope: "once" });
    const ev2 = (await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === id2))) as { is_error: boolean };
    expect(ev2.is_error).toBe(true);
  });

  it("400 si todo reçoit des arguments ; refus par règle = 200 is_error ; 409 pendant un tour", async () => {
    const th = await newSession();
    expect((await call(th, "todo", { todos: [] })).status).toBe(400);
    expect((await call(th, "todo", {})).status).toBe(200);
    // règle deny posée dans les réglages : 200 {is_error: true}, plus de 403
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "settings.json"), JSON.stringify({ permissions: { deny: ["skill_view"] } }));
    const denied = await call(th, "skill_view", { name: "git-bisect" });
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as { is_error: boolean }).is_error).toBe(true);
    await rm(join(dir, "settings.json"));
    // un tour en cours (carte pytest en attente) : 409
    const before = events.length;
    void startTurn(th, "corrige le test add").catch(() => {});
    await until(() => pendingCard(th));
    expect((await call(th, "checkpoint_list")).status).toBe(409);
    await client.cancelTurn(th);
    await until(() => !state_has_turn(th));
    expect(events.slice(before).some((e) => e.type === "turn.started" && e.thread_id === th)).toBe(true);
  });

  it("checkpoint_create : 202 + carte local-direct (le noyau le passera à 200 en accept_edits)", async () => {
    const th = await newSession();
    const r = await call(th, "checkpoint_create", { reason: "manuel" });
    expect(r.status).toBe(202);
    const { approval_id } = (await r.json()) as { approval_id: string };
    expect((await client.listLocalApprovals()).find((a) => a.id === approval_id)).toMatchObject({ channel: "local-direct", tool_name: "checkpoint_create" });
    await client.decideLocalApproval(approval_id, { decision: "approve", scope: "once" });
    const ev = (await until(() => events.find((e) => e.type === "tool.result" && e.approval_id === approval_id))) as { content: string; call_id?: string };
    expect(ev.call_id).toBeUndefined();
    expect(JSON.parse(ev.content)).toMatchObject({ success: true });
  });

  it("messages d'erreur du noyau : 403 et 400 exacts", async () => {
    const th = await newSession();
    const r403 = await call(th, "terminal", { command: "ls" });
    expect(((await r403.json()) as { error: { message: string } }).error.message).toBe("outil non appelable directement : terminal");
    const r400 = await call(th, "todo", { todos: [] });
    expect(((await r400.json()) as { error: { message: string } }).error.message).toBe("arguments invalides (todo : lecture seule, sans argument)");
  });

  it("l'appel direct et sa décision n'émettent que la carte, la décision et le tool.result (aucun tour)", async () => {
    const th = await newSession();
    const before = events.length;
    const id = ((await (await call(th, "checkpoint_restore", { safe: true })).json()) as { approval_id: string }).approval_id;
    await client.decideLocalApproval(id, { decision: "reject", scope: "once" });
    const ev = (await until(() => events.slice(before).find((e) => e.type === "tool.result" && e.approval_id === id))) as { thread_id: string; is_error: boolean; content: string };
    expect(ev).toMatchObject({ thread_id: th, is_error: true });
    expect(ev.content).toContain("refusé");
    await wait(100);
    const types = events.slice(before).filter((e) => "thread_id" in e && (e as { thread_id?: string }).thread_id === th || e.type.startsWith("approval")).map((e) => e.type);
    expect(types.filter((t) => t.startsWith("turn.") || t === "tool.call")).toEqual([]);
  });
});

describe("décision locale : réponse tout de suite (LOKKAL.md §7.4.3, §7.4.9)", () => {
  const cardAfter = (th: string, first: string): Approval | undefined =>
    (events.filter((e) => e.type === "approval.requested") as Array<{ approval: Approval }>).map((e) => e.approval).find((a) => a.thread_id === th && a.id !== first);
  const raw = async (id: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${mock.url}/v1/local/approvals/${id}/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mock.localToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  it("inline : 202 running (approuvée) / 200 none (refus) ; status approved|rejected ; le tool.result porte approval_id", async () => {
    const th = await newSession("/work/inline-202");
    const turn = startTurn(th, "corrige le test add");
    const c1 = await until(() => pendingCard(th));
    const r1 = await raw(c1.id, { decision: "approve", scope: "once" });
    expect(r1.status).toBe(202);
    expect(r1.json).toMatchObject({ id: c1.id, approval_id: c1.id, status: "approved", continuation: "running", scope: "once", rule: null });
    expect(typeof r1.json.call_id).toBe("string");
    const done1 = await until(() => resultsOf(th).find((e) => e.approval_id === c1.id));
    expect(done1).toMatchObject({ call_id: r1.json.call_id, is_error: false });
    const c2 = await until(() => cardAfter(th, c1.id));
    const r2 = await raw(c2.id, { decision: "reject", scope: "once" });
    expect(r2.status).toBe(200);
    expect(r2.json).toMatchObject({ approval_id: c2.id, status: "rejected", continuation: "none" });
    await turn;
  });

  it("kernel : la carte rend la main ; approuvée → queued derrière le tour, tool.result de l'exécuteur AVANT le tour de suite ; refus → rien ne tourne", async () => {
    mock.state.approvalStyle = "kernel";
    try {
      const th = await newSession("/work/kernel-202");
      const from = events.length;
      const turn = startTurn(th, "corrige le test add");
      const c1 = await until(() => pendingCard(th));
      const call = await until(() => resultsOf(th).find((e) => e.preview?.includes(`[approval:${c1.id}]`)));
      // Décidée pendant que le tour qui l'a posée se termine : la suite passe après lui.
      const r1 = await raw(c1.id, { decision: "approve", scope: "once" });
      expect(r1.status).toBe(202);
      expect(r1.json).toMatchObject({ approval_id: c1.id, status: "approved", call_id: call.call_id });
      expect(["queued", "running"]).toContain(r1.json.continuation);
      await turn;
      const exec = await until(() => resultsOf(th).find((e) => e.approval_id === c1.id));
      expect(exec).toMatchObject({ call_id: call.call_id, turn_id: call.turn_id, name: "terminal", ok: true, is_error: false });
      expect(exec.preview).toContain("1 passed");
      const after = events.slice(from);
      const execAt = after.indexOf(exec);
      const followStart = after.findIndex((e, i) => i > execAt && e.type === "turn.started" && e.thread_id === th);
      expect(followStart).toBeGreaterThan(execAt);
      // Le tour de suite prend l'index suivant (il voit le tour qui a posé la carte).
      expect((after[followStart] as { turn_id: string }).turn_id).toBe(`${th}:1`);
      const c2 = await until(() => cardAfter(th, c1.id));
      await until(() => !mock.state.threadBusy(th));
      const started = events.filter((e) => e.type === "turn.started" && e.thread_id === th).length;
      const r2 = await raw(c2.id, { decision: "reject", scope: "once" });
      expect(r2.status).toBe(200);
      expect(r2.json).toMatchObject({ status: "rejected", continuation: "none" });
      await wait(100);
      expect(events.filter((e) => e.type === "turn.started" && e.thread_id === th).length).toBe(started);
      expect(resultsOf(th).some((e) => e.approval_id === c2.id)).toBe(false);
    } finally {
      mock.state.approvalStyle = "inline";
    }
  });

  it("kernel : annulation pendant qu'une suite attend dans la file → carte failed, tool.result en erreur, pas de tour de suite", async () => {
    mock.state.approvalStyle = "kernel";
    try {
      const th = await newSession("/work/kernel-cancel");
      const turn = startTurn(th, "corrige le test add");
      const c1 = await until(() => pendingCard(th));
      // Le tour qui a posé la carte tient encore la file : on la retient pour que la suite soit en file.
      const hold = mock.state.lockThread(th);
      await turn;
      const r1 = await raw(c1.id, { decision: "approve", scope: "once" });
      expect(r1.json.continuation).toBe("queued");
      await client.cancelTurn(th);
      (await hold)();
      const exec = await until(() => resultsOf(th).find((e) => e.approval_id === c1.id));
      expect(exec).toMatchObject({ is_error: true, preview: "annulé par l'utilisateur" });
      await wait(50);
      expect(events.filter((e) => e.type === "turn.started" && e.thread_id === th)).toHaveLength(1);
    } finally {
      mock.state.approvalStyle = "inline";
    }
  });
});
