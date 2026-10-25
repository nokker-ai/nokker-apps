/**
 * Session de code locale : CLI ↔ mock-server réel (jeton local, suite d'outils, cartes locales, annulation,
 * mode non interactif, flux d'appareil `pending`). Sans rendu Ink (voir integration.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerApiError, NokkerClient, type Approval, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "@nokker-apps/mock-server";
import { connect, login } from "../src/auth.js";
import { CliSession } from "../src/session.js";
import { applyToolEvent, formatToolLine, type ToolLine } from "../src/toolview.js";
import { runPrint } from "../src/headless.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: délai dépassé");
    await wait(10);
  }
}
/** Un tour complet : répond à chaque carte avec `answer`, renvoie le texte et les cartes vues. */
async function drive(s: CliSession, text: string, answer: (c: Approval) => Promise<unknown>): Promise<{ text: string; cards: Approval[] }> {
  const th = s.threadId;
  const all = (): Approval[] => (events.filter((e) => e.type === "approval.requested") as Array<{ approval: Approval }>).map((e) => e.approval);
  const before = new Set(all().map((c) => c.id));
  const cards: Approval[] = [];
  let done = false;
  const turn = s.sendMessage(text, () => {}).finally(() => (done = true));
  while (!done) {
    const ev = all().find((a) => a.thread_id === th && !before.has(a.id) && !cards.some((x) => x.id === a.id));
    if (ev) {
      const c = (await s.listLocalApprovals()).find((a) => a.id === ev.id) ?? ev; // suggested_rules : GET /v1/local/approvals
      cards.push(c);
      await answer(c);
    }
    await wait(5);
  }
  return { text: await turn, cards };
}
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

let dir: string;
let mock: MockServerHandle;
let client: NokkerClient;
let session: CliSession;
let events: NokkerEvent[];
let sub: { close(): void };
const previousOverride = process.env.NOKKER_CONFIG_DIR_OVERRIDE;

const cardOf = (thread: string): Approval | undefined =>
  (events.filter((e) => e.type === "approval.requested") as Array<{ approval: Approval }>)
    .map((e) => e.approval)
    .find((a) => a.thread_id === thread && a.status === "pending");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-cli-local-"));
  process.env.NOKKER_CONFIG_DIR_OVERRIDE = dir;
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, localRoots: ["/work"] });
  client = new NokkerClient({ baseUrl: mock.url });
  const conn = await connect(client, mock.url, "test");
  expect(conn.mode).toBe("local");
  session = new CliSession(client, conn.identity, undefined, conn.user);
  events = [];
  sub = session.subscribeEvents({ onEvent: (e) => events.push(e) });
  await wait(100);
});

afterAll(async () => {
  sub.close();
  await mock.close();
  if (previousOverride === undefined) delete process.env.NOKKER_CONFIG_DIR_OVERRIDE;
  else process.env.NOKKER_CONFIG_DIR_OVERRIDE = previousOverride;
  await rm(dir, { recursive: true, force: true });
});

