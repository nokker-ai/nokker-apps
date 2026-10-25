/**
 * `nokker acp` de bout en bout : le vrai processus (bin/nokker.mjs acp) contre le mock-server, piloté par un faux
 * éditeur écrit avec le SDK OFFICIEL de l'Agent Client Protocol (`@agentclientprotocol/sdk`, entrée stable v1) : ses
 * schémas valident chaque message que le pont envoie.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";

const bin = fileURLToPath(new URL("../bin/nokker.mjs", import.meta.url));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | null, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: délai dépassé");
    await wait(10);
  }
}

let dir: string;
let root: string;
let proj: string;
let mock: MockServerHandle;
let child: ChildProcessWithoutNullStreams;
let stderr = "";
const updates: SessionNotification[] = [];
const permissions: RequestPermissionRequest[] = [];
/** Réponse du faux éditeur à la prochaine demande de permission (`null` : ne répond jamais). */
let answer: ((r: RequestPermissionRequest) => RequestPermissionResponse | null) = () => ({ outcome: { outcome: "cancelled" } });
type Ctx = Parameters<Parameters<ReturnType<typeof acpClient>["connectWith"]>[1]>[0];
let ctx: Ctx;
let closeConnection: () => void;
let connection: Promise<unknown>;
/** Le SDK journalise (console.error) puis JETTE tout message hors schéma : aucun ne doit l'être. */
const sdkErrors: unknown[][] = [];

const localApi = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> => {
  const res = await fetch(`${mock.url}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${mock.localToken}`, "Content-Type": "application/json" },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return res.json();
};

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void sdkErrors.push(args));
  dir = await mkdtemp(join(tmpdir(), "nokker-acp-"));
  root = join(dir, "projets");
  proj = join(root, "calc");
  await mkdir(join(proj, "src"), { recursive: true });
  // Le mock n'écrit rien : le fichier porte déjà le texte APRÈS patch, le pont doit refaire l'ancien.
  await writeFile(join(proj, "src", "app.py"), "def add(a, b):\n    return a + b\n");
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [root] });
  child = spawn(process.execPath, [bin, "acp", "--server", mock.url], {
    env: { ...process.env, NOKKER_CONFIG_DIR_OVERRIDE: join(dir, "config"), NOKKER_SERVER_URL: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  const app = acpClient({ name: "faux-editeur" })
    .onNotification("session/update", ({ params }) => {
      updates.push(params);
    })
    .onRequest("session/request_permission", async ({ params }) => {
      permissions.push(params);
      const r = answer(params);
      if (r) return r;
      return new Promise<RequestPermissionResponse>(() => {}); // jamais : l'annulation du tour tranche
    });
  let ready: () => void = () => {};
  const isReady = new Promise<void>((r) => (ready = r));
  connection = app.connectWith(stream, async (c) => {
    ctx = c;
    ready();
    await new Promise<void>((r) => (closeConnection = r));
  });
  await isReady;
}, 30_000);

afterAll(async () => {
  closeConnection?.();
  await connection?.catch(() => undefined);
  child?.kill();
  await mock?.close();
  await rm(dir, { recursive: true, force: true });
});

const ofSession = (sid: string) => updates.filter((u) => u.sessionId === sid).map((u) => u.update);
const text = (sid: string): string =>
  ofSession(sid)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (u as { content: { type: string; text?: string } }).content.text ?? "")
    .join("");

