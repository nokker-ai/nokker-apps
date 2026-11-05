import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
import { startCast } from "../src/cast.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
});
afterEach(async () => {
  await mock.close();
  delete process.env.MOCK_CAST_FRAME;
});

describe("cadre de l'aperçu cast (p2/cast-frame)", () => {
  it("URL signée de 2 min ; page servie avec sa propre CSP ; signature fausse refusée ; noyau d'avant = 404", async () => {
    const b = startCast(mock.state, "th_demo");
    const castId = (b.state as { cast_id: string }).cast_id;
    const r = await c.castFrameUrl(castId);
    expect(r.url).toMatch(new RegExp(`^/v1/cast/${castId}/frame\\?exp=\\d+&sig=`));
    expect(Date.parse(r.expires_at) - Date.now()).toBeLessThanOrEqual(120_000);
    const page = await fetch(`${mock.url}${r.url}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    expect(await page.text()).toMatch(/<table/);
    expect((await fetch(`${mock.url}${r.url.replace(/sig=[^&]+/, "sig=faux")}`)).status).toBe(403);
    expect(((await c.castFrameUrl("cast_inconnu").catch((e) => e)) as NokkerApiError).status).toBe(404);
    process.env.MOCK_CAST_FRAME = "0";
    expect(((await c.castFrameUrl(castId).catch((e) => e)) as NokkerApiError).status).toBe(404);
  });
});
