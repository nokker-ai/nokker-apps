/**
 * Revue des écritures d'un tour contre le mock-server en mode « écritures réelles » (`localWrites`) : le point de retour
 * du tour est trouvé dans `checkpoint_list`, refuser un fichier appelle `checkpoint_restore {hash, file}` (carte FORTE
 * du noyau, jamais décidée par l'éditeur : ici décidée « au terminal » par l'API), le fichier revient sur le disque.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import type { CheckpointInfo } from "@nokker-apps/sdk";
import { ChatController } from "../../src/controller.js";
import type { ToView } from "../../src/protocol.js";
import { pickTurnPoint, restoreOutcome, TurnReview } from "../../src/review.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 6000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
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
const cp = (hash: string, timestamp: string, reason = "avant patch"): CheckpointInfo => ({ hash, short_hash: hash.slice(0, 8), timestamp, reason, files_changed: 1 });

describe("point de retour du tour", () => {
  const list = [cp("c3", "2026-10-25T10:00:09+00:00"), cp("c2", "2026-10-25T10:00:05+00:00"), cp("c1", "2026-10-25T09:00:00+00:00")];
  it("le plus ancien point apparu pendant le tour ; aucun : le plus récent (rien n'avait changé)", () => {
    expect(pickTurnPoint(new Set(["c1"]), list, 0)?.hash).toBe("c2");
    expect(pickTurnPoint(new Set(["c1", "c2", "c3"]), list, 0)?.hash).toBe("c3");
    expect(pickTurnPoint(new Set(), [], 0)).toBeNull();
  });
  it("liste « avant » illisible : repli sur l'heure d'envoi (à la seconde, comme git log %aI)", () => {
    expect(pickTurnPoint(null, list, Date.parse("2026-10-25T10:00:05.700Z"))?.hash).toBe("c2");
    expect(pickTurnPoint(null, list, Date.parse("2026-10-25T10:00:30Z"))?.hash).toBe("c3");
  });
  it("réponse de checkpoint_restore : succès, ou l'erreur du noyau", () => {
    expect(restoreOutcome(JSON.stringify({ success: true, restored_to: "ab", file: "a.py" }), false)).toEqual({ ok: true });
    expect(restoreOutcome(JSON.stringify({ success: false, error: "Restore failed: pathspec" }), true)).toEqual({ ok: false, error: "Restore failed: pathspec" });
    expect(restoreOutcome("points de retour indisponibles", true)).toEqual({ ok: false, error: "points de retour indisponibles" });
    expect(restoreOutcome(JSON.stringify({ success: true, file: "n.py", deleted: true, snapshot: "abcdef0123" }), false)).toEqual({ ok: true, deleted: true, snapshot: "abcdef0123" });
    expect(restoreOutcome(JSON.stringify({ success: true, file: "n.py", deleted: false }), false)).toEqual({ ok: true, deleted: false });
  });
});

describe("TurnReview : fichiers du tour", () => {
  it("deux écritures du même fichier : l'avant reste le premier ; fichier créé refusé = corbeille (geste local confirmé)", async () => {
    const trashed: string[] = [];
    const fakeHub = { listen: () => () => {} } as unknown as ConstructorParameters<typeof TurnReview>[1];
    const r = new TurnReview({} as ConstructorParameters<typeof TurnReview>[0], fakeHub, "th_x", { trashCreatedFile: async (p) => (trashed.push(p), true) });
    r.record({ path: "/w/a.py", relPath: "a.py", oldText: "v1", newText: "v2", fragment: false });
    r.record({ path: "/w/a.py", relPath: "a.py", oldText: "v2", newText: "v3", fragment: false });
    r.record({ path: "/w/new.py", relPath: "new.py", oldText: null, newText: "x", fragment: false });
    expect(r.list().map((f) => [f.relPath, f.oldText, f.newText, f.created])).toEqual([
      ["a.py", "v1", "v3", false],
      ["new.py", null, "x", true],
    ]);
    expect(await r.refuse("new.py")).toBe("restored");
    expect(trashed).toEqual(["/w/new.py"]);
    r.accept("a.py");
    expect(r.get("a.py")?.status).toBe("accepted");
    expect(await r.refuse("a.py")).toBe("accepted"); // déjà accepté : rien ne part
    expect(r.pending).toBe(0);
  });

  it("fichier modifié par l'utilisateur depuis le tour : rien ne part sans sa confirmation", async () => {
    const fakeHub = { listen: () => () => {} } as unknown as ConstructorParameters<typeof TurnReview>[1];
    const calls: string[] = [];
    const client = { callLocalTool: async (_th: string, name: string) => (calls.push(name), { content: "[]", is_error: false }) } as unknown as ConstructorParameters<typeof TurnReview>[0];
    const asked: string[] = [];
    const r = new TurnReview(client, fakeHub, "th_x", {
      trashCreatedFile: async () => false,
      read: async () => "v3 + retouche à la main",
      confirmOverwrite: async (rel) => (asked.push(rel), false),
    });
    r.record({ path: "/w/a.py", relPath: "a.py", oldText: "v1", newText: "v3", fragment: false });
    expect(await r.refuse("a.py")).toBe("pending");
    expect(asked).toEqual(["a.py"]);
    expect(r.get("a.py")!.note).toBe("Changed since the turn: not restored.");
    expect(calls).toEqual([]); // ni liste des points, ni retour
  });
});

describe("revue contre le mock (écritures réelles)", () => {
  let dir: string;
  let proj: string;
  let mock: MockServerHandle;
  const previous = process.env.NOKKER_CONFIG_DIR_OVERRIDE;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nokker-vscode-review-"));
    proj = join(dir, "projets", "calc");
    await mkdir(join(proj, "src"), { recursive: true });
    await writeFile(join(proj, "src", "app.py"), "def add(a, b):\n    return a - b\n");
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = join(dir, "config");
    mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: join(dir, "config"), localRoots: [join(dir, "projets")], localWrites: true });
  });

  afterAll(async () => {
    await mock.close();
    if (previous === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    else process.env.NOKKER_CONFIG_DIR_OVERRIDE = previous;
    await rm(dir, { recursive: true, force: true });
  });

  const api = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${mock.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${mock.localToken}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it("un tour écrit src/app.py ; refuser restaure depuis le point du tour, par une carte forte décidée au terminal", async () => {
    const posted: ToView[] = [];
    let changes = 0;
    const ctl = new ChatController(
      { post: (m) => posted.push(m), openDiff: async () => {}, reviewChanged: () => void changes++ },
      { serverUrl: mock.url, folder: proj, fs: fsReader },
    );
    expect(await ctl.connect()).toBe(true);
    const turn = ctl.send("corrige le test add");
    // Cartes du tour : pytest « une fois » depuis le panneau ; la carte forte (rm -rf build) refusée au terminal.
    const card = (await until(() => posted.find((m) => m.type === "card" && m.card.choices))) as Extract<ToView, { type: "card" }>;
    await ctl.decide(card.card.id, card.card.choices!.find((c) => c.id === "once")!.index);
    const strong = (await until(() => posted.find((m) => m.type === "card" && !m.card.choices))) as Extract<ToView, { type: "card" }>;
    await api(`/v1/local/approvals/${strong.card.id}/decide`, { decision: "reject", scope: "once" });
    await turn;
    expect(await readFile(join(proj, "src", "app.py"), "utf-8")).toBe("def add(a, b):\n    return a + b\n");

    const review = ctl.review!;
    expect(review.list().map((f) => [f.relPath, f.status, f.created])).toEqual([["src/app.py", "pending", false]]);
    expect(review.get("src/app.py")!.oldText).toBe("def add(a, b):\n    return a - b\n");
    expect(posted.filter((m) => m.type === "review").at(-1)).toEqual({ type: "review", files: 1, pending: 1 });
    const point = await review.resolvePoint();
    expect(point?.reason).toBe("avant patch");
    // Noyau du 25.10 : le point annoncé par checkpoint.created, relié au tour.
    expect(point).toMatchObject({ thread_id: ctl.threadId, turn_index: 0, tool: "patch" });
    expect(changes).toBeGreaterThan(0);

    // Refuser : carte forte du noyau, jamais décidée ici ; le panneau la montre sans bouton.
    const n = posted.length;
    expect(await review.refuse("src/app.py")).toBe("restoring");
    const f = review.get("src/app.py")!;
    expect(f.note).toBe("Strong action: decide it in the terminal (`nokker`).");
    const restoreCard = (await until(() => posted.slice(n).find((m) => m.type === "card" && m.card.tool === "checkpoint_restore"))) as Extract<ToView, { type: "card" }>;
    expect(restoreCard.card.choices).toBeNull();
    expect(restoreCard.card.id).toBe(f.approvalId);
    // Le terminal approuve : le noyau restaure, le résultat arrive dans tool.result {approval_id}.
    await api(`/v1/local/approvals/${f.approvalId}/decide`, { decision: "approve", scope: "once" });
    await until(() => review.get("src/app.py")!.status === "restored");
    expect(await readFile(join(proj, "src", "app.py"), "utf-8")).toBe("def add(a, b):\n    return a - b\n");
    expect(review.pending).toBe(0);
    ctl.dispose();
  }, 30_000);

  it("carte du retour refusée au terminal : le fichier reste, de nouveau « à revoir »", async () => {
    await writeFile(join(proj, "src", "app.py"), "def add(a, b):\n    return a - b\n");
    const posted: ToView[] = [];
    const ctl = new ChatController({ post: (m) => posted.push(m), openDiff: async () => {} }, { serverUrl: mock.url, folder: proj, fs: fsReader });
    expect(await ctl.newThread()).toBe(true);
    const decided = new Set<string>();
    let stop = false;
    const pump = (async () => {
      while (!stop) {
        const { approvals } = (await (await api("/v1/local/approvals")).json()) as { approvals: Array<{ id: string; strength: string; thread_id: string }> };
        for (const a of approvals.filter((x) => x.thread_id === ctl.threadId && !decided.has(x.id))) {
          decided.add(a.id);
          await api(`/v1/local/approvals/${a.id}/decide`, { decision: a.strength === "strong" ? "reject" : "approve", scope: "once" });
        }
        await wait(10);
      }
    })();
    await ctl.send("corrige le test add");
    stop = true;
    await pump;
    const review = ctl.review!;
    expect(await review.refuse("src/app.py")).toBe("restoring");
    const id = review.get("src/app.py")!.approvalId!;
    await api(`/v1/local/approvals/${id}/decide`, { decision: "reject", scope: "once" });
    await until(() => review.get("src/app.py")!.status === "pending");
    expect(review.get("src/app.py")!.note).toBe("Restore refused: file kept.");
    expect(await readFile(join(proj, "src", "app.py"), "utf-8")).toBe("def add(a, b):\n    return a + b\n");
    review.acceptAll();
    expect(review.get("src/app.py")!.status).toBe("accepted");
    ctl.dispose();
  }, 30_000);

  it("fichier CRÉÉ par le tour, noyau qui relie ses points : supprimé par le noyau (carte forte), copie dans le snapshot ; jamais la corbeille", async () => {
    await writeFile(join(proj, "src", "app.py"), "def add(a, b):\n    return a - b\n");
    const posted: ToView[] = [];
    const ctl = new ChatController({ post: (m) => posted.push(m), openDiff: async () => {} }, { serverUrl: mock.url, folder: proj, fs: fsReader });
    expect(await ctl.newThread()).toBe(true);
    const decided = new Set<string>();
    let stop = false;
    const pump = (async () => {
      while (!stop) {
        const { approvals } = (await (await api("/v1/local/approvals")).json()) as { approvals: Array<{ id: string; strength: string; thread_id: string }> };
        for (const a of approvals.filter((x) => x.thread_id === ctl.threadId && !decided.has(x.id))) {
          decided.add(a.id);
          await api(`/v1/local/approvals/${a.id}/decide`, { decision: a.strength === "strong" ? "reject" : "approve", scope: "once" });
        }
        await wait(10);
      }
    })();
    await ctl.send("corrige le test add");
    stop = true;
    await pump;
    const review = ctl.review!;
    // Un fichier écrit par le tour après son point (créé) : absent du point du tour.
    await writeFile(join(proj, "src", "neuf.py"), "x = 1\n");
    review.record({ path: join(proj, "src", "neuf.py"), relPath: "src/neuf.py", oldText: null, newText: "x = 1\n", fragment: false });
    expect(await review.refuse("src/neuf.py")).toBe("restoring");
    const f = review.get("src/neuf.py")!;
    expect(f.approvalId).toBeTruthy();
    await api(`/v1/local/approvals/${f.approvalId}/decide`, { decision: "approve", scope: "once" });
    await until(() => review.get("src/neuf.py")!.status === "restored");
    expect(review.get("src/neuf.py")!.note).toMatch(/^Deleted \(created by this turn\); a copy stays in restore point [0-9a-f]{8}\.$/);
    await expect(readFile(join(proj, "src", "neuf.py"), "utf-8")).rejects.toThrow();
    ctl.dispose();
  }, 30_000);
});
