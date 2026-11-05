import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, generateDeviceKeyPair, signChallenge, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
import { localPasskeys } from "../src/owncard.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot() {
  const m = await startMockServer({ speed: 0.01, payments: true, payAgent: "own_card", configDir: null });
  mock = m;
  const client = new NokkerClient({ baseUrl: m.url });
  const keys = await generateDeviceKeyPair();
  const dev = await client.enrollDevice({ name: "test", public_key_spki: keys.publicKeySpkiB64Url });
  const { challenge } = await client.requestSessionChallenge(dev.id);
  await client.createSession({ device_id: dev.id, challenge, signature: await signChallenge(keys.privateKey, challenge, "login") });
  const events: NokkerEvent[] = [];
  const sub = client.subscribeEvents({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 100));
  return { client, events, close: () => sub.close() };
}
const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof NokkerApiError) return e.status;
    throw e;
  }
};
const until = async <T>(f: () => T | undefined, ms = 4000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("mock « ta carte » (own_card, PAY-AGENT §11)", () => {
  it("keeps only brand, last four and expiry of the card", async () => {
    const { client, close } = await boot();
    expect((await client.getPayMethod()).issuer).toBe("own_card");
    expect(await status(client.putOwnCard({ number: "4242424242424241", exp_month: 12, exp_year: 2031, holder: "Alice" }))).toBe(400);
    const { method } = await client.putOwnCard({ number: "4242 4242 4242 4242", exp_month: 12, exp_year: 2031, holder: "Alice" });
    expect(method).toMatchObject({ brand: "visa", last4: "4242", cvv_kept: false });
    expect(JSON.stringify(await client.getPayMethod())).not.toMatch(/4242424242424242/);
    expect((await client.ownCardCvvMode(true, "123")).cvv_kept).toBe(true);
    close();
  });
  it("registers a passkey of this machine (single-use challenge) into the shared array", async () => {
    const { client, close } = await boot();
    expect((await client.listLocalPasskeys()).passkeys).toEqual([]);
    const o = await client.localPasskeyOptions();
    expect(o.rp_id).toBe("localhost");
    const cdj = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: "http://localhost:7420" })).toString("base64url");
    const reg = { challenge: o.challenge, credential_id: "cred-1", public_key_spki: "AA", public_key_alg: -7, client_data_json: cdj };
    const p = await client.registerLocalPasskey(reg);
    expect(localPasskeys.map((x) => x.device_id)).toEqual([p.device_id]);
    expect(await status(client.registerLocalPasskey(reg))).toBe(403); // défi déjà utilisé
    await client.deleteLocalPasskey(p.device_id);
    expect(localPasskeys).toEqual([]);
    close();
  });
  it("« simule ta carte »: security code, then the bank's code, then paid; nothing asked → 404", async () => {
    const { client, events, close } = await boot();
    await client.putOwnCard({ number: "4242424242424242", exp_month: 12, exp_year: 2031, holder: "Alice" });
    const t = await client.createThread("own");
    await client.chatCompletion(t.id, [{ role: "user", content: "simule ta carte" }]);
    const ask = (kind: string) => until(() => events.find((e) => e.type === "payment.agent" && (e as { agent: { prompt?: { kind: string } } }).agent.prompt?.kind === kind) as { mandate_id: string } | undefined);
    const mid = (await ask("cvv")).mandate_id;
    expect(await status(client.providePaymentValue(mid, "otp", "123456"))).toBe(404); // pas demandé
    await client.providePaymentValue(mid, "cvv", "123");
    await ask("otp");
    await client.providePaymentValue(mid, "otp", "123456");
    await until(() => events.find((e) => e.type === "payment.agent" && (e as { agent: { used?: boolean } }).agent.used));
    expect(JSON.stringify(events)).not.toMatch(/123456|"123"/); // jamais une valeur dans un événement
    close();
  });
});
