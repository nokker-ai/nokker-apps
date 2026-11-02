import { afterEach, describe, expect, it } from "vitest";
import { NokkerClient, type Bubble, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot(showMe: boolean): Promise<{ client: NokkerClient; events: NokkerEvent[]; thread: string; close: () => void }> {
  const m = await startMockServer({ speed: 0.01, showMe });
  mock = m;
  const client = new NokkerClient({ baseUrl: m.url });
  await client.demoSessionMockExtension();
  const events: NokkerEvent[] = [];
  const sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 100));
  const thread = (await client.createThread("show me test")).id;
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
const pointer = (events: NokkerEvent[], thread: string): Bubble | undefined =>
  (events.filter((e) => e.type === "bubble.created" || e.type === "bubble.updated") as Array<{ bubble: Bubble }>)
    .map((e) => e.bubble)
    .filter((b) => b.kind === "pointer" && b.thread_id === thread)
    .at(-1);

describe("pointer bubble (core docs/SHOW-ME.md)", () => {
  it("flag off: no pointer bubble, and a client cannot create one", async () => {
    const { client, events, thread, close } = await boot(false);
    await client.chatCompletion(thread, [{ role: "user", content: "show me how to attach a PDF" }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(pointer(events, thread)).toBeUndefined();
    await expect(client.createBubble(thread, { kind: "pointer", title: "x", state: { target: { kind: "ui", ui: "send" }, caption: "x", step: null, steps: null, waiting: false, answer: null } })).rejects.toMatchObject({ status: 400 });
    close();
  });

  it("guide: step 1, « done » waits then step 2 in the SAME bubble, « done » on the last step closes it", async () => {
    const { client, events, thread, close } = await boot(true);
    await client.chatCompletion(thread, [{ role: "user", content: "montre-moi comment joindre un PDF" }]);
    const b1 = await until(() => pointer(events, thread));
    expect(b1.kind === "pointer" && b1.state).toMatchObject({ target: { kind: "ui", ui: "attach" }, step: 1, steps: 2, waiting: false });
    expect(b1.title).toBe("Étape 1 sur 2");
    expect(b1.actions.map((a) => a.id)).toEqual(["done", "lost"]);
    const r1 = await client.bubbleAction(b1.id, "done");
    expect(r1).toEqual({ accepted: true, thread_id: thread, closed: false });
    await until(() => events.some((e) => e.type === "bubble.updated" && e.bubble.kind === "pointer" && e.bubble.state.waiting && e.bubble.state.answer === "done"));
    const b2 = await until(() => {
      const b = pointer(events, thread);
      return b?.kind === "pointer" && b.state.step === 2 ? b : undefined;
    });
    expect(b2.id).toBe(b1.id);
    expect(b2.kind === "pointer" && b2.state).toMatchObject({ target: { kind: "ui", ui: "send" }, waiting: false, answer: null });
    const r2 = await client.bubbleAction(b1.id, "done");
    expect(r2).toMatchObject({ closed: true });
    await until(() => events.some((e) => e.type === "bubble.closed" && (e as { bubble_id: string }).bubble_id === b1.id));
    close();
  });

  it("on a screenshot: points at the last image of the thread, never another thread's", async () => {
    const { client, events, thread, close } = await boot(true);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await client.chatCompletion(thread, [{ role: "user", content: [{ type: "text", text: "here is my screen" }, { type: "image_url", image_url: { url: png } }] }]);
    const other = (await client.createThread("other")).id;
    await client.chatCompletion(other, [{ role: "user", content: "show me on the screenshot" }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(pointer(events, other)).toBeUndefined();
    await client.chatCompletion(thread, [{ role: "user", content: "show me where on the screenshot" }]);
    const b = await until(() => pointer(events, thread));
    expect(b.kind === "pointer" && b.state.target).toMatchObject({ kind: "image", media_type: "image/png", x: 72, y: 18 });
    const sha = b.kind === "pointer" && b.state.target.kind === "image" ? b.state.target.sha256 : "";
    const blob = await client.getThreadImage(thread, sha);
    expect(blob.size).toBeGreaterThan(0);
    close();
  });
});
