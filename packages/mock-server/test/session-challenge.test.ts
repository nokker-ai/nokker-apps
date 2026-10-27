import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, generateDeviceKeyPair } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock?.close();
});

const refusal = async (p: Promise<unknown>): Promise<{ status: number; error: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof NokkerApiError) return { status: e.status, error: (e.body as { error: Record<string, unknown> }).error };
  }
  throw new Error("refus attendu");
};

describe("défi de session : codes stables du noyau (0309091)", () => {
  it("appareil inconnu : 404 device_unknown ; appareil en attente : 400 device_not_approved + device_status", async () => {
    mock = await startMockServer({ speed: 0.01, configDir: null, devicePending: true });
    const c = new NokkerClient({ baseUrl: mock.url });
    expect(await refusal(c.requestSessionChallenge("dev_inconnu"))).toMatchObject({ status: 404, error: { code: "device_unknown" } });
    const keys = await generateDeviceKeyPair();
    const dev = await c.enrollDevice({ name: "test", public_key_spki: keys.publicKeySpkiB64Url, user: "alice" });
    expect(dev.status).toBe("pending");
    expect(await refusal(c.requestSessionChallenge(dev.id))).toMatchObject({ status: 400, error: { code: "device_not_approved", device_status: "pending" } });
  });
});
