import { describe, expect, it, vi } from "vitest";
import {
  GatewayAuthError,
  beginLogin,
  codeChallenge,
  completeCallback,
  gatewayHost,
  refreshDelayMs,
  refreshToken,
  safeBack,
} from "../src/gateway/auth.js";

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("passerelle : connexion PKCE", () => {
  it("nom de passerelle", () => {
    expect(gatewayHost("atelier.nokker.app")).toBe("atelier.nokker.app");
    expect(gatewayHost("Atelier.Nokker.App")).toBe("atelier.nokker.app");
    expect(gatewayHost("atelier--pages.nokker.app")).toBeNull();
    expect(gatewayHost("-a.nokker.app")).toBeNull();
    expect(gatewayHost("ab.nokker.app")).toBeNull();
    expect(gatewayHost("app.nokker.ai")).toBeNull();
    expect(gatewayHost("x.atelier.nokker.app")).toBeNull();
  });

  it("S256 : vecteur de la RFC 7636", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("retour sûr", () => {
    expect(safeBack("/chat?x=1")).toBe("/chat?x=1");
    expect(safeBack("//evil.com")).toBe("/");
    expect(safeBack("https://evil.com")).toBe("/");
    expect(safeBack("/auth/callback?code=x")).toBe("/");
  });

  it("aller-retour : state vérifié, code échangé avec le verifier, entrée consommée", async () => {
    const s = memStore();
    const url = new URL(await beginLogin("atelier.nokker.app", "/chat", s, "https://app.nokker.ai/gateway/authorize"));
    expect(url.origin + url.pathname).toBe("https://app.nokker.ai/gateway/authorize");
    expect(url.searchParams.get("host")).toBe("atelier.nokker.app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const fetchImpl = vi.fn(async (_p: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { code: string; code_verifier: string };
      expect(await codeChallenge(body.code_verifier)).toBe(url.searchParams.get("code_challenge"));
      expect((init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return json(200, { access_token: "at", expires_in: 900 });
    });
    const r = await completeCallback(`?code=c1&state=${state}`, s, fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ access_token: "at", expires_in: 900, back: "/chat" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/_gw/token");
    expect(s.m.size).toBe(0);
    await expect(completeCallback(`?code=c1&state=${state}`, s, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ kind: "state" });
  });

  it("state faux, refus, échange refusé", async () => {
    const s = memStore();
    await beginLogin("atelier.nokker.app", "/", s);
    const f = vi.fn(async () => json(400, {})) as unknown as typeof fetch;
    await expect(completeCallback("?code=c&state=autre", s, f)).rejects.toBeInstanceOf(GatewayAuthError);
    await beginLogin("atelier.nokker.app", "/", s);
    await expect(completeCallback("?error=access_denied", s, f)).rejects.toMatchObject({ kind: "denied" });
    const url = new URL(await beginLogin("atelier.nokker.app", "/", s));
    await expect(completeCallback(`?code=c&state=${url.searchParams.get("state")}`, s, f)).rejects.toMatchObject({ kind: "exchange" });
  });

  it("refresh : 401 = déconnecté, 502 = réessayer, 200 = jeton", async () => {
    expect(await refreshToken((async () => json(401, {})) as unknown as typeof fetch)).toBeNull();
    await expect(refreshToken((async () => json(502, {})) as unknown as typeof fetch)).rejects.toMatchObject({ kind: "unavailable" });
    expect(await refreshToken((async () => json(200, { access_token: "a", expires_in: 900 })) as unknown as typeof fetch)).toEqual({ access_token: "a", expires_in: 900 });
    await expect(refreshToken((async () => json(403, {})) as unknown as typeof fetch)).rejects.toMatchObject({ kind: "forbidden" });
    const limited = async () => new Response("{}", { status: 429, headers: { "Retry-After": "60" } });
    await expect(refreshToken(limited as unknown as typeof fetch)).rejects.toMatchObject({ kind: "unavailable", retryAfterMs: 60_000 });
    expect(refreshDelayMs(900)).toBe(720_000);
    expect(refreshDelayMs(5)).toBe(10_000);
  });
});

import { callbackUrl, parseAuthorize } from "../src/gateway/authorize.js";

describe("page /gateway/authorize de nokker.ai", () => {
  const ch = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const ok = `?host=atelier.nokker.app&state=abcdefgh12&code_challenge=${ch}&code_challenge_method=S256`;
  it("paramètres", () => {
    expect(parseAuthorize(ok)).toEqual({ host: "atelier.nokker.app", state: "abcdefgh12", challenge: ch });
    expect(parseAuthorize(ok.replace("S256", "plain"))).toBeNull();
    expect(parseAuthorize(ok.replace("atelier.nokker.app", "evil.com"))).toBeNull();
    expect(parseAuthorize(ok.replace("atelier.nokker.app", "a--pages.nokker.app"))).toBeNull();
    expect(parseAuthorize(ok.replace("abcdefgh12", "x"))).toBeNull();
    expect(parseAuthorize(ok.replace("atelier.nokker.app", "10.0.0.1:5392"), "10.0.0.1:5392")?.host).toBe("10.0.0.1:5392");
  });
  it("retour : seulement vers l'hôte demandé, sur /auth/callback", () => {
    const req = parseAuthorize(ok)!;
    expect(callbackUrl("https://atelier.nokker.app/auth/callback", req, { code: "c" })).toBe("https://atelier.nokker.app/auth/callback?code=c&state=abcdefgh12");
    expect(callbackUrl("https://evil.nokker.app/auth/callback", req, { code: "c" })).toBeNull();
    expect(callbackUrl("https://atelier.nokker.app/ailleurs", req, { code: "c" })).toBeNull();
    expect(callbackUrl("pas une url", req, { code: "c" })).toBeNull();
  });
});
