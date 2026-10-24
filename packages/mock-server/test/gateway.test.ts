import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
});
afterEach(async () => {
  await mock.close();
});

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const gw = (path: string, body: unknown = {}, cookie?: string, type = "application/json") =>
  fetch(`${mock.url}${path}`, { method: "POST", headers: { "Content-Type": type, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

describe("passerelle : code + PKCE, refresh par cookie", () => {
  it("authorize exige une session ; machine d'un autre compte : 403", async () => {
    await expect(c.gatewayAuthorize("atelier.nokker.app", challenge)).rejects.toMatchObject({ status: 401 });
    await c.demoSessionMockExtension();
    const e = await c.gatewayAuthorize("autre-x.nokker.app", challenge).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NokkerApiError);
    expect((e as NokkerApiError).status).toBe(403);
  });

  it("code échangé une fois avec le bon verifier ; le jeton ouvre l'API ; refresh tourne ; logout ferme", async () => {
    await c.demoSessionMockExtension();
    const { code, redirect } = await c.gatewayAuthorize("atelier.nokker.app", challenge);
    expect(redirect).toBe("https://atelier.nokker.app/auth/callback");
    expect((await gw("/_gw/token", { code, code_verifier: "faux".padEnd(43, "x") })).status).toBe(400);
    const again = await c.gatewayAuthorize("atelier.nokker.app", challenge);
    const r = await gw("/_gw/token", { code: again.code, code_verifier: verifier });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const tok = (await r.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    expect(tok.refresh_token).toBeUndefined();
    expect(tok.expires_in).toBe(900);
    expect((await gw("/_gw/token", { code: again.code, code_verifier: verifier })).status).toBe(400);
    const viaGw = new NokkerClient({ baseUrl: mock.url, token: tok.access_token });
    expect(Array.isArray(await viaGw.listThreads())).toBe(true);

    const ck = cookieOf(r);
    const r2 = await gw("/_gw/refresh", {}, ck);
    expect(r2.status).toBe(200);
    expect((await gw("/_gw/refresh", {}, ck)).status).toBe(401); // l'ancien refresh a tourné
    const ck2 = cookieOf(r2);
    expect((await gw("/_gw/logout", {}, ck2)).status).toBe(204);
    expect((await gw("/_gw/refresh", {}, ck2)).status).toBe(401);
  });

  it("refresh : 502 garde le cookie ; JSON exigé ; route inconnue 404", async () => {
    await c.demoSessionMockExtension();
    const { code } = await c.gatewayAuthorize("atelier.nokker.app", challenge);
    const ck = cookieOf(await gw("/_gw/token", { code, code_verifier: verifier }));
    await gw("/v1/dev/gateway-mock", { refresh: "down" });
    const down = await gw("/_gw/refresh", {}, ck);
    expect(down.status).toBe(502);
    expect(down.headers.get("set-cookie")).toBeNull();
    expect((await gw("/_gw/refresh", {}, ck)).status).toBe(200);
    expect((await gw("/_gw/refresh", {}, ck, "text/plain")).status).toBe(403);
    expect((await gw("/_gw/autre")).status).toBe(404);
  });
});

describe("passerelle : authorize exige S256", () => {
  it("méthode absente ou plain : 400", async () => {
    await c.demoSessionMockExtension();
    const r = await fetch(`${mock.url}/v1/gateway/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${(c as unknown as { token: string }).token}` },
      body: JSON.stringify({ host: "atelier.nokker.app", code_challenge: challenge, code_challenge_method: "plain" }),
    });
    expect(r.status).toBe(400);
    expect((await c.gatewayAuthorize("atelier.nokker.app", challenge)).expires_in).toBe(60);
  });
});
