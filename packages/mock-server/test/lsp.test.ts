/** Diagnostics de langage (lot 13) : générateur `lsp.diagnostics` après un `patch`, outil `lsp_diagnostics` (drapeau). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerApiError, NokkerClient, type LspDiagnosticsEvent, type LspDiagnosticsResult, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let dir: string;
let client: NokkerClient;
let events: NokkerEvent[];
let sub: { close(): void };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const lspEvents = (th: string): LspDiagnosticsEvent[] => events.filter((e): e is LspDiagnosticsEvent => e.type === "lsp.diagnostics" && e.thread_id === th);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-lsp-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir, localRoots: ["/work"], lsp: true });
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

describe("lsp.diagnostics", () => {
  it("un patch qui casse le typage publie 2 erreurs après son tool.result ; la réparation publie 0 ; l'outil rend l'état courant", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/calc" })).thread_id;
    await client.streamChatCompletion(th, [{ role: "user", content: "break the types in calc" }], () => {});
    await wait(50);
    const [first] = lspEvents(th);
    expect(first).toMatchObject({ path: "src/calc.py", counts: { error: 2, warning: 1 } });
    expect(first!.items[0]).toEqual({ line: 12, col: 5, severity: "error", code: "reportAttributeAccessIssue", message: 'Cannot access attribute "foo" for class "int"' });
    const patchResult = events.findIndex((e) => e.type === "tool.result" && e.thread_id === th && e.name === "patch");
    expect(patchResult).toBeGreaterThanOrEqual(0);
    expect(patchResult).toBeLessThan(events.indexOf(first!));

    let r = await client.callLocalTool(th, "lsp_diagnostics", { paths: ["src/calc.py", "src/other.py"] });
    let out = JSON.parse((r as { content: string }).content) as LspDiagnosticsResult;
    expect(out.language_servers).toEqual(["pyright"]);
    expect(out.files.map((f) => [f.path, f.errors, f.warnings])).toEqual([["src/calc.py", 2, 1], ["src/other.py", 0, 0]]);
    r = await client.callLocalTool(th, "lsp_diagnostics", { severity: "error" });
    out = JSON.parse((r as { content: string }).content) as LspDiagnosticsResult;
    expect(out.files[0]!.items.every((i) => i.severity === "error")).toBe(true);

    await client.streamChatCompletion(th, [{ role: "user", content: "fix the type errors" }], () => {});
    await wait(50);
    expect(lspEvents(th).at(-1)).toMatchObject({ path: "src/calc.py", counts: { error: 0, warning: 0 }, items: [] });
  });

  it("générateur de dev : lsp_thread, lsp_path, lsp_errors", async () => {
    await fetch(`${mock.url}/v1/dev/local-machine-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lsp_thread: "th_gen", lsp_path: "a.ts", lsp_errors: 3 }) });
    await wait(50);
    expect(lspEvents("th_gen").at(-1)).toMatchObject({ path: "a.ts", counts: { error: 3 } });
  });

  it("drapeau éteint : aucun événement, l'outil répond 403", async () => {
    mock.state.lsp = false;
    try {
      const th = (await client.createLocalSession({ cwd: "/work/off" })).thread_id;
      await client.streamChatCompletion(th, [{ role: "user", content: "break the types" }], () => {});
      await wait(50);
      expect(lspEvents(th)).toEqual([]);
      const err = await client.callLocalTool(th, "lsp_diagnostics", {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NokkerApiError);
      expect((err as NokkerApiError).status).toBe(403);
    } finally {
      mock.state.lsp = true;
    }
  });
});
