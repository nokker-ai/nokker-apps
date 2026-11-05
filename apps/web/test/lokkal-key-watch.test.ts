import { describe, expect, it } from "vitest";
import type { FetchLike } from "@nokker-apps/sdk";
import { bearerOf, localKeyRefused, onUnauthorized, watchingFetch } from "../src/lokkal/keyWatch.js";

const answer = (status: number): FetchLike => (async () => ({ status, ok: status < 400 }) as never) as FetchLike;
const core = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

describe("local key refused during a session", () => {
  it("each 401 is reported with the bearer that caused it; other answers are not", async () => {
    const seen: string[] = [];
    const stop = onUnauthorized((b) => seen.push(b));
    await watchingFetch(answer(200))("/v1/threads", { headers: { Authorization: "Bearer k1" } });
    await watchingFetch(answer(403))("/v1/threads", { headers: { Authorization: "Bearer k1" } });
    await watchingFetch(answer(401))("/v1/threads", { headers: { Authorization: "Bearer k1" } });
    await watchingFetch(answer(401))("/v1/threads", { headers: {} }); // no bearer: nothing to forget
    stop();
    await watchingFetch(answer(401))("/v1/threads", { headers: { Authorization: "Bearer k2" } });
    expect(seen).toEqual(["k1"]);
  });

  it("reads the bearer whatever the header case", () => {
    expect(bearerOf({ headers: { authorization: "Bearer abc" } })).toBe("abc");
    expect(bearerOf({ headers: { Authorization: "Basic abc" } })).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });

  it("forgotten only when the core refuses the key itself (a wrong TOTP code or an unreachable core keeps the session)", async () => {
    expect(await localKeyRefused("", "k1", core(401))).toBe(true);
    expect(await localKeyRefused("", "k1", core(200))).toBe(false);
    const down = (async () => {
      throw new TypeError("refused");
    }) as unknown as typeof fetch;
    expect(await localKeyRefused("", "k1", down)).toBe(false);
  });
});
