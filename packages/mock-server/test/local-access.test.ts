import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { accessReset, accessSetCodeTtl, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let dir: string;
let owner: NokkerClient; // jeton LOCAL
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-access-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir });
  owner = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
});
afterAll(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

const status = (p: Promise<unknown>): Promise<number | string> => p.then(() => "ok", (e) => (e instanceof NokkerApiError ? (e.code ?? e.status) : "autre"));

describe("accès sans jeton dans l'URL : code à usage unique → jeton de session", () => {
  it("mint (jeton local) puis échange SANS Authorization : un jeton de session distinct, une seule fois", async () => {
    accessReset(mock.state);
    const { code, expires_in } = await owner.mintSessionCode();
    expect(expires_in).toBe(60);
    expect(code).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const anon = new NokkerClient({ baseUrl: mock.url });
    const ex = await anon.exchangeSessionCode(code);
    expect(ex.token).not.toBe(mock.localToken);
    expect(ex.token.length).toBeGreaterThanOrEqual(32);
    expect(ex.expires_in).toBe(30 * 24 * 3600);
    // Une seconde fois : le code est mort, jamais de jeton.
    expect(await status(anon.exchangeSessionCode(code))).toBe("code_used");
  });

  it("périmé : 410 code_expired (et le code meurt aussi)", async () => {
    accessReset(mock.state);
    accessSetCodeTtl(mock.state, 30);
    const { code } = await owner.mintSessionCode();
    await new Promise((r) => setTimeout(r, 60));
    const anon = new NokkerClient({ baseUrl: mock.url });
    expect(await status(anon.exchangeSessionCode(code))).toBe("code_expired");
    expect(await status(anon.exchangeSessionCode(code))).toBe("code_used");
    accessSetCodeTtl(mock.state, 60_000);
  });

  it("mal formé : 400 ; inconnu : 410 ; au plus 5 codes vivants ; 10 échecs par minute : 429", async () => {
    accessReset(mock.state);
    const anon = new NokkerClient({ baseUrl: mock.url });
    expect(await status(anon.exchangeSessionCode("court"))).toBe("bad_code");
    for (let i = 0; i < 5; i++) await owner.mintSessionCode();
    expect(await status(owner.mintSessionCode())).toBe("too_many_codes");
    accessReset(mock.state);
    for (let i = 0; i < 10; i++) expect(await status(anon.exchangeSessionCode("A".repeat(22)))).toBe("code_expired");
    expect(await status(anon.exchangeSessionCode("A".repeat(22)))).toBe("rate_limited");
    accessReset(mock.state);
    expect(await status(anon.exchangeSessionCode("B".repeat(22)))).toBe("code_expired"); // inconnu : comme le noyau
  });

  it("le jeton de session a les droits propriétaire sur /v1/local/*, SAUF mint, liste et révocation", async () => {
    accessReset(mock.state);
    const { code } = await owner.mintSessionCode();
    const { token } = await new NokkerClient({ baseUrl: mock.url }).exchangeSessionCode(code);
    const session = new NokkerClient({ baseUrl: mock.url, token });
    expect(await status(session.listLocalSessions())).toBe("ok"); // droits propriétaire
    expect(await status(session.mintSessionCode())).toBe("local_token_required");
    expect(await status(session.listAccessSessions())).toBe("local_token_required");
    expect(await status(session.revokeAccessSession("as_0123456789abcdef"))).toBe("local_token_required");
  });

  it("liste et révocation (jeton local seulement) : la session révoquée ne passe plus", async () => {
    accessReset(mock.state);
    const { code } = await owner.mintSessionCode();
    const { token } = await new NokkerClient({ baseUrl: mock.url }).exchangeSessionCode(code);
    const { sessions } = await owner.listAccessSessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.id).toMatch(/^as_[0-9a-f]{16}$/);
    expect(JSON.stringify(sessions)).not.toContain(token); // jamais le jeton
    expect(s.expires_at).toBeGreaterThan(s.created_at);
    const session = new NokkerClient({ baseUrl: mock.url, token });
    expect(await status(session.listLocalSessions())).toBe("ok");
    expect(await owner.revokeAccessSession(s.id)).toEqual({ id: s.id, revoked: true });
    expect(await status(session.listLocalSessions())).toBe(401);
    expect(await status(owner.revokeAccessSession(s.id))).toBe("not_found");
  });
});

