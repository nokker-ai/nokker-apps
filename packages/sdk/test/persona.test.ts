import { describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "../src/client.js";
import type { FetchLike, RequestInitLike } from "../src/events.js";
import { isTimedSpeech } from "../src/persona.js";

interface Seen {
  url: string;
  init: RequestInitLike;
}

function fake(status: number, payload: unknown): { client: NokkerClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, init });
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return {
      ok: status >= 200 && status < 300,
      status,
      body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    };
  };
  return { client: new NokkerClient({ baseUrl: "http://srv/", token: "tok", fetchImpl }), seen };
}

const SPEECH = { audio: "AAAA", mime: "audio/mpeg", words: ["Hello", "Alice"], wtimes: [0, 400], wdurations: [350, 500] };

describe("persona — routes", () => {
  it("catalogue et persona : GET avec le jeton", async () => {
    const { client, seen } = fake(200, { voices: [], avatars: [], name: { min: 1, max: 24 }, defaults: { name: "Alice", voice_id: "v1", avatar: { id: "a", version: 1 } } });
    const cat = await client.getPersonaCatalog();
    expect(cat.name.max).toBe(24);
    await client.getPersona();
    expect(seen.map((s) => s.url)).toEqual(["http://srv/v1/persona/catalog", "http://srv/v1/persona"]);
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("PUT n'envoie que les champs donnés ; 400 garde le code", async () => {
    const ok = fake(200, { name: "Bob", voice_id: "v1", avatar: { id: "a", version: 1 }, defaulted: false });
    await ok.client.putPersona({ name: "Bob" });
    expect(ok.seen[0]!.init.method).toBe("PUT");
    expect(JSON.parse(ok.seen[0]!.init.body as string)).toEqual({ name: "Bob" });
    const bad = fake(400, { error: { code: "bad_voice" } });
    const err = await bad.client.putPersona({ voice_id: "nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NokkerApiError);
    expect((err as NokkerApiError).status).toBe(400);
    expect((err as NokkerApiError).body).toEqual({ error: { code: "bad_voice" } });
  });

  it("aperçu et parole horodatée : POST aux bons chemins", async () => {
    const { client, seen } = fake(200, SPEECH);
    expect(isTimedSpeech(await client.previewPersona({ voice_id: "v1", lang: "fr" }))).toBe(true);
    await client.timedSpeech("t/1", 3, { lang: "en" });
    await client.timedSpeech("t2", 0);
    expect(seen[0]).toMatchObject({ url: "http://srv/v1/persona/preview", init: { method: "POST" } });
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ voice_id: "v1", lang: "fr" });
    expect(seen[1]!.url).toBe("http://srv/v1/threads/t%2F1/messages/3/speech/timed");
    expect(JSON.parse(seen[1]!.init.body as string)).toEqual({ lang: "en" });
    expect(JSON.parse(seen[2]!.init.body as string)).toEqual({});
  });

  it("isTimedSpeech refuse des listes de longueurs différentes ou un autre format", () => {
    expect(isTimedSpeech(SPEECH)).toBe(true);
    expect(isTimedSpeech({ ...SPEECH, wtimes: [0] })).toBe(false);
    expect(isTimedSpeech({ ...SPEECH, mime: "audio/wav" })).toBe(false);
    expect(isTimedSpeech({ ...SPEECH, audio: "" })).toBe(false);
    expect(isTimedSpeech({ ...SPEECH, wdurations: [1, Number.NaN] })).toBe(false);
    expect(isTimedSpeech(null)).toBe(false);
  });
});
