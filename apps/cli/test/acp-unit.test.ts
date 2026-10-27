/**
 * Pont ACP en mémoire (sans processus) : conversion du contenu, et retrait d'une demande de permission quand la carte
 * est décidée ailleurs (`$/cancel_request`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { AcpAgent, promptToRequest, relFromUri, toolKind, toolTitle } from "../src/acp/agent.js";
import { RpcPeer } from "../src/acp/rpc.js";
import { nodeFs } from "../src/acp/run.js";
import { setLang, type Lang } from "../src/i18n/index.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | null, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: délai dépassé");
    await wait(10);
  }
}

describe("contenu ACP → demande du tour", () => {
  const cwd = "/home/alice/projets/calc";
  it("texte, fichier embarqué (sélection), lien de fichier, image", () => {
    const r = promptToRequest(
      [
        { type: "text", text: "explique" },
        { type: "resource", resource: { uri: `file://${cwd}/src/app.py#L1:2`, text: "def add(a, b):\n    return a + b", mimeType: "text/x-python" } },
        { type: "resource_link", uri: `file://${cwd}/README.md`, name: "README.md" },
        { type: "resource_link", uri: `file://${cwd}/capture.png`, name: "capture.png", mimeType: "image/png" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      cwd,
    );
    expect(r.text).toContain("explique");
    expect(r.text).toContain("src/app.py#L1:2:\n```\ndef add(a, b):");
    expect(r.text).toContain("@README.md");
    expect(r.attachments).toEqual([{ path: "capture.png" }, { data: "iVBORw0KGgo=", media_type: "image/png", name: "image-2.png" }]);
  });

  it("plus de 4 images : refus avant tout appel", () => {
    const img = { type: "image" as const, data: "x", mimeType: "image/png" };
    expect(() => promptToRequest([img, img, img, img, img], cwd)).toThrow(/At most 4 images/);
  });

  it("uri hors du dossier : laissée telle quelle, jamais lue", () => {
    expect(relFromUri("file:///etc/passwd", cwd)).toBeNull();
    expect(relFromUri(`file://${cwd}/../secret`, cwd)).toBeNull();
    expect(relFromUri("https://example.org/a.png", cwd)).toBeNull();
  });

  it("genre et titre d'un appel d'outil", () => {
    expect(toolKind("read_file", "read")).toBe("read");
    expect(toolKind("patch", "write")).toBe("edit");
    expect(toolKind("terminal", "destructive")).toBe("execute");
    expect(toolKind("inconnu", "send_external")).toBe("other");
    expect(toolTitle("terminal", { command: "pytest -q" }, cwd)).toBe("terminal: pytest -q");
    expect(toolTitle("patch", { path: "/workspace/src/app.py" }, cwd)).toBe("patch src/app.py");
  });
});

describe("carte décidée ailleurs → $/cancel_request", () => {
  let dir: string;
  let proj: string;
  let mock: MockServerHandle;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-acp-unit-"));
    proj = join(dir, "projets", "calc");
    await mkdir(proj, { recursive: true });
    mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [join(dir, "projets")] });
  });
  afterAll(async () => {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("le terminal décide la carte pendant que l'éditeur hésite : la demande est retirée, aucune décision de plus", async () => {
    // Deux extrémités reliées en mémoire : `editor` joue le client ACP.
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
      const { sessionId } = (await editor.request<{ sessionId: string }>("session/new", { cwd: proj, mcpServers: [] }).promise);
      const turn = editor.request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text: "corrige le test add" }] }).promise;
      const ask = await until(() => sent.find((m) => m.method === "session/request_permission"));
      const card = (await client.listLocalApprovals()).find((a) => a.thread_id === sessionId)!;
      await client.decideLocalApproval(card.id, { decision: "approve", scope: "once" }); // décidée « dans le terminal »
      const cancel = await until(() => sent.find((m) => m.method === "$/cancel_request"));
      expect(cancel.params).toEqual({ requestId: ask.id });
      // La carte forte suivante se décide au terminal (machine non liée) ; on la refuse par l'API pour finir le tour.
      const s2 = await (async () => {
        for (let i = 0; i < 200; i++) {
          const c = (await client.listLocalApprovals()).find((a) => a.thread_id === sessionId && a.strength === "strong");
          if (c) return c;
          await wait(10);
        }
        return null;
      })();
      expect(s2).toBeTruthy();
      await client.decideLocalApproval(s2!.id, { decision: "reject", scope: "once" });
      expect((await turn).stopReason).toBe("end_turn");
      expect(sent.filter((m) => m.method === "session/request_permission")).toHaveLength(1);
    } finally {
      agent.dispose();
    }
  }, 15_000);
});

describe("carte forte déposée chez nokker.ai → texte du téléphone", () => {
  let dir: string;
  let proj: string;
  let mock: MockServerHandle;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-acp-phone-"));
    proj = join(dir, "projets", "calc");
    await mkdir(proj, { recursive: true });
    mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [join(dir, "projets")], approvalStyle: "kernel" });
    mock.state.strongRelay = true; // machine liée : la carte forte part chez nokker.ai, donc au téléphone
    mock.state.strongRelayMs = 30_000; // ×0.01 : le dépôt arrive après que l'éditeur a montré la carte
  });
  afterAll(async () => {
    setLang("en");
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });

  for (const [lang, expected] of [
    ["fr", "Action forte : elle attend ton téléphone."],
    ["en", "Strong action: it waits for your phone."],
  ] as Array<[Lang, string]>) {
    it(`langue ${lang} : le texte de la carte forte déposée est « ${expected} »`, async () => {
      setLang(lang);
      try {
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
        // L'éditeur accorde la carte standard (pytest) « une fois » ; la carte forte ne lui est jamais proposée.
        editor.onRequest("session/request_permission", (params: unknown) => {
          const options = (params as { options: Array<{ optionId: string; kind: string }> }).options;
          return { outcome: { outcome: "selected", optionId: options.find((o) => o.kind === "allow_once")!.optionId } };
        });
        const client = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
        const agent = new AcpAgent({ peer: agentPeer, connect: async () => client, fs: nodeFs, version: "test" });
        try {
          const { sessionId } = await editor.request<{ sessionId: string }>("session/new", { cwd: proj, mcpServers: [] }).promise;
          const turn = editor.request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text: "corrige le test add" }] }).promise;
          const said = await until(() =>
            sent.find((m) => JSON.stringify((m.params?.update as { content?: unknown } | undefined)?.content ?? "").includes(expected)),
          );
          expect(said).toBeTruthy();
          const strong = (await client.listLocalApprovals()).find((a) => a.thread_id === sessionId && a.strength === "strong");
          expect(strong?.forwarded).toBe(true);
          await client.decideLocalApproval(strong!.id, { decision: "reject", scope: "once" });
          expect((await turn).stopReason).toBe("end_turn");
        } finally {
          agent.dispose();
        }
      } finally {
        setLang("en");
      }
    }, 20_000);
  }
});
