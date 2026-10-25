/**
 * Vue Sessions contre le mock-server : sessions du noyau local, celles du dossier d'abord, état vivant (tour en cours,
 * cartes en attente) par les événements, coût cumulé par `GET /v1/local/cost`, session ouverte ailleurs (CLI) vue dès
 * qu'elle tourne, reprise d'une session depuis la vue.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { NokkerClient } from "@nokker-apps/sdk";
import { ChatController } from "../../src/controller.js";
import type { ToView } from "../../src/protocol.js";
import { SessionsModel, sortRows, underFolder, type SessionRow } from "../../src/sessions.js";
import { LocalEventHub } from "@nokker-apps/sdk";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | null, ms = 6000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: délai dépassé");
    await wait(10);
  }
}
const fsReader = {
  async read(p: string) {
    try {
      return await readFile(p, "utf-8");
    } catch {
      return null;
    }
  },
};

describe("tri et dossiers", () => {
  const row = (id: string, inFolder: boolean, updatedAt: string | null): SessionRow => ({
    threadId: id,
    cwd: "/w",
    title: id,
    inFolder,
    current: false,
    working: false,
    cards: 0,
    strongCards: 0,
    cost: null,
    updatedAt,
  });
  it("dossier d'abord, puis les plus récentes, puis l'ordre d'ouverture du noyau", () => {
    const rows = [row("a", false, "2026-10-25T10:00:00Z"), row("b", true, "2026-10-24T10:00:00Z"), row("c", true, null), row("d", true, "2026-10-25T09:00:00Z")];
    const order = new Map([["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
    expect(sortRows(rows, order).map((r) => r.threadId)).toEqual(["d", "b", "c", "a"]);
  });
  it("sous un dossier ouvert (chemins Windows compris), jamais un voisin au préfixe commun", () => {
    expect(underFolder("/home/alice/calc", ["/home/alice/calc"])).toBe(true);
    expect(underFolder("/home/alice/calc/sub", ["/home/alice/calc/"])).toBe(true);
    expect(underFolder("/home/alice/calcul", ["/home/alice/calc"])).toBe(false);
    expect(underFolder("C:\\u\\calc\\src", ["C:\\u\\calc"])).toBe(true);
  });
});

describe("lignes du noyau (25.10) et repli rc.6", () => {
  function fakeClient(sessions: unknown[], threads: unknown[] | null) {
    const calls: string[] = [];
    const client = {
      listLocalSessions: async () => (calls.push("sessions"), sessions),
      listThreads: async () => (calls.push("threads"), threads ?? []),
      listLocalApprovals: async () => (calls.push("approvals"), []),
      getLocalCost: async () => ({ session: null, day: {} }),
      subscribeEvents: () => ({ close() {} }),
    };
    return { client: client as unknown as NokkerClient, calls };
  }
  const opts = { folders: () => ["/w"], current: () => null, debounceMs: 1 };

  it("une ligne décrite (title, last_turn_at, working, pending_approvals) : pas de GET /v1/threads", async () => {
    const { client, calls } = fakeClient([{ thread_id: "th_a", cwd: "/w/app", title: "Fix the tests", last_turn_at: "2026-10-25T10:00:00+00:00", working: true, pending_approvals: 2 }], null);
    const m = new SessionsModel(client, new LocalEventHub(client), opts);
    await m.refresh();
    expect(calls).not.toContain("threads");
    expect(m.rows()[0]).toMatchObject({ title: "Fix the tests", updatedAt: "2026-10-25T10:00:00+00:00", working: true, cards: 0 });
    m.dispose();
  });

  it("titre null avant le premier tour : le nom du dossier ; noyau rc.6 ({thread_id, cwd}) : titres par /v1/threads", async () => {
    const fresh = fakeClient([{ thread_id: "th_b", cwd: "/w/calc", title: null, last_turn_at: null, working: false, pending_approvals: 0 }], null);
    const m1 = new SessionsModel(fresh.client, new LocalEventHub(fresh.client), opts);
    await m1.refresh();
    expect(m1.rows()[0]).toMatchObject({ title: "calc", updatedAt: null, working: false });
    m1.dispose();
    const old = fakeClient([{ thread_id: "th_c", cwd: "/w/calc" }], [{ id: "th_c", title: "Old title", updated_at: "2026-10-20T08:00:00Z", working: true }]);
    const m2 = new SessionsModel(old.client, new LocalEventHub(old.client), opts);
    await m2.refresh();
    expect(old.calls).toContain("threads");
    expect(m2.rows()[0]).toMatchObject({ title: "Old title", updatedAt: "2026-10-20T08:00:00Z", working: true });
    m2.dispose();
  });
});

describe("SessionsModel contre le mock", () => {
  let dir: string;
  let proj: string;
  let other: string;
  let mock: MockServerHandle;
  const previous = process.env.NOKKER_CONFIG_DIR_OVERRIDE;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-vscode-sessions-"));
    proj = join(dir, "projets", "calc");
    other = join(dir, "projets", "autre");
    await mkdir(join(proj, "src"), { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(proj, "src", "app.py"), "def add(a, b):\n    return a + b\n");
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = join(dir, "config");
    mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [join(dir, "projets")] });
  });

  afterAll(async () => {
    await mock.close();
    if (previous === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    else process.env.NOKKER_CONFIG_DIR_OVERRIDE = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it("liste, état vivant, cartes, coût cumulé, session ouverte par la CLI, reprise", async () => {
    const posted: ToView[] = [];
    let changes = 0;
    const ctl = new ChatController(
      { post: (m) => posted.push(m), openDiff: async () => {}, sessionsChanged: () => void changes++ },
      { serverUrl: mock.url, folder: proj, fs: fsReader, folders: () => [proj], lang: "en" },
    );
    expect(await ctl.connect()).toBe(true);
    const sessions = ctl.sessions!;
    await sessions.refresh();
    const first = ctl.threadId!;
    expect(sessions.rows()).toEqual([expect.objectContaining({ threadId: first, cwd: proj, title: "calc", inFolder: true, current: true, working: false, cards: 0, cost: null })]);

    // Une session ouverte ailleurs (comme `nokker` dans un terminal), sur un autre dossier : vue dès son premier tour.
    const cli = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
    const elsewhere = (await cli.createLocalSession({ cwd: other })).thread_id;
    await cli.streamChatCompletion(elsewhere, [{ role: "user", content: "bonjour" }], () => {});
    await until(() => sessions.rows().find((r) => r.threadId === elsewhere && r.cost));
    const far = sessions.rows().find((r) => r.threadId === elsewhere)!;
    expect(far).toMatchObject({ inFolder: false, current: false, title: "autre" });
    expect(far.cost).toMatch(/tokens/); // coût cumulé de la session (GET /v1/local/cost), en anglais
    expect(sessions.rows().map((r) => r.threadId)).toEqual([first, elsewhere]); // le dossier d'abord

    // Un tour dans la session affichée : « travaille », une carte en attente, puis le coût cumulé.
    const turn = ctl.send("corrige le test add");
    await until(() => sessions.rows().find((r) => r.threadId === first && r.working));
    const card = (await until(() => posted.find((m) => m.type === "card" && m.card.choices))) as Extract<ToView, { type: "card" }>;
    await until(() => sessions.rows().find((r) => r.threadId === first && r.cards === 1 && r.strongCards === 0));
    await ctl.decide(card.card.id, card.card.choices!.find((c) => c.id === "once")!.index);
    const strong = (await until(() => posted.find((m) => m.type === "card" && !m.card.choices))) as Extract<ToView, { type: "card" }>;
    await until(() => sessions.rows().find((r) => r.threadId === first && r.strongCards === 1));
    await cli.decideLocalApproval(strong.card.id, { decision: "reject", scope: "once" });
    await turn;
    const done = await until(() => sessions.rows().find((r) => r.threadId === first && !r.working && r.cards === 0 && r.cost));
    expect(done.cost).toMatch(/tokens/);
    expect(changes).toBeGreaterThan(3);

    // Nouvelle session dans le dossier, puis reprise de la première depuis la vue.
    expect(await ctl.newThread()).toBe(true);
    const second = ctl.threadId!;
    await sessions.refresh();
    expect(sessions.rows().filter((r) => r.inFolder).map((r) => r.threadId).sort()).toEqual([first, second].sort());
    expect(sessions.rows().find((r) => r.current)?.threadId).toBe(second);
    const n = posted.length;
    expect(await ctl.openSession(first, proj)).toBe(true);
    expect(ctl.threadId).toBe(first);
    // L'historique du fil repris est rejoué dans le panneau.
    const history = posted.slice(n).filter((m) => m.type === "history").at(-1) as Extract<ToView, { type: "history" }>;
    expect(history.messages.some((m) => m.role === "user" && m.text.includes("corrige le test add"))).toBe(true);
    expect(sessions.rows().find((r) => r.current)?.threadId).toBe(first);
    ctl.dispose();
  }, 30_000);
});
