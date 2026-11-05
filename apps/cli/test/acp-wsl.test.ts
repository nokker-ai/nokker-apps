/** ACP sous Windows + WSL : dossier de l'éditeur en UNC, dossier du noyau en chemin Linux. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient, hostPathOf } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { AcpAgent, toolTitle } from "../src/acp/agent.js";
import { RpcPeer } from "../src/acp/rpc.js";
import { nodeFs } from "../src/acp/run.js";

describe("hostPathOf : chemin du noyau → chemin UNC de l'éditeur", () => {
  const host = "\\\\wsl.localhost\\Ubuntu\\home\\u\\p";
  const server = "/home/u/p";
  it("chemin absolu du noyau : préfixe remplacé, séparateurs Windows", () => {
    expect(hostPathOf("/home/u/p/src/a.py", host, server)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\p\\src\\a.py");
  });
  it("/workspace et relatif, comme avant", () => {
    expect(hostPathOf("/workspace/src/a.py", host, server)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\p\\src\\a.py");
    expect(hostPathOf("src/a.py", host, server)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\p\\src\\a.py");
  });
  it("hors du dossier : null", () => {
    expect(hostPathOf("/home/u/autre/a.py", host, server)).toBeNull();
    expect(hostPathOf("/home/u/p/../x", host, server)).toBeNull();
  });
  it("titre d'outil", () => {
    expect(toolTitle("patch", { path: "/home/u/p/src/a.py" }, host, server)).toBe("patch src\\a.py");
  });
});

describe("session/new et session/list avec un dossier UNC", () => {
  let dir: string;
  let proj: string;
  let mock: MockServerHandle;
  const wsl = { platform: "win32", wslDistro: "Ubuntu" };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-acp-wsl-"));
    proj = join(dir, "projets", "calc");
    await mkdir(proj, { recursive: true });
    mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [join(dir, "projets")] });
  });
  afterAll(async () => {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });

  function pair(): { editor: RpcPeer; agent: AcpAgent; client: NokkerClient } {
    let toAgent: (l: string) => void = () => {};
    const editor = new RpcPeer({ write: (l) => toAgent(l) });
    const agentPeer = new RpcPeer({ write: (l) => editor.feed(l) });
    toAgent = (l) => agentPeer.feed(l);
    const client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
    return { editor, client, agent: new AcpAgent({ peer: agentPeer, connect: async () => client, fs: nodeFs, version: "test", wsl }) };
  }

  it("dossier d'un disque Windows hors des racines : refus qui dit d'ouvrir le projet dans WSL", async () => {
    const { editor, agent } = pair();
    try {
      await expect(editor.request("session/new", { cwd: "C:\\Users\\alice\\calc", mcpServers: [] }).promise).rejects.toThrow(/C:.*\/mnt\/c\/Users\/alice\/calc.*wsl\.localhost\\Ubuntu/);
    } finally {
      agent.dispose();
    }
  });

  it("autre distro WSL : refus sans appel au noyau", async () => {
    const { editor, agent } = pair();
    try {
      await expect(editor.request("session/new", { cwd: "\\\\wsl.localhost\\Debian\\home\\alice", mcpServers: [] }).promise).rejects.toThrow(/Debian.*Ubuntu/);
    } finally {
      agent.dispose();
    }
  });

  it("l'ouverture se fait sur le chemin Linux ; la liste se filtre sur le chemin du noyau et rend le dossier de l'éditeur", async () => {
    const { editor, agent, client } = pair();
    const unc = `\\\\wsl.localhost\\UBUNTU${proj.replace(/\//g, "\\")}`;
    try {
      const { sessionId } = await editor.request<{ sessionId: string }>("session/new", { cwd: unc, mcpServers: [] }).promise;
      expect((await client.listLocalSessions()).find((s) => s.thread_id === sessionId)?.cwd).toBe(proj);
      const l = await editor.request<{ sessions: Array<{ sessionId: string; cwd: string }> }>("session/list", { cwd: unc }).promise;
      expect(l.sessions).toEqual([expect.objectContaining({ sessionId, cwd: unc })]);
      await editor.request("session/load", { sessionId, cwd: unc, mcpServers: [] }).promise;
    } finally {
      agent.dispose();
    }
  }, 15_000);
});