describe("portées du jeton de session (noyau p2/integ-kiosk-code)", () => {
  async function tokenOf(scope?: "kiosk" | "present"): Promise<{ client: NokkerClient; scope: string | undefined; expires: number }> {
    const { code } = await owner.mintSessionCode(scope);
    const ex = await new NokkerClient({ baseUrl: mock.url }).exchangeSessionCode(code);
    return { client: new NokkerClient({ baseUrl: mock.url, token: ex.token }), scope: ex.scope, expires: ex.expires_in };
  }
  const status = async (p: Promise<unknown>): Promise<number | string> => p.then(() => "ok", (e: NokkerApiError) => e.status ?? "err");

  it("l'échange rend la portée : owner par défaut, kiosk, present (12 h fixes)", async () => {
    expect((await tokenOf()).scope).toBe("owner");
    expect((await tokenOf("kiosk")).scope).toBe("kiosk");
    const p = await tokenOf("present");
    expect(p.scope).toBe("present");
    expect(p.expires).toBe(12 * 3600);
  });
  it("kiosk : liste blanche en lecture (GET /v1/local/kiosk, capacités, healthz) ; tout le reste 403 scope_kiosk", async () => {
    const k = (await tokenOf("kiosk")).client;
    await k.getKiosk();
    const caps = await fetch(`${mock.url}/v1/capabilities`, { headers: { Authorization: `Bearer ${(k as unknown as { token: string }).token}` } });
    expect(caps.status).not.toBe(403); // dans la liste blanche (404 : le mock n'annonce pas de capacités)
    const calls: Array<[string, () => Promise<unknown>]> = [["threads", () => k.listThreads()], ["sessions", () => k.listLocalSessions()], ["approvals", () => k.listApprovals()]];
    for (const [name, call] of calls) {
      const e = await call().then(() => null, (x: NokkerApiError) => x);
      expect([name, e?.status]).toEqual([name, 403]);
      expect(JSON.stringify(e?.body)).toContain("scope_kiosk");
    }
  });
  it("present : propriétaire sans la gestion ; la lecture des cartes passe, aucune décision ; 403 scope_present", async () => {
    const p = (await tokenOf("present")).client;
    await p.listThreads(); // l'app se charge
    await p.listApprovals(); // une carte qui attend se lit
    expect(await status(p.mintSessionCode())).toBe(403);
    expect(await status(p.getLocalAccord())).toBe(403);
    expect(await status(p.decideLocalApproval("appr_x", { decision: "approve", scope: "once" } as never))).toBe(403);
    expect(await status(p.listAccessSessions())).toBe(403);
  });
  it("révocation par portée (arrêt de l'unité) : le jeton kiosk meurt, les autres vivent", async () => {
    accessReset(mock.state); // les cas d'avant laissent des jetons kiosk vivants : on compte à partir de zéro
    const k = (await tokenOf("kiosk")).client;
    const o2 = (await tokenOf()).client;
    const res = await fetch(`${mock.url}/v1/local/access-sessions/scope/kiosk`, { method: "DELETE", headers: { Authorization: `Bearer ${mock.localToken}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "kiosk", revoked: 1 });
    expect(await status(k.getKiosk())).toBe(401);
    const bad = await fetch(`${mock.url}/v1/local/access-sessions/scope/admin`, { method: "DELETE", headers: { Authorization: `Bearer ${mock.localToken}` } });
    expect(bad.status).toBe(400);
    await o2.listThreads();
  });
});

describe("expect à l'échange (noyau p2/integ-exchange-expect)", () => {
  const exchange = (code: string, expect?: unknown): Promise<Response> =>
    fetch(`${mock.url}/v1/local/session-code/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(expect === undefined ? { code } : { code, expect }) });

  it("portée conforme : 200 comme avant ; absent ou null : inchangé", async () => {
    accessReset(mock.state);
    expect((await exchange((await owner.mintSessionCode("kiosk")).code, "kiosk")).status).toBe(200);
    expect((await exchange((await owner.mintSessionCode("present")).code, null)).status).toBe(200);
    expect((await exchange((await owner.mintSessionCode()).code)).status).toBe(200);
  });
  it("autre portée : 409 wrong_scope, le code n'est PAS consommé (il sert à la bonne page), aucune session créée, aucun échec compté", async () => {
    accessReset(mock.state);
    const { code } = await owner.mintSessionCode();
    const before = (await owner.listAccessSessions()).length;
    for (let i = 0; i < 12; i++) { // plus que la limite de 10 échecs par minute : un 409 n'en compte aucun
      const r = await exchange(code, "kiosk");
      expect([r.status, ((await r.json()) as { error: { code: string } }).error.code]).toEqual([409, "wrong_scope"]);
    }
    expect((await owner.listAccessSessions()).length).toBe(before);
    expect((await exchange(code, "owner")).status).toBe(200); // toujours valable pour la bonne page
    expect((await exchange(code, "owner")).status).toBe(410); // puis servi
  });
  it("expect inconnu : 400 bad_scope, code intact ; un code déjà utilisé dit 410 AVANT 409", async () => {
    accessReset(mock.state);
    const { code } = await owner.mintSessionCode("kiosk");
    expect((await exchange(code, "admin")).status).toBe(400);
    expect((await exchange(code, "kiosk")).status).toBe(200);
    expect((await exchange(code, "owner")).status).toBe(410); // servi : 410 code_used, pas 409
  });
});
