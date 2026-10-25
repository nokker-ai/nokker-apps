import { describe, expect, it, vi } from "vitest";
import { NokkerClient } from "../src/client.js";
import type { FetchLike, ResponseLike } from "../src/events.js";
import { decide, fnmatch, matchRule, normpath, suggestRules } from "../src/permissions.js";

function jsonResponse(status: number, obj: unknown): ResponseLike {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return {
    ok: status < 400,
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

describe("session locale et annulation", () => {
  it("createLocalSession / listLocalSessions / cancelTurn appellent les bonnes routes", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url.endsWith("/v1/local/sessions") && init.method === "POST") {
        return jsonResponse(201, { thread_id: "th_abc", cwd: "/w/proj" });
      }
      if (url.endsWith("/v1/local/sessions")) return jsonResponse(200, []);
      return jsonResponse(202, { cancelled: true, approvals_cancelled: 0 });
    }) as unknown as FetchLike;
    const c = new NokkerClient({ baseUrl: "http://x/", token: "t", fetchImpl });
    const s = await c.createLocalSession({ cwd: "/w/proj", resume: "th_old" });
    expect(s.thread_id).toBe("th_abc");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: "/w/proj", resume: "th_old" });
    await c.listLocalSessions();
    expect(await c.cancelTurn("th_abc")).toEqual({ cancelled: true, approvals_cancelled: 0 });
    expect(calls[2]).toMatchObject({ url: "http://x/v1/threads/th_abc/cancel", method: "POST" });
  });

  it("listLocalSessions accepte {sessions: [...]} (noyau) et un tableau nu", async () => {
    const row = { thread_id: "th_1", cwd: "/w", title: "w", last_turn_at: null };
    for (const payload of [{ sessions: [row] }, [row]]) {
      const fetchImpl = (async () => jsonResponse(200, payload)) as unknown as FetchLike;
      const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl });
      expect(await c.listLocalSessions()).toEqual([row]);
    }
    const empty = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl: (async () => jsonResponse(200, {})) as unknown as FetchLike });
    expect(await empty.listLocalSessions()).toEqual([]);
  });

  it("streamChatCompletion transmet le signal et propage l'abandon", async () => {
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_u: string, init: { signal?: AbortSignal }) => {
      seen = init.signal;
      return {
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(": ping\n\n");
            await new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("AbortError"))));
          },
        },
      };
    }) as unknown as FetchLike;
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl });
    const p = c.streamChatCompletion("th_1", [{ role: "user", content: "a" }], () => {}, "nokker", { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow("AbortError");
    expect(seen).toBe(ctl.signal);
  });
});

describe("permissions", () => {
  it("normpath et fnmatch", () => {
    expect(normpath("./src/a.py")).toBe("src/a.py");
    expect(normpath("a//b/../c")).toBe("a/c");
    expect(fnmatch("src/x/y.py", "src/**")).toBe(true);
    expect(fnmatch("SRC/a", "src/*")).toBe(false);
  });
  it("matchRule : terminal sur la commande entière, fichier sur le chemin normalisé", () => {
    expect(matchRule("terminal(pytest*)", "terminal", { command: "  pytest -q " })).toBe(true);
    expect(matchRule("terminal(pytest)", "terminal", { command: "pytest -q" })).toBe(false);
    expect(matchRule("patch(src/a.py)", "patch", { path: "./src/a.py" })).toBe(true);
    expect(matchRule("patch", "patch", { path: "x" })).toBe(true);
  });
  it("suggestRules : exacte d'abord, puis préfixe / dossier", () => {
    expect(suggestRules("terminal", { command: "rm -rf build" })).toEqual(["terminal(rm -rf build)", "terminal(rm -rf*)"]);
    expect(suggestRules("patch", { path: "./src/app.py" })).toEqual(["patch(src/app.py)", "patch(src/**)"]);
  });
  it("decide : deny > plan > ask > allow > mode", () => {
    const args = { command: "rm -rf build" };
    expect(decide({}, "terminal", args, "destructive")).toBe("ask");
    expect(decide({ allow: ["terminal(rm -rf build)"] }, "terminal", args, "destructive")).toBe("allow");
    expect(decide({ allow: ["terminal"], ask: ["terminal(rm*)"] }, "terminal", args, "destructive")).toBe("ask");
    expect(decide({ allow: ["terminal"], deny: ["terminal(rm*)"] }, "terminal", args, "destructive")).toBe("deny");
    expect(decide({ mode: "plan" }, "terminal", { command: "pytest" }, "write")).toBe("deny");
    // mode par défaut (accept_edits) : patch sans carte, terminal (même WRITE) avec carte
    expect(decide({}, "patch", { path: "a.py" }, "write")).toBe("allow");
    expect(decide({}, "terminal", { command: "pytest" }, "write")).toBe("ask");
    expect(decide({ mode: "default" }, "patch", { path: "a.py" }, "write")).toBe("ask");
    expect(decide({ mode: "auto" }, "terminal", { command: "make" }, "send_external")).toBe("allow");
  });
});

