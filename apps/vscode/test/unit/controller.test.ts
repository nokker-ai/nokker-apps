/**
 * Logique du panneau contre le vrai mock-server : connexion par le jeton local (au même endroit que la CLI), session du
 * dossier, tour complet (outils, diff du patch, carte d'approbation, carte forte : terminal ou téléphone selon qu'elle
 * est partie chez nokker.ai, coût), sélection, annulation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { resolveTokenPath } from "@nokker-apps/cli/src/lokkal.js";
import { ChatController, imageMentions, type StoredDiff } from "../../src/controller.js";
import { readLocalToken, resolveServerUrl, tokenPath } from "../../src/connection.js";
import type { ToView } from "../../src/protocol.js";

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

let dir: string;
let proj: string;
let mock: MockServerHandle;
const previous = process.env.NOKKER_CONFIG_DIR_OVERRIDE;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-vscode-"));
  proj = join(dir, "projets", "calc");
  await mkdir(join(proj, "src"), { recursive: true });
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

describe("jeton et serveur : mêmes fichiers que la CLI", () => {
  it("le jeton est lu là où la CLI le lit (lokkal.json token_path, sinon local-token)", async () => {
    expect(tokenPath()).toBe(resolveTokenPath());
    expect(tokenPath()).toBe(join(dir, "config", "local-token"));
    const t = await readLocalToken(mock.url);
    expect(t).toEqual({ token: mock.localToken });
  });

  it("jamais de jeton local vers un serveur distant", async () => {
    const t = await readLocalToken("https://example.org");
    expect("error" in t && t.error).toMatch(/pas un noyau local/);
  });

  it("serveur : réglage > NOKKER_SERVER_URL > lokkal.json > défaut", async () => {
    expect(resolveServerUrl("http://127.0.0.1:9", {}).url).toBe("http://127.0.0.1:9");
    expect(resolveServerUrl("", { NOKKER_SERVER_URL: "http://127.0.0.1:7" }).url).toBe("http://127.0.0.1:7");
    expect(resolveServerUrl(undefined, {})).toEqual({ url: "http://127.0.0.1:8742", source: "défaut" });
    await writeFile(
      join(dir, "config", "lokkal.json"),
      JSON.stringify({ compose: "/x/c.yml", project: "nokker", version: "0.1.0", core_service: "core", api_url: "http://127.0.0.1:18742", web_url: "http://127.0.0.1:7420", token_path: join(dir, "config", "local-token"), env_file: "/x/.env" }),
    );
    expect(resolveServerUrl(undefined, {})).toEqual({ url: "http://127.0.0.1:18742", source: "lokkal.json" });
    await rm(join(dir, "config", "lokkal.json"));
  });
});

describe("ChatController contre le mock", () => {
  const posted: ToView[] = [];
  const opened: StoredDiff[] = [];
  let ctl: ChatController;

  it("se connecte sur la session du dossier", async () => {
    ctl = new ChatController(
      { post: (m) => posted.push(m), openDiff: async (d) => void opened.push(d) },
      { serverUrl: mock.url, folder: proj, fs: fsReader },
    );
    expect(await ctl.connect()).toBe(true);
    expect(ctl.threadId).toMatch(/^th_/);
    const st = posted.filter((m) => m.type === "state").pop() as Extract<ToView, { type: "state" }>;
    expect(st).toMatchObject({ connected: true, folder: proj, error: null });
  });

  it("un tour : outils, diff natif, carte (bouton), carte forte = terminal (machine non liée), ligne de coût", async () => {
    ctl.addSelection({ relPath: "src/app.py", startLine: 1, endLine: 2, languageId: "python", text: "def add(a, b):\n    return a + b" });
    const turn = ctl.send("corrige le test add");
    const card = (await until(() => posted.find((m) => m.type === "card" && m.card.choices))) as Extract<ToView, { type: "card" }>;
    expect(card.card.tool).toBe("terminal");
    expect(card.card.choices!.map((c) => c.label)[0]).toBe("Pour cette session");
    await ctl.decide(card.card.id, card.card.choices![0]!.index);
    // Un second clic sur la même carte n'envoie rien.
    await ctl.decide(card.card.id, card.card.choices![0]!.index);
    const strong = (await until(() => posted.find((m) => m.type === "card" && m.card.choices === null))) as Extract<ToView, { type: "card" }>;
    expect(strong.card.choices).toBeNull(); // pas de bouton
    // Machine non liée (défaut du mock) : la carte ne part pas au téléphone, elle se décide au terminal.
    expect(strong.card).toMatchObject({ forwarded: false, strongText: "Action forte : à décider dans le terminal (`nokker`)." });
    // Le terminal refuse.
    await fetch(`${mock.url}/v1/local/approvals/${strong.card.id}/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mock.localToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject", scope: "once" }),
    });
    await turn;

    const user = posted.find((m) => m.type === "user") as Extract<ToView, { type: "user" }>;
    expect(user.context).toEqual(["src/app.py:1-2"]);
    const closed = posted.filter((m) => m.type === "cardClosed").map((m) => (m as { status: string }).status);
    expect(closed).toEqual(["approved", "rejected"]);
    const tools = posted.filter((m) => m.type === "tool").map((m) => (m as Extract<ToView, { type: "tool" }>).tool);
    const patch = tools.find((t) => t.name === "patch" && t.status === "completed")!;
    expect(patch.target).toBe("src/app.py");
    expect(patch.diffs).toHaveLength(1);
    await ctl.openDiff(patch.diffs[0]!.id);
    expect(opened[0]).toMatchObject({ relPath: "src/app.py", oldText: "def add(a, b):\n    return a - b\n", newText: "def add(a, b):\n    return a + b\n", fragment: false });
    expect(tools.find((t) => t.name === "terminal" && t.status === "in_progress")?.effect).toBe("écriture");
    const cost = posted.find((m) => m.type === "cost") as Extract<ToView, { type: "cost" }>;
    expect(cost.line).toMatch(/jetons · .*€/);
    const reply = posted.filter((m) => m.type === "text").map((m) => (m as { append: string }).append).join("");
    expect(reply.trim()).toBe("J'ai corrigé `src/app.py` (add retournait a - b) et le test add passe. Je n'ai pas nettoyé `build/` : suppression refusée.");
    expect(posted.find((m) => m.type === "turnEnd")).toEqual({ type: "turnEnd", stopReason: "end_turn" });
  }, 20_000);

  it("noyau réel : carte « en attente », décision, tour de suite ; le panneau reste occupé jusqu'au bout", async () => {
    mock.state.approvalStyle = "kernel";
    try {
      expect(await ctl.newThread()).toBe(true); // fil neuf : la règle « pour cette session » du test précédent ne joue plus
      const n = posted.length;
      const turn = ctl.send("corrige le test add");
      const card = (await until(() => posted.slice(n).find((m) => m.type === "card" && m.card.choices))) as Extract<ToView, { type: "card" }>;
      expect(ctl.busy).toBe(true);
      await ctl.decide(card.card.id, card.card.choices!.find((c) => c.label === "Une fois")!.index);
      const strong = (await until(() => posted.slice(n).find((m) => m.type === "card" && !m.card.choices))) as Extract<ToView, { type: "card" }>;
      expect(ctl.busy).toBe(true);
      await fetch(`${mock.url}/v1/local/approvals/${strong.card.id}/decide`, {
        method: "POST",
        headers: { Authorization: `Bearer ${mock.localToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "reject", scope: "once" }),
      });
      await turn;
      const txt = posted.slice(n).filter((m) => m.type === "text").map((m) => (m as { append: string }).append).join("");
      expect(txt).toContain("attend ton approbation");
      // Un refus ne lance pas de tour de suite (`continuation: "none"`) : la demande et la suite de l'approbation.
      expect(txt).not.toContain("refusée");
      expect(posted.slice(n).filter((m) => m.type === "cost")).toHaveLength(2);
      // L'appel approuvé se ferme sur le `tool.result` de l'exécuteur, avec la vraie sortie de l'outil.
      const tools = posted.slice(n).filter((m) => m.type === "tool").map((m) => (m as Extract<ToView, { type: "tool" }>).tool);
      const pytest = tools.filter((t) => t.target.startsWith("pytest"));
      expect(pytest.at(-1)).toMatchObject({ status: "completed" });
      expect(pytest.at(-1)!.preview).toContain("1 passed");
      expect(tools.filter((t) => t.target === "rm -rf build").at(-1)).toMatchObject({ status: "failed" });
      expect(ctl.busy).toBe(false);
    } finally {
      mock.state.approvalStyle = "inline";
    }
  }, 20_000);

  it("machine liée : la carte forte montrée « au terminal » passe à « attend ton téléphone » quand elle est déposée", async () => {
    mock.state.strongRelay = true;
    mock.state.strongRelayMs = 30_000; // ×0.01 : le dépôt arrive après que le panneau a montré la carte
    try {
      expect(await ctl.newThread()).toBe(true);
      const n = posted.length;
      const turn = ctl.send("corrige le test add");
      const card = (await until(() => posted.slice(n).find((m) => m.type === "card" && m.card.choices))) as Extract<ToView, { type: "card" }>;
      await ctl.decide(card.card.id, card.card.choices![0]!.index);
      const strongCards = () => posted.slice(n).filter((m) => m.type === "card" && !m.card.choices) as Array<Extract<ToView, { type: "card" }>>;
      await until(() => strongCards().length >= 2);
      const [first, second] = strongCards();
      expect(first!.card).toMatchObject({ forwarded: false, strongText: "Action forte : à décider dans le terminal (`nokker`)." });
      expect(second!.card).toMatchObject({ id: first!.card.id, forwarded: true, strongText: "Action forte : elle attend ton téléphone." });
      await fetch(`${mock.url}/v1/local/approvals/${first!.card.id}/decide`, {
        method: "POST",
        headers: { Authorization: `Bearer ${mock.localToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "reject", scope: "once" }),
      });
      await turn;
      expect(strongCards()).toHaveLength(2);
    } finally {
      mock.state.strongRelay = false;
      mock.state.strongRelayMs = 300;
    }
  }, 20_000);

  it("le panneau rechargé rejoue le fil affiché", () => {
    const before = posted.length;
    ctl.replay();
    const again = posted.slice(before);
    expect(again.filter((m) => m.type === "tool").length).toBeGreaterThan(0);
    expect(again.some((m) => m.type === "state")).toBe(true);
  });

  it("Arrêter : POST /cancel, le tour se ferme « cancelled »", async () => {
    const n = posted.length;
    const turn = ctl.send("corrige le test add");
    await until(() => posted.slice(n).find((m) => m.type === "card"));
    await ctl.cancel();
    await turn;
    expect(posted.slice(n).find((m) => m.type === "turnEnd")).toEqual({ type: "turnEnd", stopReason: "cancelled" });
  }, 20_000);

  it("nouveau fil : autre thread_id, même dossier", async () => {
    const before = ctl.threadId;
    expect(await ctl.newThread()).toBe(true);
    expect(ctl.threadId).not.toBe(before);
    ctl.dispose();
  });

  it("dossier hors des racines : message clair", async () => {
    const out: ToView[] = [];
    const c = new ChatController({ post: (m) => out.push(m), openDiff: async () => {} }, { serverUrl: mock.url, folder: join(dir, "ailleurs"), fs: fsReader });
    expect(await c.connect()).toBe(false);
    expect((out.filter((m) => m.type === "state").pop() as { error: string }).error).toMatch(/hors des racines/);
  });
});

describe("images citées", () => {
  it("@capture.png → pièce jointe par chemin, jamais hors du dossier", () => {
    expect(imageMentions("regarde @capture.png et @docs/a.webp, pas @../x.png ni mail@x.png")).toEqual([{ path: "capture.png" }, { path: "docs/a.webp" }]);
  });
});
