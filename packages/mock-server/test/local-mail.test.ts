import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { LOCAL_TOKEN, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01, seed: false });
  c = new NokkerClient({ baseUrl: mock.url, token: LOCAL_TOKEN });
});
afterEach(async () => {
  await mock.close();
});
const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    const b = e.body as { error?: string; message?: string };
    return { status: e.status, code: b.error, message: b.message };
  }
};
const gmail = { preset: "gmail", address: "alice@example.com" };

describe("boîte mail de la machine (§7.25)", () => {
  it("jeton local seulement", async () => {
    expect((await fail(new NokkerClient({ baseUrl: mock.url }).listLocalConnectors())).status).toBe(401);
  });

  it("absente au départ ; préréglages triés", async () => {
    const l = await c.listLocalConnectors();
    expect(l.connectors).toEqual([{ kind: "mail", state: "absent", locality: "local" }]);
    expect(l.presets.mail).toEqual(["fastmail", "gmail", "icloud", "infomaniak"]);
  });

  it("le mot de passe est un NOM du coffre : valeur, nom absent ou champ password refusés sans être répétés", async () => {
    const value = "mot-de-passe-en-clair-123";
    const r1 = await fail(c.putLocalMail({ settings: gmail, secret: "MAIL_PASS" }));
    expect(r1).toMatchObject({ status: 400, code: "bad_settings", message: expect.stringMatching(/pas dans le coffre/) });
    await c.putLocalSecret("MAIL_PASS", value);
    const r2 = await fail(c.putLocalMail({ settings: { ...gmail, password: value } as never, secret: "MAIL_PASS" }));
    expect(r2).toMatchObject({ status: 400, code: "bad_settings" });
    expect(r2.message).not.toContain(value);
    const r3 = await fail(c.putLocalMail({ settings: gmail, secret: ["a1b2c3", "d4e5f6a7b8c9d0e1f2a3b4"].join("") }));
    expect(r3).toMatchObject({ status: 400, message: expect.stringMatching(/NOM/) });
  });

  it("reliée après test, carte avec le nom du secret ; test, refus d'identifiants, retrait", async () => {
    await c.putLocalSecret("MAIL_PASS", "x");
    const card = await c.putLocalMail({ settings: gmail, secret: "secret:MAIL_PASS" });
    expect(card).toMatchObject({ kind: "mail", state: "ok", locality: "local", secret: "MAIL_PASS", settings: { preset: "gmail", address: "alice@example.com", imap_host: "imap.gmail.com", smtp_host: "smtp.gmail.com" } });
    expect(JSON.stringify(card)).not.toMatch(/"x"/);
    expect((await c.testLocalMail()).ok).toBe(true);
    expect(await fail(c.putLocalMail({ settings: { ...gmail, address: "refus@example.com" }, secret: "MAIL_PASS" }))).toMatchObject({ status: 422, code: "auth_failed" });
    expect(await fail(c.putLocalMail({ settings: { preset: "custom", address: "a@example.com", imap_host: "imap.example.com", imap_port: 25, smtp_host: "smtp.example.com", smtp_port: 587 }, secret: "MAIL_PASS" }))).toMatchObject({ status: 400, code: "port_not_allowed" });
    expect(await c.deleteLocalMail()).toEqual({ revoked: true });
    expect(await fail(c.testLocalMail())).toMatchObject({ status: 404, code: "not_configured" });
  });
});
