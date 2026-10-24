import { describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "../src/client.js";
import type { FetchLike, RequestInitLike } from "../src/events.js";

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
  return { client: new NokkerClient({ baseUrl: "http://srv/", fetchImpl }), seen };
}

describe("onboarding — routes publiques", () => {
  it("getInvitation encode le jeton et n'envoie aucun Authorization", async () => {
    const { client, seen } = fake(200, { valid: true, lang: "fr", prenom: "Léa" });
    expect(await client.getInvitation("a+b/c=")).toEqual({ valid: true, lang: "fr", prenom: "Léa" });
    expect(seen[0]!.url).toBe("http://srv/v1/onboarding/invitation?t=a%2Bb%2Fc%3D");
    expect(seen[0]!.init.headers?.Authorization).toBeUndefined();
  });

  it("getTerms passe la langue", async () => {
    const { client, seen } = fake(200, { lang: "en", sha256: "ab", text: "t" });
    await client.getTerms("en");
    expect(seen[0]!.url).toBe("http://srv/v1/onboarding/terms?lang=en");
  });

  it("acceptInvitation POST le corps exact du contrat", async () => {
    const { client, seen } = fake(201, { account_id: "us_1", device_id: "dev_1", lang: "fr" });
    const out = await client.acceptInvitation({ token: "t", terms_sha256: "ab", public_key_spki: "k", name: "web" });
    expect(out.device_id).toBe("dev_1");
    expect(seen[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ token: "t", terms_sha256: "ab", public_key_spki: "k", name: "web" });
  });

  it("une erreur {error: code} remonte en NokkerApiError avec le corps", async () => {
    const { client } = fake(410, { error: "invalid_token" });
    const err = await client.acceptInvitation({ token: "t", terms_sha256: "a", public_key_spki: "k", name: "n" }).catch((e) => e);
    expect(err).toBeInstanceOf(NokkerApiError);
    expect(err.status).toBe(410);
    expect(err.body).toEqual({ error: "invalid_token" });
  });
});

describe("connecteurs et appairage Telegram", () => {
  it("liste, relie, teste, révoque : méthodes et chemins", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      const bytes = new TextEncoder().encode("{}");
      return { ok: true, status: 200, body: { async *[Symbol.asyncIterator]() { yield bytes; } } };
    };
    const c = new NokkerClient({ baseUrl: "http://srv", token: "tok", fetchImpl });
    await c.listConnectors();
    await c.putConnector("mail", { settings: { preset: "gmail", address: "a@gmail.com" }, secret: "x" });
    await c.testConnector("calendar");
    await c.deleteConnector("mail");
    await c.createTelegramPairing();
    expect(calls).toEqual([
      "GET http://srv/v1/connectors",
      "PUT http://srv/v1/connectors/mail",
      "POST http://srv/v1/connectors/calendar/test",
      "DELETE http://srv/v1/connectors/mail",
      "POST http://srv/v1/telegram/pairing",
    ]);
  });

  it("putConnector envoie settings + secret et pose le jeton de session", async () => {
    const { client, seen } = fake(200, { kind: "mail", state: "ok" });
    client.setToken("tok");
    await client.putConnector("mail", { settings: { preset: "gmail", address: "a@gmail.com" }, secret: "pw" });
    expect(seen[0]!.init.headers?.Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ settings: { preset: "gmail", address: "a@gmail.com" }, secret: "pw" });
  });
});