describe("jeton local", () => {
  it("connecte sans enrôlement d'appareil (aucune clé créée)", async () => {
    expect(await exists(join(dir, "device-key.json"))).toBe(false);
    expect(await exists(join(dir, "session.json"))).toBe(false);
    expect((await client.listThreads()).length).toBeGreaterThanOrEqual(0);
  });

  it("un jeton local faux est refusé, la connexion bascule sur le flux d'appareil", async () => {
    const other = await mkdtemp(join(tmpdir(), "nokker-cli-badtoken-"));
    const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = other;
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(other, "local-token"), "faux\n");
      const c = new NokkerClient({ baseUrl: mock.url });
      const conn = await connect(c, mock.url, "test-dev");
      expect(conn.mode).toBe("device");
      expect(conn.identity?.deviceId).toMatch(/^dev_/);
    } finally {
      process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("session locale", () => {
  it("crée la session du dossier, puis la reprend", async () => {
    const first = await session.openLocal("/work/projet-a");
    expect(first.resumed).toBe(false);
    const id = session.threadId;
    expect(id).toMatch(/^th_/);
    const s2 = new CliSession(client, null);
    const again = await s2.openLocal("/work/projet-a");
    expect(again.resumed).toBe(true);
    expect(s2.threadId).toBe(id);
    expect((await session.listLocalSessions()).some((s) => s.thread_id === id && s.title === "projet-a")).toBe(true);
  });

  it("403 hors racines", async () => {
    const s3 = new CliSession(client, null);
    await expect(s3.openLocal("/etc")).rejects.toMatchObject({ status: 403 });
  });

  it("suite d'outils reliée par call_id : patch sans carte, cartes sur pytest puis rm -rf build", async () => {
    await session.openLocal("/work/suite");
    const th = session.threadId;
    const reply = await drive(session, "corrige le test add", (c) => session.decideLocal(c.id, "approve", "once"));
    expect(reply.text).toContain("corrigé");
    expect(reply.cards.map((c) => [c.tool_name, c.effect])).toEqual([["terminal", "write"], ["terminal", "destructive"]]);
    let lines: ToolLine[] = [];
    for (const e of events) if ((e.type === "tool.call" || e.type === "tool.result") && e.thread_id === th) lines = applyToolEvent(lines, e);
    expect(lines.map((l) => l.ok)).toEqual([true, true, true, true, true]);
    expect(formatToolLine(lines[2]!)).toMatch(/^✓ patch src\/app\.py \d+ ms$/);
    expect(formatToolLine(lines[4]!)).toMatch(/^✓ terminal rm -rf build \d+ ms$/);
  });

  it("ne renvoie que le dernier message utilisateur", async () => {
    const bodies: string[] = [];
    const spy = new NokkerClient({
      baseUrl: mock.url,
      token: mock.localToken!,
      fetchImpl: (async (url: string, init: { body?: string }) => {
        if (url.endsWith("/v1/chat/completions")) bodies.push(String(init.body));
        return fetch(url, init as RequestInit) as never;
      }) as never,
    });
    const s = new CliSession(spy, null);
    await s.openLocal("/work/dernier");
    await s.sendMessage("bonjour", () => {});
    await s.sendMessage("encore", () => {});
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(JSON.parse(b).messages).toHaveLength(1);
  });

  it("scope session, puis always (settings.json, rule ∈ suggested_rules), puis plus de carte pytest", async () => {
    await session.openLocal("/work/regles");
    const first = await drive(session, "corrige le test add", (c) => session.decideLocal(c.id, "approve", c.strength === "standard" ? "session" : "once"));
    expect(first.cards).toHaveLength(2);
    const second = await drive(session, "corrige le test add", (c) => session.decideLocal(c.id, "approve", "once"));
    expect(second.cards.map((c) => c.effect)).toEqual(["destructive"]); // même fil : pytest couvert, le destructif jamais

    const s2 = new CliSession(client, null);
    await s2.openLocal("/work/regles-2");
    const c2 = await drive(s2, "corrige le test add", (c) =>
      c.suggested_rules?.length ? s2.decideLocal(c.id, "approve", "always", c.suggested_rules[1]) : s2.decideLocal(c.id, "approve", "once"),
    );
    expect(c2.cards[0]!.suggested_rules![0]).toBe("terminal(pytest -q tests/test_add.py)");
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["terminal(pytest -q*)"]);

    const s3 = new CliSession(client, null);
    await s3.openLocal("/work/regles-3");
    const c3 = await drive(s3, "corrige le test add", (c) => s3.decideLocal(c.id, "approve", "once"));
    expect(c3.cards.map((c) => c.effect)).toEqual(["destructive"]);
  });

  it("hardline : refus direct sans carte, ligne d'outil en refus", async () => {
    await session.openLocal("/work/hard");
    const th = session.threadId;
    const r = await drive(session, "fais rm -rf /", () => Promise.reject(new Error("aucune carte attendue")));
    expect(r.cards).toHaveLength(0);
    let lines: ToolLine[] = [];
    for (const e of events) if ((e.type === "tool.call" || e.type === "tool.result") && e.thread_id === th) lines = applyToolEvent(lines, e);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ok).toBe(false);
    expect(lines[0]!.preview).toBe("refusé : commande interdite (hardline)");
    expect(formatToolLine(lines[0]!).startsWith("✗ terminal rm -rf /")).toBe(true);
  });

  it("annulation : Échap = POST cancel (202), le flux se termine, turn.done cancelled", async () => {
    await session.openLocal("/work/annule");
    const th = session.threadId;
    const t = session.sendMessage("corrige le test add", () => {});
    await until(() => cardOf(th));
    expect(await session.cancel()).toBe(true);
    await t;
    const done = await until(() => events.filter((e) => e.type === "turn.done" && e.thread_id === th).at(-1));
    expect((done as { cancelled?: boolean }).cancelled).toBe(true);
    expect(await session.cancel()).toBe(false);
  });

  it("carte strong : la CLI ne signe plus avec sa clé logicielle", async () => {
    const strong = { strength: "strong", id: "appr_x", status: "pending" } as Approval;
    const withKey = new CliSession(client, { deviceId: "dev_x", privateKey: {} as never, publicKeySpkiB64Url: "" });
    await expect(withKey.decideByDevice(strong, "approve")).rejects.toThrow(/strong/);
  });
});

describe("mode non interactif", () => {
  it("refuse par défaut tout effet sans règle et le dit dans le résultat", async () => {
    const d2 = await mkdtemp(join(tmpdir(), "nokker-cli-print-"));
    const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = d2;
    const m2 = await startMockServer({ port: 0, seed: false, speed: 0.01, localRoots: null });
    try {
      const c = new NokkerClient({ baseUrl: m2.url });
      const conn = await connect(c, m2.url, "batch");
      const res = await runPrint("corrige le test add", c, conn, "/work/ci");
      expect(res.cwd).toBe("/work/ci");
      expect(res.refused.map((r) => [r.tool, r.effect, r.target])).toEqual([
        ["terminal", "write", "pytest -q tests/test_add.py"],
        ["terminal", "destructive", "rm -rf build"],
      ]);
      expect(res.reply).toContain("refusée");
      expect(res.pending_approvals).toEqual([]);
      expect(res.cancelled).toBe(false);
      // X2 : le coût du tour recopié de `turn.cost` (LOKKAL.md §7.6).
      expect(res.cost).toMatchObject({ thread_id: res.thread_id, calls: 1, subagent_calls: 0, unpriced_models: [] });
      expect(Object.keys(res.cost!.cost)).toEqual(["EUR"]);
      expect(res.cost!.total_tokens).toBe(res.cost!.input_tokens + res.cost!.output_tokens);
      expect(JSON.parse(JSON.stringify(res)).cost.type).toBeUndefined();
    } finally {
      await m2.close();
      process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
      await rm(d2, { recursive: true, force: true });
    }
  });
});

describe("flux d'appareil", () => {
  it("pending : affiche le code, envoie user, attend la confirmation TOTP", async () => {
    const d3 = await mkdtemp(join(tmpdir(), "nokker-cli-pending-"));
    const keep = process.env.NOKKER_CONFIG_DIR_OVERRIDE;
    process.env.NOKKER_CONFIG_DIR_OVERRIDE = d3;
    const m3 = await startMockServer({ port: 0, seed: false, devicePending: true, configDir: null });
    try {
      const c = new NokkerClient({ baseUrl: m3.url });
      let code = "";
      let declaredUser = "";
      const tokenP = login(c, "pending-dev", {
        user: "alice",
        pollMs: 20,
        onPending: (d) => {
          code = d.code;
          declaredUser = d.user;
          // confirmation par TOTP, comme /confirm
          void c.confirmDevice(d.id, { totp: "000000", user: "alice" });
        },
      });
      const token = await tokenP;
      expect(code).toMatch(/^[0-9a-z]{6}$/);
      expect(declaredUser).toBe("alice");
      expect(token.token).toBeTruthy();
    } finally {
      await m3.close();
      process.env.NOKKER_CONFIG_DIR_OVERRIDE = keep;
      await rm(d3, { recursive: true, force: true });
    }
  });
});
