import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01, seed: false });
  c = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
});
afterEach(async () => {
  await mock.close();
});

let local_hermes: () => Promise<void>;
describe("import d'un autre agent (mock)", () => {
  it("scan à blanc, apply sans MCP, dernier rapport relu (filtré par source)", async () => {
    local_hermes = async () => {
      await expect(c.importLatestReport("hermes")).rejects.toMatchObject({ status: 404 });
    };
    await expect(c.importLatestReport()).rejects.toMatchObject({ status: 404 });
    const s = await c.importScan("claude-code");
    expect(s.counts.planned).toBe(3);
    const a = await c.importApply("claude-code");
    expect(a.items.find((i) => i.kind === "mcp" && i.detail.name === "docs")?.status).toBe("skipped");
    expect(a.counts.imported).toBe(2);
    const last = await c.importLatestReport("claude-code");
    expect(last.dir).toBe("claude-code-demo");
    expect(JSON.stringify(last)).not.toMatch(/sk-|Bearer /);
    await local_hermes();
  });

  it("jeton local exigé, source connue", async () => {
    const anon = new NokkerClient({ baseUrl: mock.url, token: "autre" });
    await expect(anon.importScan("cursor")).rejects.toBeInstanceOf(NokkerApiError);
    await expect(c.importScan("chatgpt" as never)).rejects.toMatchObject({ status: 400 });
  });
});

describe("mémoire importée de Codex (mock, données)", () => {
  it("liste, retient une entrée, en retire une, défait tout ; jeton local seulement", async () => {
    const { entries } = await c.listImportedMemory();
    expect(entries.length).toBe(3);
    expect(entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))).toBe(true);
    const kept = await c.promoteImportedMemory(entries[0]!.name);
    expect(kept.note.scope).toBe("user");
    expect((await c.undoImportedMemory(entries[1]!.name)).undone).toBe(1);
    expect((await c.undoImportedMemory()).undone).toBe(1);
    expect((await c.listImportedMemory()).entries).toEqual([]);
    const anon = new NokkerClient({ baseUrl: mock.url, token: "autre" });
    await expect(anon.listImportedMemory()).rejects.toMatchObject({ status: 401 });
  });
});
