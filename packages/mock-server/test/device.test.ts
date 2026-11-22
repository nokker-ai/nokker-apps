import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, type DeviceRequestEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock.close();
});
const code = (e: unknown): unknown => ((e as NokkerApiError).body as { error?: { code?: string } })?.error?.code;

describe("données du téléphone à la demande (P8)", () => {
  it("capacités ; device.request sur le flux ; premier qui répond ; 409 ensuite ; refus ; hors ligne", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const dev = (body: object) =>
      fetch(`${mock.url}/v1/dev/device-request`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await dev({ op: "calendar.list" })).toEqual({ error: "device_unavailable" });
    await c.putDeviceCaps("dev_1", { name: "iPhone", platform: "ios", caps: ["calendar.read", "bogus" as never] });
    expect((await c.getDeviceCaps("dev_1")).caps).toEqual(["calendar.read"]);
    const seen: DeviceRequestEvent[] = [];
    let mode: "answer" | "deny" | "silent" = "answer";
    const sub = c.subscribeEvents({
      onEvent: (e) => {
        if (e.type !== "device.request") return;
        seen.push(e);
        if (mode === "silent") return;
        void (async () => {
          if (mode === "deny") return c.answerDeviceRequest(e.request_id, { device_id: "dev_1", error: "denied" });
          await c.answerDeviceRequest(e.request_id, { device_id: "dev_1", items: [{ title: "Dentiste", start: "2026-11-07T09:00:00Z", end: "2026-11-07T09:30:00Z", all_day: false, calendar: "Perso" }] });
          expect(code(await c.answerDeviceRequest(e.request_id, { device_id: "dev_1", items: [] }).catch((x) => x))).toBe("already_answered");
        })();
      },
      onError: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 300));
    const r = await dev({ op: "calendar.list", args: { from: "2026-11-07T00:00:00Z", to: "2026-11-08T00:00:00Z" }, timeout_ms: 3000 });
    expect(r.items).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "calendar.list", args: { from: "2026-11-07T00:00:00Z" } });
    mode = "deny";
    expect((await dev({ op: "calendar.list", timeout_ms: 3000 })).error).toBe("device_denied");
    mode = "silent";
    const off = await dev({ op: "calendar.list", timeout_ms: 300 });
    expect(off.error).toBe("device_offline");
    expect(code(await c.answerDeviceRequest(off.request_id, { device_id: "dev_1", items: [] }).catch((x) => x))).toBe("expired");
    expect((await dev({ op: "contacts.search", args: { q: "a" } })).error).toBe("device_unavailable");
    sub.close();
  });
});
