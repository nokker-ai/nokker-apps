import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot(opts: { guide?: boolean; showMe?: boolean }): Promise<NokkerClient> {
  mock = await startMockServer({ speed: 0.01, ...opts });
  const client = new NokkerClient({ baseUrl: mock.url });
  await client.demoSessionMockExtension();
  return client;
}

describe("Guide mock (core docs/GUIDE.md)", () => {
  it("flag off (default): the three routes are 404", async () => {
    const c = await boot({});
    await expect(c.getGuide()).rejects.toMatchObject({ status: 404 });
    await expect(c.guideIntroSeen()).rejects.toMatchObject({ status: 404 });
    await expect(c.guideAsk("hello")).rejects.toMatchObject({ status: 404 });
  });

  it("GET: one feature at least in each status, codes only, ui only with show_me", async () => {
    const c = await boot({ guide: true, showMe: true });
    const g = await c.getGuide();
    expect(new Set(g.features.map((f) => f.status))).toEqual(new Set(["on", "setup", "off", "not_for_you"]));
    expect(g.show_me).toBe(true);
    expect(g.intro.picks.length).toBeLessThanOrEqual(3);
    expect(g.features.find((f) => f.id === "images")?.ui).toBe("attach");
    for (const f of g.features.filter((x) => x.status === "off" || x.status === "not_for_you")) expect(f).not.toHaveProperty("screen");
    expect(g.next).toBe("images");
    const quiet = await boot({ guide: true, showMe: false });
    expect((await quiet.getGuide()).features.every((f) => f.ui === undefined)).toBe(true);
  });

  it("intro: seen turns true", async () => {
    const c = await boot({ guide: true });
    expect((await c.getGuide()).intro.seen).toBe(false);
    expect(await c.guideIntroSeen()).toEqual({ seen: true });
    expect((await c.getGuide()).intro.seen).toBe(true);
  });

  it("ask: deterministic reply citing ids with ui and screen, a point; errors 400 / 429 / 503", async () => {
    const c = await boot({ guide: true, showMe: true });
    const a = await c.guideAsk("comment joindre une photo ?", [{ role: "user", content: "salut" }]);
    expect(a.features.map((f) => f.id)).toEqual(["images"]);
    expect(a.point).toEqual({ ui: "attach", feature: "images" });
    const d = await c.guideAsk("que sais-tu faire ?");
    expect(d.features.map((f) => f.id)).toEqual(["crew", "images"]);
    expect(d.features[0]).toMatchObject({ screen: "crew" });
    expect(await c.guideAsk("que sais-tu faire ?")).toEqual(d);
    const code = async (t: string): Promise<number> => ((await c.guideAsk(t).catch((e: unknown) => e)) as NokkerApiError).status;
    expect(await code("  ")).toBe(400);
    expect(await code("quota")).toBe(429);
    expect(await code("nomodel")).toBe(503);
  });
});
