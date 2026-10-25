import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerClient, type NokkerEvent, type TurnCostEvent } from "@nokker-apps/sdk";
import { costBook, MOCK_PREFIX_TOKENS, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let dir: string;
let client: NokkerClient;
let events: NokkerEvent[];
let sub: { close(): void };

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-cost-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir, localRoots: ["/work"] });
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

async function turn(thread: string, text: string): Promise<void> {
  await client.streamChatCompletion(thread, [{ role: "user", content: text }], () => {});
}
const costsOf = (thread: string): TurnCostEvent[] => events.filter((e): e is TurnCostEvent => e.type === "turn.cost" && e.thread_id === thread);

describe("coût par tour (mock)", () => {
  it("publie turn.cost juste avant turn.done, en EUR, avec les jetons du tour", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/cost" })).thread_id;
    await turn(th, "bonjour");
    for (let i = 0; i < 200 && costsOf(th).length === 0; i++) await wait(10);
    const [cost] = costsOf(th);
    expect(cost).toBeDefined();
    expect(cost!.input_tokens).toBe(MOCK_PREFIX_TOKENS + "bonjour".length);
    expect(cost!.total_tokens).toBe(cost!.input_tokens + cost!.output_tokens);
    expect(Object.keys(cost!.cost)).toEqual(["EUR"]);
    expect(cost!.unpriced_models).toEqual([]);
    expect(cost!.models[0]).toMatchObject({ model: "Qwen3.5-397B-A17B", price_source: "catalog" });
    const types = events.filter((e) => "thread_id" in e && e.thread_id === th).map((e) => e.type);
    expect(types.indexOf("turn.cost")).toBeLessThan(types.indexOf("turn.done"));
  });

  it("modèle hors grille : jetons seulement, jamais un prix inventé", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/cost2" })).thread_id;
    costBook(mock.state).model = "acme/inconnu";
    try {
      await turn(th, "salut");
      for (let i = 0; i < 200 && costsOf(th).length === 0; i++) await wait(10);
      const [cost] = costsOf(th);
      expect(cost!.cost).toEqual({});
      expect(cost!.unpriced_models).toEqual(["acme/inconnu"]);
      expect(cost!.models[0]!.cost).toBeNull();
    } finally {
      costBook(mock.state).model = "Qwen3.5-397B-A17B";
    }
  });

  it("GET /v1/local/cost : session et jour, jeton local exigé, jour invalide refusé", async () => {
    const th = (await client.createLocalSession({ cwd: "/work/cost3" })).thread_id;
    await turn(th, "un");
    await turn(th, "deux");
    for (let i = 0; i < 200 && costsOf(th).length < 2; i++) await wait(10);
    const totals = await client.getLocalCost(th);
    expect(totals.session).toMatchObject({ thread_id: th, turns: 2, calls: 2 });
    expect(totals.session!.total_tokens).toBe(costsOf(th).reduce((s, c) => s + c.total_tokens, 0));
    expect(totals.day.date).toBe(new Date().toISOString().slice(0, 10));
    expect(totals.day.calls).toBeGreaterThanOrEqual(3);
    expect((await client.getLocalCost()).session).toBeNull();
    expect((await client.getLocalCost(undefined, "2020-01-01")).day).toMatchObject({ calls: 0, cost: {} });
    await expect(client.getLocalCost(th, "hier")).rejects.toMatchObject({ status: 400 });
    const r = await fetch(`${mock.url}/v1/local/cost`);
    expect(r.status).toBe(401);
  });
});