describe("nokker acp (ACP v1) contre le mock", () => {
  let sid = "";

  it("initialize : protocole v1, sessions rechargeables, images et contexte embarqué", async () => {
    const r = await ctx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
    expect(r.protocolVersion).toBe(1);
    expect(r.agentCapabilities?.loadSession).toBe(true);
    expect(r.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(r.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
    expect(r.agentInfo?.name).toBe("nokker");
    expect(r.authMethods).toEqual([]);
  });

  it("session/new = session locale du dossier (POST /v1/local/sessions) + commandes annoncées", async () => {
    const r = await ctx.request("session/new", { cwd: proj, mcpServers: [] });
    sid = r.sessionId;
    expect(sid).toMatch(/^th_/);
    const sessions = (await localApi("/v1/local/sessions")) as { sessions: Array<{ thread_id: string; cwd: string }> };
    expect(sessions.sessions.some((s) => s.thread_id === sid && s.cwd === proj)).toBe(true);
    const cmds = await until(() => ofSession(sid).find((u) => u.sessionUpdate === "available_commands_update"));
    expect((cmds as { availableCommands: Array<{ name: string }> }).availableCommands.map((c) => c.name)).toEqual(["cost", "diff", "plan", "checkpoints"]);
  });

  it("dossier hors des racines : erreur claire, pas de session", async () => {
    await expect(ctx.request("session/new", { cwd: join(dir, "ailleurs"), mcpServers: [] })).rejects.toThrow(/hors des racines/);
  });

  it("un tour : texte, outils avec effet, diff du patch, carte → permission, carte forte → terminal (machine non liée), coût", async () => {
    let terminalSeen = false;
    answer = (req) => {
      // Commande de test : « Pour cette session » est la première option (mêmes règles que la CLI).
      expect(req.options[0]!.name).toBe("Pour cette session");
      expect(req.options.map((o) => o.kind)).toContain("reject_once");
      return { outcome: { outcome: "selected", optionId: req.options[0]!.optionId } };
    };
    const turn = ctx.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "corrige le test add" }] });
    // La carte forte (rm -rf build) n'est PAS proposée à l'éditeur. Machine non liée (défaut du mock) : elle ne part pas
    // au téléphone, l'éditeur dit qu'elle se décide dans le terminal. Le test joue le terminal : il la refuse par l'API
    // locale.
    const where = await until(() =>
      ofSession(sid).find(
        (u) => u.sessionUpdate === "tool_call_update" && JSON.stringify((u as { content?: unknown }).content ?? "").includes("à décider dans le terminal (`nokker`)"),
      ),
    );
    terminalSeen = Boolean(where);
    const cards = (await localApi("/v1/local/approvals")) as { approvals: Array<{ id: string; thread_id: string; strength: string }> };
    const strong = cards.approvals.find((a) => a.thread_id === sid && a.strength === "strong");
    expect(strong).toBeTruthy();
    await localApi(`/v1/local/approvals/${strong!.id}/decide`, { method: "POST", body: { decision: "reject", scope: "once" } });
    const res = await turn;
    expect(res.stopReason).toBe("end_turn");
    expect(terminalSeen).toBe(true);
    expect(JSON.stringify(ofSession(sid))).not.toContain("attend ton téléphone");

    // Une seule demande de permission : la commande de test (la carte forte n'en fait pas).
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.toolCall.toolCallId).toBeTruthy();

    const u = ofSession(sid);
    const calls = u.filter((x) => x.sessionUpdate === "tool_call") as Array<{ toolCallId: string; title: string; kind?: string }>;
    expect(calls.map((c) => c.kind)).toEqual(["read", "search", "edit", "execute", "execute"]);
    expect(calls[2]!.title).toBe("patch src/app.py");
    // La carte se rattache à l'appel `terminal pytest` annoncé.
    expect(permissions[0]!.toolCall.toolCallId).toBe(calls[3]!.toolCallId);

    const ends = u.filter((x) => x.sessionUpdate === "tool_call_update" && (x as { status?: string }).status) as Array<{
      toolCallId: string;
      status: string;
      content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
    }>;
    const patchEnd = ends.find((e) => e.toolCallId === calls[2]!.toolCallId && e.status === "completed");
    const diff = patchEnd?.content?.find((c) => c.type === "diff");
    expect(diff?.path).toBe(join(proj, "src", "app.py"));
    expect(diff?.oldText).toBe("def add(a, b):\n    return a - b\n");
    expect(diff?.newText).toBe("def add(a, b):\n    return a + b\n");
    expect(ends.find((e) => e.toolCallId === calls[4]!.toolCallId && e.status === "failed")).toBeTruthy();

    const all = text(sid);
    // Le chunk final ne double pas le texte déjà reçu en direct.
    expect(all.split("J'ai corrigé")).toHaveLength(2);
    expect(all).toMatch(/_[\d,]+ (k )?jetons · [\d,<\s]+ €_/);
    expect((res as { _meta?: { nokker?: { cost?: { total_tokens?: number } } } })._meta?.nokker?.cost?.total_tokens).toBeGreaterThan(0);
  }, 20_000);

  it("session/cancel arrête le tour (POST /cancel) : stopReason cancelled", async () => {
    permissions.length = 0;
    answer = () => null; // l'éditeur laisse la carte ouverte
    const turn = ctx.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "corrige le test add" }] });
    // « Pour cette session » couvre déjà pytest : la seule carte est la forte → terminal, puis on annule.
    await until(() => ofSession(sid).filter((x) => x.sessionUpdate === "tool_call_update" && JSON.stringify(x).includes("à décider dans le terminal")).length >= 2);
    await ctx.notify("session/cancel", { sessionId: sid });
    const res = await turn;
    expect(res.stopReason).toBe("cancelled");
    expect(permissions).toHaveLength(0);
    const left = (await localApi("/v1/local/approvals")) as { approvals: Array<{ thread_id: string }> };
    expect(left.approvals.filter((a) => a.thread_id === sid)).toHaveLength(0);
  }, 20_000);

  it("noyau réel (cartes « en attente » + tour de suite à la décision) : la demande ne finit qu'avec ses suites", async () => {
    mock.state.approvalStyle = "kernel";
    mock.state.strongRelay = true; // machine liée : la carte forte part chez nokker.ai, donc au téléphone
    mock.state.strongRelayMs = 30_000; // ×0.01 : le dépôt arrive après que l'éditeur a montré la carte
    try {
      const k = (await ctx.request("session/new", { cwd: proj, mcpServers: [] })).sessionId;
      permissions.length = 0;
      answer = (req) => ({ outcome: { outcome: "selected", optionId: req.options.find((o) => o.kind === "allow_once")!.optionId } });
      let resolved = false;
      const turn = ctx.request("session/prompt", { sessionId: k, prompt: [{ type: "text", text: "corrige le test add" }] }).finally(() => (resolved = true));
      // Carte 1 (pytest) accordée « une fois » → tour de suite → carte forte déposée (téléphone) : la demande attend.
      await until(() => ofSession(k).some((u) => u.sessionUpdate === "tool_call_update" && JSON.stringify(u).includes("attend ton téléphone")));
      const cardsNow = (await localApi("/v1/local/approvals")) as { approvals: Array<{ thread_id: string; strength: string; forwarded?: boolean }> };
      expect(cardsNow.approvals.find((a) => a.thread_id === k && a.strength === "strong")?.forwarded).toBe(true);
      // Montrée d'abord « au terminal » (pas encore déposée), puis mise à jour par `approval.forwarded`.
      const where = ofSession(k)
        .map((u) => JSON.stringify(u))
        .filter((j) => j.includes("tool_call_update") && j.includes("Action forte"))
        .map((j) => (j.includes("attend ton téléphone") ? "téléphone" : "terminal"));
      expect(where).toEqual(["terminal", "téléphone"]);
      await wait(300);
      expect(resolved).toBe(false);
      const cards = (await localApi("/v1/local/approvals")) as { approvals: Array<{ id: string; thread_id: string; strength: string }> };
      const strong = cards.approvals.find((a) => a.thread_id === k && a.strength === "strong")!;
      await localApi(`/v1/local/approvals/${strong.id}/decide`, { method: "POST", body: { decision: "reject", scope: "once" } });
      const res = await turn;
      expect(res.stopReason).toBe("end_turn");
      expect(permissions).toHaveLength(1);

      const u = ofSession(k);
      const calls = u.filter((x) => x.sessionUpdate === "tool_call") as Array<{ toolCallId: string; title: string }>;
      const pytest = calls.find((c) => c.title.includes("pytest"))!;
      // La carte se rattache à l'appel qui l'attend (marqueur [approval:…]), pas à un appel inventé.
      expect(permissions[0]!.toolCall.toolCallId).toBe(pytest.toolCallId);
      const ends = u.filter((x) => x.sessionUpdate === "tool_call_update" && (x as { status?: string }).status) as Array<{
        toolCallId: string;
        status: string;
        rawOutput?: { preview?: string | null };
      }>;
      // L'appel approuvé se ferme sur le `tool.result` de l'exécuteur : la vraie sortie de l'outil.
      const pytestEnds = ends.filter((e) => e.toolCallId === pytest.toolCallId);
      expect(pytestEnds.map((e) => e.status)).toEqual(["completed"]);
      expect(pytestEnds[0]!.rawOutput?.preview).toContain("1 passed");
      const rm = calls.find((c) => c.title.includes("rm -rf build"))!;
      // Carte forte refusée : l'appel (« attend ton téléphone ») se ferme en échec, sans `tool.result`.
      expect(ends.filter((e) => e.toolCallId === rm.toolCallId).at(-1)?.status).toBe("failed");
      const all = text(k);
      expect(all).toContain("attend ton approbation sur la carte");
      // Un refus ne lance pas de tour de suite (`continuation: "none"`) : la demande et la suite de l'approbation.
      expect(all).not.toContain("refusée");
      expect(all.match(/_[\d,]+ (k )?jetons · [^_]+_/g)).toHaveLength(2);
    } finally {
      mock.state.approvalStyle = "inline";
      mock.state.strongRelay = false;
      mock.state.strongRelayMs = 300;
    }
  }, 20_000);

  it("/cost et /checkpoints : sans tour modèle", async () => {
    const before = text(sid).length;
    const r = await ctx.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "/cost" }] });
    expect(r.stopReason).toBe("end_turn");
    expect(text(sid).slice(before)).toMatch(/Session : .*jetons[\s\S]*Jour \(UTC/);
    const r2 = await ctx.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "/checkpoints" }] });
    expect(r2.stopReason).toBe("end_turn");
    expect(text(sid)).toMatch(/1\. `[0-9a-f]{8}`/);
  });

  it("session/list et session/load : reprise du fil, historique rejoué", async () => {
    const list = await ctx.request("session/list", { cwd: proj });
    expect(list.sessions.map((s) => s.sessionId)).toContain(sid);
    const n = updates.length;
    await ctx.request("session/load", { sessionId: sid, cwd: proj, mcpServers: [] });
    const replay = updates.slice(n).filter((x) => x.sessionId === sid).map((x) => x.update.sessionUpdate);
    expect(replay).toContain("user_message_chunk");
    expect(replay).toContain("agent_message_chunk");
  });

  it("stdout ne porte que le protocole (rien sur stderr non plus), aucun message rejeté par les schémas du SDK", () => {
    expect(stderr).toBe("");
    expect(sdkErrors).toEqual([]);
  });
});
