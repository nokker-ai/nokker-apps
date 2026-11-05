import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01, seed: false, payments: true, configDir: null });
  c = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
});
afterEach(async () => {
  await mock.close();
});

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");
const post = async (path: string, body: unknown) => (await fetch(`${mock.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

/** A passkey as an authenticator would use it: P-256 key, assertion on SHA-256(challenge + "." + decision). */
function passkey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = b64u(Buffer.from("cred-alice-1"));
  const assert = (challenge: string, decision: string) => {
    const digest = createHash("sha256").update(`${challenge}.${decision}`).digest();
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64u(digest), origin: "http://localhost:5173" }));
    const authData = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), privateKey);
    return { client_data_json: b64u(clientData), authenticator_data: b64u(authData), signature: b64u(signature) };
  };
  return { credentialId, spki: b64u(publicKey.export({ type: "spki", format: "der" })), assert };
}

describe("« ta carte » sur Lokkal : décision par la passkey locale (PAY-AGENT §11)", () => {
  it("défi puis décision signée : carte approuvée, mandat scellé ; une seconde décision = 409 not_pending", async () => {
    const { approval_id } = await post("/v1/dev/owncard-card", {});
    const listed = (await c.listLocalApprovals()).find((a) => a.id === approval_id)!;
    expect(listed).toMatchObject({ local_passkey: true, forwarded: false, rule: "payments:to_pay" });
    await expect(c.localApprovalChallenge(approval_id)).rejects.toMatchObject({ status: 412, body: { error: { code: "no_passkey" } } });
    const pk = passkey();
    const { device_id } = await post("/v1/dev/local-passkey", { credential_id: pk.credentialId, public_key_spki: pk.spki });
    expect((await c.listLocalPasskeys()).passkeys).toEqual([expect.objectContaining({ device_id, credential_id: pk.credentialId })]);
    const ch = await c.localApprovalChallenge(approval_id);
    expect(ch).toMatchObject({ rp_id: "localhost", allow_credentials: [pk.credentialId] });
    expect(JSON.parse(ch.challenge).mandate_sha256).toBeTruthy();
    // Wrong decision signed (reject signed, approve sent): refused, the nonce stays usable.
    await expect(c.decideLocalWithPasskey(approval_id, { decision: "approve", device_id, challenge: ch.challenge, webauthn: pk.assert(ch.challenge, "reject") })).rejects.toMatchObject({ status: 403, body: { error: { code: "proof_invalid" } } });
    const a = await c.decideLocalWithPasskey(approval_id, { decision: "approve", device_id, challenge: ch.challenge, webauthn: pk.assert(ch.challenge, "approve") });
    expect(a).toMatchObject({ status: "approved", decided_via: "webauthn" });
    await expect(c.localApprovalChallenge(approval_id)).rejects.toMatchObject({ status: 409, body: { error: { code: "not_pending" } } });
  });

  it("une carte à payer qui n'est pas own_card ne se signe jamais en local (409 not_local)", async () => {
    const { approval_id } = await post("/v1/dev/owncard-card", { own_card: false });
    expect((await c.listLocalApprovals()).find((a) => a.id === approval_id)?.local_passkey).toBeUndefined();
    await expect(c.localApprovalChallenge(approval_id)).rejects.toMatchObject({ status: 409, body: { error: { code: "not_local" } } });
  });
});
