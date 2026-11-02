import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, type Bubble, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot(cast: boolean): Promise<{ client: NokkerClient; events: NokkerEvent[]; thread: string; close: () => void }> {
  const m = await startMockServer({ speed: 0.01, cast });
  mock = m;
  const client = new NokkerClient({ baseUrl: m.url });
  await client.demoSessionMockExtension();
  const events: NokkerEvent[] = [];
  const sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 100));
  const thread = (await client.createThread("cast test")).id;
  return { client, events, thread, close: () => sub.close() };
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
const castBubble = (events: NokkerEvent[], thread: string): Bubble | undefined =>
  (events.filter((e) => e.type === "bubble.created") as Array<{ bubble: Bubble }>).map((e) => e.bubble).find((b) => b.kind === "cast" && b.thread_id === thread);

describe("cast bubble (SCREEN-CAST §7)", () => {
  it("flag off: no cast bubble", async () => {
    const { client, events, thread, close } = await boot(false);
    await client.chatCompletion(thread, [{ role: "user", content: "show it on the TV" }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(castBubble(events, thread)).toBeUndefined();
    close();
  });

  it("first screen asks for a go; approve shows, stop ends; the answer never carries the html", async () => {
    const { client, events, thread, close } = await boot(true);
    await client.chatCompletion(thread, [{ role: "user", content: "show it on the TV" }]);
    const b = await until(() => castBubble(events, thread));
    if (b.kind !== "cast") throw new Error("not a cast bubble");
    expect(b.status).toBe("idle");
    expect(b.state).toMatchObject({ status: "pending", request: { reason: "new_screen" }, html_too_large: false });
    expect(b.state.html).toContain("<!doctype html>");
    expect(b.state.actions.map((a) => a.id)).toEqual(["approve", "refuse"]);
    expect(JSON.stringify(b.state)).not.toMatch(/https?:\/\/|token|192\.168/); // no link, token or address of the screen

    const shown = (await client.bubbleAction(b.id, "approve")) as unknown as { cast: Record<string, unknown> };
    expect(shown.cast).toMatchObject({ status: "showing", bubble_status: "working", request: null });
    expect("html" in shown.cast).toBe(false);
    const stopped = (await client.bubbleAction(b.id, "stop")) as unknown as { cast: Record<string, unknown> };
    expect(stopped.cast).toMatchObject({ status: "stopped", bubble_status: "done", actions: [] });
    await expect(client.bubbleAction(b.id, "stop")).rejects.toBeInstanceOf(NokkerApiError);
    close();
  });

  it("refuse ends the request without showing anything", async () => {
    const { client, events, thread, close } = await boot(true);
    await client.chatCompletion(thread, [{ role: "user", content: "à l'écran s'il te plaît" }]);
    const b = await until(() => castBubble(events, thread));
    const out = (await client.bubbleAction(b.id, "refuse")) as unknown as { cast: Record<string, unknown> };
    expect(out.cast).toMatchObject({ status: "refused", bubble_status: "failed" });
    close();
  });
});