describe("callLocalTool", () => {
  it("POST sur LOCAL_TOOL_CALL_PATH avec {thread_id, name, arguments} ; 200 et 202", async () => {
    const { LOCAL_TOOL_CALL_PATH, LOCAL_TOOL_NAMES, parseToolJson } = await import("../src/client.js");
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body });
      const name = JSON.parse(init.body!).name;
      return name === "checkpoint_restore" ? jsonResponse(202, { approval_id: "appr_1" }) : jsonResponse(200, { content: "{\"a\":1}", is_error: false });
    }) as unknown as FetchLike;
    const c = new NokkerClient({ baseUrl: "http://x/", token: "t", fetchImpl });
    const ok = await c.callLocalTool("th_1", "todo", { x: 1 });
    expect(ok).toEqual({ content: "{\"a\":1}", is_error: false });
    expect(calls[0]).toMatchObject({ url: `http://x${LOCAL_TOOL_CALL_PATH}`, method: "POST" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ thread_id: "th_1", name: "todo", arguments: { x: 1 } });
    expect(await c.callLocalTool("th_1", "checkpoint_restore", { hash: "h", safe: true })).toEqual({ approval_id: "appr_1" });
    expect(LOCAL_TOOL_CALL_PATH).toBe("/v1/local/tools/call");
    expect(LOCAL_TOOL_NAMES).toHaveLength(9);
    expect(parseToolJson<{ a: number }>("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseToolJson("pas du json")).toBeNull();
  });

  it("403 devient une NokkerApiError", async () => {
    const fetchImpl = (async () => jsonResponse(403, { error: { message: "outil interdit" } })) as unknown as FetchLike;
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl });
    await expect(c.callLocalTool("th_1", "todo")).rejects.toMatchObject({ status: 403 });
  });
});

describe("skills du dépôt et sous-agents (LOKKAL §7.21, §7.22)", () => {
  it("trustProjectSkills : POST /v1/local/skills/trust {thread_id, sha256}", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body });
      return jsonResponse(200, { thread_id: "th_1", root: "/w/p", sha256: "ab", trusted: true });
    }) as unknown as FetchLike;
    const c = new NokkerClient({ baseUrl: "http://x", token: "t", fetchImpl });
    expect(await c.trustProjectSkills("th_1", "ab")).toEqual({ thread_id: "th_1", root: "/w/p", sha256: "ab", trusted: true });
    expect(calls[0]).toMatchObject({ url: "http://x/v1/local/skills/trust", method: "POST" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ thread_id: "th_1", sha256: "ab" });
  });

  it("subagentParent : parent_thread_id, sinon thread_id", async () => {
    const { subagentParent, NOKKER_EVENT_TYPES } = await import("../src/types.js");
    expect(subagentParent({ parent_thread_id: "th_p", thread_id: "th_x" })).toBe("th_p");
    expect(subagentParent({ thread_id: "th_x" })).toBe("th_x");
    expect(subagentParent({})).toBeUndefined();
    expect(NOKKER_EVENT_TYPES).toContain("skill.untrusted");
  });
});
