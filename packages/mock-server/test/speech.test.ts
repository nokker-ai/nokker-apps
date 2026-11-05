import { afterEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});
const boot = async (tts: boolean) => {
  mock = await startMockServer({ speed: 0.01, seed: false, tts });
  const c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
  return c;
};

describe("lecture à voix haute d'une réponse (contrat p2/tts-stream)", () => {
  it("éteinte : pas de capacité (404 → null), la route répond 503 tts_off", async () => {
    const c = await boot(false);
    expect(await c.getSpeechCapability()).toBeNull();
    const t = await c.createThread("t");
    await expect(c.speechStream(t.id, 0)).rejects.toMatchObject({ status: 503, body: { error: { code: "tts_off" } } });
  });

  it("allumée : MP3 en flux pour la réponse d'un tour ; 404 sans tour, 409 sans réponse, 413 trop longue", async () => {
    const c = await boot(true);
    expect(await c.getSpeechCapability()).toEqual({ available: true, max_chars: 4000, format: "audio/mpeg" });
    const t = await c.createThread("t");
    mock!.state.appendTurn(t.id, "bonjour", "Bonjour, je suis Nina.", { silent: true });
    mock!.state.appendTurn(t.id, "", "", { silent: true });
    mock!.state.appendTurn(t.id, "long", "x".repeat(4001), { silent: true });
    const res = await c.speechStream(t.id, 0, { lang: "fr" });
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(String.fromCharCode(...bytes.slice(0, 3))).toBe("ID3");
    await expect(c.speechStream(t.id, 9)).rejects.toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    await expect(c.speechStream(t.id, 1)).rejects.toMatchObject({ status: 409, body: { error: { code: "not_a_reply" } } });
    await expect(c.speechStream(t.id, 2)).rejects.toMatchObject({ status: 413, body: { error: { code: "too_long" } } });
  });
});
