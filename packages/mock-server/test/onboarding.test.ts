import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, generateDeviceKeyPair, signChallenge } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
});
afterEach(async () => {
  await mock.close();
});

const code = (e: unknown): unknown => (e as NokkerApiError).body;

async function accepted(c: NokkerClient, token = "demo"): Promise<void> {
  const terms = await c.getTerms("fr");
  const keys = await generateDeviceKeyPair();
  const r = await c.acceptInvitation({ token, terms_sha256: terms.sha256, public_key_spki: keys.publicKeySpkiB64Url, name: "test" });
  const { challenge } = await c.requestSessionChallenge(r.device_id);
  await c.createSession({ device_id: r.device_id, challenge, signature: await signChallenge(keys.privateKey, challenge, "login") });
}

describe("invitation → compte → conditions", () => {
  it("jeton de démo valide, inconnu invalide, puis consommé après acceptation", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    expect(await c.getInvitation("demo")).toEqual({ valid: true, lang: "fr", prenom: "Camille" });
    expect(await c.getInvitation("nimporte")).toEqual({ valid: false });
    await accepted(c);
    expect(await c.getInvitation("demo")).toEqual({ valid: false });
  });

  it("conditions périmées : 409 terms_mismatch sans consommer le jeton", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    const keys = await generateDeviceKeyPair();
    const err = await c.acceptInvitation({ token: "demo", terms_sha256: "00", public_key_spki: keys.publicKeySpkiB64Url, name: "x" }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(code(err)).toEqual({ error: "terms_mismatch" });
    expect((await c.getInvitation("demo")).valid).toBe(true);
  });

  it("jeton déjà utilisé : 410 invalid_token", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    await accepted(c);
    const keys = await generateDeviceKeyPair();
    const t = await c.getTerms("fr");
    const err = await new NokkerClient({ baseUrl: mock.url })
      .acceptInvitation({ token: "demo", terms_sha256: t.sha256, public_key_spki: keys.publicKeySpkiB64Url, name: "x" })
      .catch((e) => e);
    expect(err.status).toBe(410);
  });

  it("les conditions existent en fr et en, avec des empreintes différentes", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    const [fr, en] = [await c.getTerms("fr"), await c.getTerms("en")];
    expect(fr.sha256).not.toBe(en.sha256);
    expect(en.lang).toBe("en");
  });
});

describe("connecteurs et Telegram", () => {
  it("exigent une session", async () => {
    const err = await new NokkerClient({ baseUrl: mock.url }).listConnectors().catch((e) => e);
    expect(err.status).toBe(401);
  });

  it("relier, tester, révoquer — le secret ne ressort jamais", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    await accepted(c);
    expect((await c.listConnectors()).connectors.map((x) => x.state)).toEqual(["absent", "absent"]);
    const card = await c.putConnector("mail", { settings: { preset: "gmail", address: "a@gmail.com" }, secret: "app-pass-SECRET" });
    expect(card.state).toBe("ok");
    expect(JSON.stringify(await c.listConnectors())).not.toContain("SECRET");
    expect(await c.testConnector("mail")).toMatchObject({ ok: true });
    expect(await c.deleteConnector("mail")).toEqual({ revoked: true });
    expect((await c.testConnector("mail").catch((e) => e)).status).toBe(404);
  });

  it("refus par code : auth_failed, host_blocked, port_not_allowed, unreachable", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    await accepted(c);
    const mail = { preset: "gmail", address: "a@gmail.com" };
    const put = async (settings: object, secret: string) => (await c.putConnector("mail", { settings: settings as never, secret }).catch((e) => e)).body;
    expect(await put(mail, "mauvais")).toMatchObject({ error: "auth_failed" });
    const custom = { preset: "custom", address: "a@x.org", imap_host: "imap.x.org", imap_port: 993, smtp_host: "smtp.x.org", smtp_port: 587 };
    expect(await put({ ...custom, imap_host: "localhost" }, "pw")).toMatchObject({ error: "host_blocked" });
    expect(await put({ ...custom, imap_port: 25 }, "pw")).toMatchObject({ error: "port_not_allowed" });
    expect(await put({ ...custom, imap_host: "down.example" }, "pw")).toMatchObject({ error: "unreachable" });
    expect((await c.listConnectors()).connectors[0]!.state).toBe("absent");
  });

  it("appairage Telegram : code, lien t.me, expiration future", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    await accepted(c);
    const p = await c.createTelegramPairing();
    expect(p.link).toContain(p.code);
    expect(Date.parse(p.expires_at)).toBeGreaterThan(Date.now());
  });
});

describe("connexion par code mail", () => {
  it("start répond pareil pour toute adresse ; 429 à la limite ; adresse invalide 400", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    expect(await c.startEmailLogin("camille@example.com", "fr")).toEqual({ sent: true });
    expect(await c.startEmailLogin("jamais-vu@inconnu.example", "en")).toEqual({ sent: true });
    expect(((await c.startEmailLogin("limite@example.com", "fr").catch((e) => e)) as NokkerApiError).status).toBe(429);
    expect(((await c.startEmailLogin("pas-une-adresse", "fr").catch((e) => e)) as NokkerApiError).status).toBe(400);
  });

  it("bon code : appareil actif et session ; faux code ou adresse inconnue : 401 invalid_code identique", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    const keys = await generateDeviceKeyPair();
    const req = { email: "camille@example.com", code: "123456", name: "iPhone", public_key_spki: keys.publicKeySpkiB64Url };
    const r = await c.verifyEmailCode(req);
    const { challenge } = await c.requestSessionChallenge(r.device_id);
    const s = await c.createSession({ device_id: r.device_id, challenge, signature: await signChallenge(keys.privateKey, challenge, "login") });
    expect(s.user).toBe(r.user);
    const bad = await c.verifyEmailCode({ ...req, code: "000000" }).catch((e) => e);
    const unknown = await c.verifyEmailCode({ ...req, email: "x@inconnu.example" }).catch((e) => e);
    expect(bad.status).toBe(401);
    expect(code(bad)).toEqual({ error: "invalid_code" });
    expect(code(unknown)).toEqual(code(bad));
  });

  it("l'appareil créé par code ne décide jamais d'une approbation : 403 strong_device_required", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    const keys = await generateDeviceKeyPair();
    const r = await c.verifyEmailCode({ email: "camille@example.com", code: "123456", name: "iPhone", public_key_spki: keys.publicKeySpkiB64Url });
    const { challenge } = await c.requestSessionChallenge(r.device_id);
    await c.createSession({ device_id: r.device_id, challenge, signature: await signChallenge(keys.privateKey, challenge, "login") });
    const err = (await c.decideApproval("appr_x", { decision: "approve", device_id: r.device_id, challenge: "" } as never).catch((e) => e)) as NokkerApiError;
    expect(err.status).toBe(403);
    expect(err.serverMessage).toBe("strong_device_required");
  });

  it("5 faux codes brûlent le code, même le bon est refusé", async () => {
    const c = new NokkerClient({ baseUrl: mock.url });
    const keys = await generateDeviceKeyPair();
    const req = { email: "brule@example.com", code: "111111", name: "t", public_key_spki: keys.publicKeySpkiB64Url };
    for (let i = 0; i < 5; i++) await c.verifyEmailCode(req).catch(() => undefined);
    const err = await c.verifyEmailCode({ ...req, code: "123456" }).catch((e) => e);
    expect(err.status).toBe(401);
  });
});
