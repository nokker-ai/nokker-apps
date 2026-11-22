import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NokkerClient, type Bubble, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot(screens: boolean) {
  const m = await startMockServer({ speed: 0.01, screens, configDir: mkdtempSync(join(tmpdir(), "nokker-screens-")) });
  mock = m;
  const client = new NokkerClient({ baseUrl: m.url });
  await client.demoSessionMockExtension();
  const events: NokkerEvent[] = [];
  const sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 100));
  const thread = (await client.createThread("wall screen test")).id;
  return { client, events, thread, close: () => sub.close(), url: m.url };
}
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const screenBubble = (events: NokkerEvent[], thread: string): Bubble | undefined =>
  (events.filter((e) => e.type === "bubble.created") as Array<{ bubble: Bubble }>).map((e) => e.bubble).find((b) => b.kind === "screen" && b.thread_id === thread);

describe("screen bubble (core docs/SCREENS.md, V7)", () => {
  it("flag off: no screen bubble, no screen in the wall view", async () => {
    const { client, events, thread, close } = await boot(false);
    await client.chatCompletion(thread, [{ role: "user", content: "make me a screen for the wall" }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(screenBubble(events, thread)).toBeUndefined();
    close();
  });

  it("preview → publish lays a strong card → approved, the wall reads the screen; unpublish removes it", async () => {
    const { client, events, thread, close, url } = await boot(true);
    // 2 readings a minute per token (like the core): one paired wall per reading.
    const read = async () => {
      const offer = await client.pairGlance("Kitchen wall", "wall");
      const claim = await new NokkerClient({ baseUrl: url }).claimGlance(offer.code);
      const wall = new NokkerClient({ baseUrl: url });
      wall.setToken(claim.token);
      return wall.getGlance();
    };
    expect((await read()).screen).toBeNull();

    await client.chatCompletion(thread, [{ role: "user", content: "make me a screen for the wall" }]);
    const b = await until(() => screenBubble(events, thread));
    if (b.kind !== "screen") throw new Error("not a screen bubble");
    expect(b.state).toMatchObject({ status: "draft", version: 1, html_too_large: false });
    expect(b.state.html).toMatch(/Content-Security-Policy" content="default-src &#x27;none&#x27;/);
    expect(b.state.html).not.toMatch(/<script|https?:\/\//);
    expect(b.state.actions.map((a) => a.id)).toEqual(["publish"]);

    const pending = (await client.bubbleAction(b.id, "publish")) as unknown as { screen: Record<string, unknown> };
    expect(pending.screen).toMatchObject({ status: "pending", actions: [] });
    expect("html" in pending.screen).toBe(false);
    const card = (await client.listApprovals()).find((a) => a.tool_name === "wall_publish");
    expect(card).toMatchObject({ rule: "wall:publish", strength: "strong", status: "pending" });
    expect((await read()).screen).toBeNull(); // nothing on the wall before the card

    const r = await fetch(`${url}/v1/dev/screens/approve`, { method: "POST", headers: { Authorization: `Bearer ${mock!.localToken}` } });
    expect(r.status).toBe(200);
    const view = await read();
    expect(view.screen).toMatchObject({ title: "Kitchen", version: 1 });
    expect(view.screen?.html).toContain("Prochain rendez-vous");
    // the frame served by the core: own CSP, sandbox without scripts; the preview too, through frame-url
    const fr = await fetch(`${url}${view.screen!.frame_url}`);
    expect(fr.status).toBe(200);
    expect(fr.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'; style-src 'sha256-/);
    expect(await fr.text()).toBe(view.screen!.html);
    const pv = await client.screenFrameUrl(b.state.screen_id);
    expect((await fetch(`${url}${pv.url}`)).status).toBe(200);
    expect((await fetch(`${url}${pv.url.replace("sig=", "sig=0")}`)).status).toBe(404);

    const removed = (await client.bubbleAction(b.id, "unpublish")) as unknown as { screen: Record<string, unknown> };
    expect(removed.screen).toMatchObject({ status: "draft" });
    close();
  });
});
