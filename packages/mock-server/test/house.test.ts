import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, addressedAgent, type HouseAgent, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
const saved = process.env.MOCK_HOUSEHOLD;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  if (saved === undefined) delete process.env.MOCK_HOUSEHOLD;
  else process.env.MOCK_HOUSEHOLD = saved;
});

async function boot(houseRoom: boolean): Promise<NokkerClient> {
  const m = await startMockServer({ speed: 0.01, houseRoom, configDir: null });
  mock = m;
  const c = new NokkerClient({ baseUrl: m.url });
  await c.demoSessionMockExtension();
  return c;
}
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } }).error?.code };
  }
};

describe("« Maison » room (HOUSE-ROOM §6)", () => {
  it("flag off: 404", async () => {
    const c = await boot(false);
    expect((await status(c.getHouse())).status).toBe(404);
  });

  it("view, latest messages, a post answered later by the addressed agent (working → reply → idle)", async () => {
    const c = await boot(true);
    const v = await c.getHouse();
    expect(v.me).toMatchObject({ profile: "adult", payer: true, right: "strong" });
    expect(v.agents.map((a) => a.slug)).toEqual(["intendant", "maison", "courrier", "veille", "agenda", "memoire"]);
    const page = await c.listHouseMessages();
    expect(page.messages.some((m) => m.kind === "event" && m.event === "memory.report")).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/@example\.|alice|bob/); // members are anonymised labels

    const events: NokkerEvent[] = [];
    const sub = c.subscribeEvents({ onEvent: (e) => events.push(e) });
    await new Promise((r) => setTimeout(r, 100));
    const out = await c.postHouseMessage("@agenda what about Friday?");
    expect(out).toMatchObject({ reply: null, agent: "agenda", message: { kind: "member", mine: true } });
    const t0 = Date.now();
    while (!events.some((e) => e.type === "house.agent" && e.state === "idle") && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 20));
    sub.close();
    const order = events.filter((e) => e.type === "house.agent" || e.type === "house.message").map((e) => (e.type === "house.agent" ? `agent:${e.state}` : `msg:${e.message.kind}`));
    expect(order).toEqual(["msg:member", "agent:working", "msg:agent", "agent:idle"]);
    const after = await c.listHouseMessages({ after: out.message.id });
    expect(after.messages.map((m) => [m.kind, m.agent, m.reply_to])).toEqual([["agent", "agenda", out.message.id]]);
  });

  it("bad text, rate, and a minor never sees the adults' agent or messages", async () => {
    const c = await boot(true);
    expect(await status(c.postHouseMessage("   "))).toEqual({ status: 400, code: "bad_text" });
    for (let i = 0; i < 30; i++) await c.postHouseMessage(`hello ${i}`);
    expect(await status(c.postHouseMessage("one more"))).toEqual({ status: 429, code: "rate" });

    await mock!.close();
    process.env.MOCK_HOUSEHOLD = "minor";
    const kid = await boot(true);
    const v = await kid.getHouse();
    expect(v.me.profile).not.toBe("adult");
    expect(v.agents.some((a) => a.slug === "courrier")).toBe(false);
    expect((await kid.listHouseMessages()).messages.some((m) => m.audience === "adults")).toBe(false);
    expect(await status(kid.postHouseMessage("@courrier read my mail"))).toEqual({ status: 403, code: "agent_forbidden" });
  });

  it("addressedAgent: first known mention, accents and case ignored, else the default", () => {
    const a = (slug: string, name: string, def = false): HouseAgent => ({ slug, name, role: "", tier: "", available: true, may_address: true, default: def, audience: "all" });
    const agents = [a("intendant", "Intendant", true), a("memoire", "Mémoire"), a("veille", "Veille")];
    expect(addressedAgent("@Mémoire remember this", agents)?.slug).toBe("memoire");
    expect(addressedAgent("hey @nobody and @veille", agents)?.slug).toBe("veille");
    expect(addressedAgent("no mention", agents)?.slug).toBe("intendant");
  });
});
