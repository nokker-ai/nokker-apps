/**
 * Sorties « exploitation » en anglais (langue par défaut) : doctor, lokkal.json, update, pont ACP. Le reste de la suite
 * tourne en français (vitest.config.ts) ; ici on bascule en anglais le temps d'un test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient, type LocalMemoryStatus } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { AcpAgent, toolTitle } from "../src/acp/agent.js";
import { RpcPeer } from "../src/acp/rpc.js";
import { nodeFs } from "../src/acp/run.js";
import { formatChecks, memoryCheck, runDoctor } from "../src/doctor.js";
import { setLang } from "../src/i18n/index.js";
import { SOURCE_DEFAULT, lokkalProblem, resolveServer, sourceLabel, validateLokkal } from "../src/lokkal.js";
import { clientHint } from "../src/update.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | null, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await wait(10);
  }
}

afterEach(() => setLang("fr"));

describe("doctor en anglais", () => {
  it("lignes de mémoire et mise en forme de la table", () => {
    setLang("en");
    const ok = memoryCheck({ ok: true, mode: "direct", store: { notes: 3 }, embed: { dim: 384, ms: 12 }, last_recall_ms: 40 } as unknown as LocalMemoryStatus);
    expect(ok).toEqual({ name: "memory", status: "ok", detail: "direct, 3 note(s), embeddings 384 dim in 12 ms, last recall 40 ms" });
    const down = memoryCheck({ ok: false, mode: "direct", error: "no index" } as unknown as LocalMemoryStatus);
    expect(down.detail).toBe("long-term memory (direct) is down — no index");
    expect(memoryCheck({ ok: true, mode: "off" } as unknown as LocalMemoryStatus).detail).toContain("long-term memory disabled (memory_mode: off)");
    const table = formatChecks([ok, { name: "server", status: "ko", detail: "unreachable" }]);
    expect(table).toBe("✓ memory  direct, 3 note(s), embeddings 384 dim in 12 ms, last recall 40 ms\n✗ server  unreachable");
    setLang("fr");
    expect(memoryCheck({ ok: true, mode: "direct", store: { notes: 3 } } as unknown as LocalMemoryStatus)).toEqual({ name: "mémoire", status: "ok", detail: "directe, 3 note(s)" });
  });

  describe("sans noyau ni docker", () => {
    let dir: string;
    const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "nokker-ops-en-"));
      process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
    });
    afterAll(async () => {
      if (keep === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
      else process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
      await rm(dir, { recursive: true, force: true });
    });

    it("runDoctor : noms et détails en anglais, origine « default » du serveur", async () => {
      setLang("en");
      const { checks, code } = await runDoctor({
        serverUrl: "http://localhost:1",
        serverSource: SOURCE_DEFAULT,
        fix: false,
        candidates: [],
        run: async () => ({ code: null, stdout: "", stderr: "", error: "ENOENT" }),
      });
      expect(code).toBe(1);
      const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
      expect(byName["docker"]?.detail).toBe("docker is not installed (or not in PATH)");
      expect(byName["Lokkal compose"]?.detail).toBe("lokkal.json is missing (no Lokkal installed by install.sh?)");
      expect(byName["server"]?.detail).toContain("(default) does not respond");
      expect(byName["authentication"]?.detail).toBe("cannot be checked without a server");
      expect(byName["git"]?.detail).toBe("git is missing from the host (needed for /diff and checkpoints)");
      expect(formatChecks(checks)).toContain("✗ server");
    });
  });
});

describe("lokkal.json et update en anglais", () => {
  it("clé manquante, chemin relatif, objet invalide", () => {
    setLang("en");
    const base = { compose: "/a", project: "p", version: "1", core_service: "core", api_url: "u", web_url: "w", token_path: "/t", env_file: "/e" };
    const { project: _p, ...withoutProject } = base;
    void _p;
    expect(validateLokkal(withoutProject)).toEqual({ error: "lokkal.json: missing or empty key(s): project (rerun install.sh)" });
    expect(validateLokkal({ ...base, compose: "rel/x.yml" })).toEqual({ error: "lokkal.json: non-absolute path(s): compose" });
    expect(validateLokkal([])).toEqual({ error: "lokkal.json is not a JSON object" });
    expect(validateLokkal({ ...base, wsl_distro: "Ubuntu" })).toEqual({ error: "lokkal.json: wsl_distro is set but install_dir is missing (Linux path of ~/.nokker)" });
    expect(lokkalProblem({ status: "absent" })).toBe("no Lokkal installed (~/.config/nokker/lokkal.json is missing — written by install.sh)");
  });

  it("origine du serveur affichée dans la langue choisie", () => {
    expect(resolveServer({ serverUrl: "http://localhost:8742", serverExplicit: true }, {}).source).toBe("--server");
    setLang("en");
    expect(sourceLabel(SOURCE_DEFAULT)).toBe("default");
    expect(sourceLabel("lokkal.json")).toBe("lokkal.json");
    setLang("fr");
    expect(sourceLabel(SOURCE_DEFAULT)).toBe("défaut");
  });

  it("indice de version minimale", () => {
    setLang("en");
    expect(clientHint({ min_client_version: "99.0.0" } as never)).toContain("The server requires a client ≥ 99.0.0 (yours: ");
    setLang("fr");
    expect(clientHint({ min_client_version: "99.0.0" } as never)).toContain("Le serveur demande un client ≥ 99.0.0");
  });
});

describe("pont ACP en anglais", () => {
  let dir: string;
  let proj: string;
  let mock: MockServerHandle;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-acp-en-"));
    proj = join(dir, "projects", "calc");
    await mkdir(proj, { recursive: true });
    mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [join(dir, "projects")] });
  });
  afterAll(async () => {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("titre d'un appel de terminal", () => {
    setLang("en");
    expect(toolTitle("terminal", { command: "pytest -q" }, "/work/calc")).toBe("terminal: pytest -q");
    setLang("fr");
    expect(toolTitle("terminal", { command: "pytest -q" }, "/work/calc")).toBe("terminal : pytest -q");
  });

  it("libellés des choix de permission, texte de carte forte et commandes annoncées", async () => {
    setLang("en");
    let toAgent: (l: string) => void = () => {};
    const sent: Array<{ method?: string; id?: number; params?: Record<string, unknown> }> = [];
    const editor = new RpcPeer({ write: (l) => toAgent(l) });
    const agentPeer = new RpcPeer({
      write: (l) => {
        for (const line of l.split("\n").filter(Boolean)) sent.push(JSON.parse(line));
        editor.feed(l);
      },
    });
    toAgent = (l) => agentPeer.feed(l);
    editor.onRequest("session/request_permission", () => new Promise(() => {})); // l'éditeur ne répond pas
    const client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
    const agent = new AcpAgent({ peer: agentPeer, connect: async () => client, fs: nodeFs, version: "test" });
    try {
      const { sessionId } = await editor.request<{ sessionId: string }>("session/new", { cwd: proj, mcpServers: [] }).promise;
      const turn = editor.request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text: "corrige le test add" }] }).promise;
      const ask = await until(() => sent.find((m) => m.method === "session/request_permission"));
      const names = (ask.params!.options as Array<{ name: string }>).map((o) => o.name);
      // Commande de test : la session d'abord (mêmes règles que le client terminal), puis « une fois ».
      expect(names.slice(0, 2)).toEqual(["For this session", "Once"]);
      expect(names[names.length - 1]).toBe("Reject");
      expect(names.some((n) => /^Always this command: \S/.test(n))).toBe(true);
      expect(names).not.toContain("Pour cette session");

      const cmds = sent.find((m) => (m.params?.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === "available_commands_update");
      const list = (cmds!.params!.update as { availableCommands: Array<{ name: string; description: string }> }).availableCommands;
      expect(list.find((c) => c.name === "cost")?.description).toBe("Cost of the session and of the day (no model call)");

      // La carte suivante est forte : elle se décide au terminal, et le dit en anglais.
      const card = (await client.listLocalApprovals()).find((a) => a.thread_id === sessionId)!;
      await client.decideLocalApproval(card.id, { decision: "approve", scope: "once" });
      const strong = await (async () => {
        for (let i = 0; i < 200; i++) {
          const c = (await client.listLocalApprovals()).find((a) => a.thread_id === sessionId && a.strength === "strong");
          if (c) return c;
          await wait(10);
        }
        return null;
      })();
      expect(strong).toBeTruthy();
      const said = await until(() =>
        sent.find((m) => JSON.stringify((m.params?.update as { content?: unknown } | undefined)?.content ?? "").includes("Strong action: decide it in the terminal")),
      );
      expect(said).toBeTruthy();
      await client.decideLocalApproval(strong!.id, { decision: "reject", scope: "once" });
      expect((await turn).stopReason).toBe("end_turn");
    } finally {
      agent.dispose();
    }
  }, 15_000);
});
