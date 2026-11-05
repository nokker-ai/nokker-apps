import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, generateDeviceKeyPair, signChallenge, type NokkerEvent } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function boot(payAgent: "off" | "wise" | "wise-linked", payments = true) {
  const m = await startMockServer({ speed: 0.01, payments, payAgent, configDir: null });
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
const person = { first_name: "Alice", last_name: "Example", date_of_birth: "1990-01-31", address_line: "Rue Exemple 1", city: "Genève", country_iso3: "che", email: "alice@example.com", phone: "+41790000000" };
const fakeProof = (challenge: string) => ({ challenge, device_id: "dev", client_data_json: "e30", authenticator_data: "AA", signature: "AA" });

describe("mock payment agent, issuer wise (PAY-AGENT §10)", () => {
  it("is absent without the flag", async () => {
    const { client, close } = await boot("off");
    expect(await status(client.getPayMethod())).toBe(404);
    close();
  });
  it("opens the Wise account, sends to Wise's verification, then activates with a passkey proof", async () => {
    const { client, close } = await boot("wise");
    expect(await client.getPayMethod()).toMatchObject({ issuer: "wise", link: null, method: null });
    expect(await status(client.startPayLink({ ...person, phone: "079" }))).toBe(400);
    expect((await client.startPayLink(person)).link?.state).toBe("WAITING_CUSTOMER_INPUT");
    const { url } = await client.payLinkUrl();
    expect(url).toMatch(/wise=kyc&status=success/);
    await new Promise((r) => setTimeout(r, 1700));
    expect((await client.getPayMethod()).link?.state).toBe("PASSED");
    const ch = await client.payMethodChallenge("wise:1");
    expect(ch.payment_method).toBe("wise:29751964"); // the core names the account it opened, not the web's
    expect(await status(client.putPayMethod("wise:1", fakeProof(ch.challenge), "Alice"))).toBe(403);
    expect((await client.putPayMethod(ch.payment_method!, fakeProof(ch.challenge), "Alice Example")).method).toMatchObject({ issuer: "wise" });
    expect((await client.payBalance()).balances[0]).toEqual({ currency: "CHF", amount_minor: 18450 });
    close();
  });
  it("« simule 3ds »: a signed card paid by the agent, a confirmation to answer, then paid", async () => {
    const { client, events, close } = await boot("wise-linked");
    const t = await client.createThread("3ds");
    await client.chatCompletion(t.id, [{ role: "user", content: "simule 3ds" }]);
    const ev = await (async () => {
      for (let i = 0; i < 200; i++) {
        const e = events.find((x) => x.type === "payment.agent");
        if (e) return e as Extract<NokkerEvent, { type: "payment.agent" }>;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("no payment.agent");
    })();
    expect(ev.agent.threeds?.amount_minor).toBe(4290);
    const p = await client.getThreeDS(ev.mandate_id);
    expect(JSON.parse(p.challenge)).toMatchObject({ aud: "nokker-3ds", amount_minor: 4290, merchant: "BOUTIQUE DU LAC" });
    expect(await status(client.answerThreeDS(ev.mandate_id, p.challenge_id, { proof: fakeProof("{}") }))).toBe(403);
    const card = await client.answerThreeDS(ev.mandate_id, p.challenge_id, { proof: fakeProof(p.challenge) });
    expect((card.agent as { status: string }).status).toBe("active");
    expect(await status(client.getThreeDS(ev.mandate_id))).toBe(404);
    close();
  });
  it("a refusal answers the bank and nothing waits any more", async () => {
    const { client, events, close } = await boot("wise-linked");
    const t = await client.createThread("3ds");
    await client.chatCompletion(t.id, [{ role: "user", content: "simulate 3ds" }]);
    for (let i = 0; i < 200 && !events.some((x) => x.type === "payment.agent"); i++) await new Promise((r) => setTimeout(r, 20));
    const mid = (events.find((x) => x.type === "payment.agent") as { mandate_id: string }).mandate_id;
    const p = await client.getThreeDS(mid);
    await client.answerThreeDS(mid, p.challenge_id, { decline: true });
    const list = await client.listPayCards();
    expect(list.mandates.find((m) => m.mandate_id === mid)?.agent?.threeds).toBeUndefined();
    close();
  });
});
