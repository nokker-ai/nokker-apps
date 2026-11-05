import { afterEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  delete process.env.MOCK_TERMS_OUTDATED;
});

describe("réacceptation des conditions (noyau p2/tts-stream : terms_outdated, /v1/terms, /v1/account/terms)", () => {
  it("conditions à jour : rien à réaccepter", async () => {
    mock = await startMockServer({ speed: 0.01, seed: false });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const a = await c.getAccount();
    const cur = await c.getCurrentTerms("fr");
    expect(a.terms_outdated).toBe(false);
    expect(a.terms_current).toEqual({ version: cur.version, lang: "fr" });
  });

  it("MOCK_TERMS_OUTDATED=1 : périmée ; une version périmée → 409 stale_version ; la courante → plus rien à faire", async () => {
    process.env.MOCK_TERMS_OUTDATED = "1";
    mock = await startMockServer({ speed: 0.01, seed: false });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    expect((await c.getAccount()).terms_outdated).toBe(true);
    await expect(c.acceptCurrentTerms("0".repeat(64))).rejects.toMatchObject({ status: 409 });
    const en = await c.getCurrentTerms("en");
    const out = await c.acceptCurrentTerms(en.version);
    expect(out).toMatchObject({ terms: { version: en.version, lang: "en" }, terms_outdated: false, terms_current: { lang: "en" } });
    expect((await c.getAccount()).terms_outdated).toBe(false);
  });
});
