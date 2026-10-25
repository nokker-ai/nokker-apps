import { describe, expect, it } from "vitest";
import { NokkerClient } from "../src/client.js";
import type { FetchLike, RequestInitLike } from "../src/events.js";

function fake(payload: unknown): { client: NokkerClient; seen: Array<{ url: string; init: RequestInitLike }> } {
  const seen: Array<{ url: string; init: RequestInitLike }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, init });
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield bytes; } } };
  };
  return { client: new NokkerClient({ baseUrl: "http://127.0.0.1:8787/", fetchImpl }), seen };
}

describe("Lokkal — routes /v1/local/*", () => {
  it("getLocalSetup, testLocalModel, putLocalModels, finishLocalSetup : méthode, chemin, corps", async () => {
    const { client, seen } = fake({});
    await client.getLocalSetup();
    await client.testLocalModel({ base_url: "https://api.exemple.test", api_key: "k" });
    await client.putLocalModels({ default: "router", byok: [{ name: "a", base_url: "https://x.test", model: "m", ok: true }] });
    await client.finishLocalSetup();
    expect(seen.map((s) => [s.init.method ?? "GET", s.url])).toEqual([
      ["GET", "http://127.0.0.1:8787/v1/local/setup"],
      ["POST", "http://127.0.0.1:8787/v1/local/setup/models/test"],
      ["PUT", "http://127.0.0.1:8787/v1/local/setup/models"],
      ["POST", "http://127.0.0.1:8787/v1/local/setup/done"],
    ]);
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ base_url: "https://api.exemple.test", api_key: "k" });
    expect(JSON.parse(String(seen[2]!.init.body))).toEqual({ default: "router", byok: [{ name: "a", base_url: "https://x.test", model: "m", ok: true }] });
  });

  it("flux d'appareil : start en POST, status en GET", async () => {
    const { client, seen } = fake({});
    await client.startLocalLink();
    await client.getLocalLinkStatus();
    await client.unlinkLocal();
    expect(seen.map((s) => [s.init.method ?? "GET", s.url])).toEqual([
      ["POST", "http://127.0.0.1:8787/v1/local/link/start"],
      ["GET", "http://127.0.0.1:8787/v1/local/link/status"],
      ["DELETE", "http://127.0.0.1:8787/v1/local/link"],
    ]);
  });
});
