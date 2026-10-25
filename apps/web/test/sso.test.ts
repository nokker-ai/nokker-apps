import { describe, expect, it } from "vitest";
import { NokkerApiError, type NokkerClient, type OidcCallbackRequest, type OidcStartRequest } from "@nokker-apps/sdk";
import { STATE_KEY, cleanMappings, completeSso, mayAutoRedirect, safeBack, ssoErrorCode, ssoRequiredConnection, startSso, withSsoGuard, type SsoDeps, type SsoPending } from "../src/sso/flow.js";
import { ssoText } from "../src/sso/text.js";

const b64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

function memSession(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

function deps(over: Partial<SsoDeps> = {}) {
  const calls: { start?: OidcStartRequest; callback?: OidcCallbackRequest } = {};
  let pending: SsoPending | undefined;
  const stored: { id: string; spki: string }[] = [];
  const client = {
    startOidc: async (req: OidcStartRequest) => ((calls.start = req), { authorize_url: "https://idp.example.com/authorize?x=1", state: "st-1", connection: "sc_0123456789abcdef", expires_at: null }),
    oidcCallback: async (req: OidcCallbackRequest) => ((calls.callback = req), { device_id: "dev_1", user: "us_1", projects: [] }),
  } as unknown as NokkerClient;
  const d: SsoDeps = {
    client,
    session: memSession(),
    pending: { put: async (p) => void (pending = p), get: async () => pending, drop: async () => void (pending = undefined) },
    storeDevice: async (id, pair) => void stored.push({ id, spki: pair.publicKeySpkiB64Url }),
    hadDevice: async () => stored.length > 0,
    secure: () => true,
    deviceName: () => "web-test",
    lang: "fr",
    ...over,
  };
  return { d, calls, stored, pending: () => pending };
}

describe("connexion SSO (§7.24)", () => {
  it("start puis callback : state gardé, signature de « <state>.oidc » par la clé du start, appareil rangé", async () => {
    const { d, calls, stored, pending } = deps();
    const url = await startSso(d, { email: " Alice@Example.com " }, "/?tab=team");
    expect(url).toBe("https://idp.example.com/authorize?x=1");
    expect(calls.start).toMatchObject({ email: "alice@example.com", name: "web-test", lang: "fr" });
    expect(calls.start!.public_key_spki).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(d.session.getItem(STATE_KEY)).toBe("st-1");
    expect(pending()).toMatchObject({ state: "st-1", back: "/?tab=team", publicKeySpkiB64Url: calls.start!.public_key_spki });

    const r = await completeSso(d, "?code=abc&state=st-1");
    expect(r.back).toBe("/?tab=team");
    expect(r.replaced).toBe(false);
    expect(calls.callback).toMatchObject({ state: "st-1", code: "abc" });
    const key = await crypto.subtle.importKey("spki", b64u(calls.start!.public_key_spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u(calls.callback!.signature), new TextEncoder().encode("st-1.oidc"));
    expect(ok).toBe(true);
    expect(stored).toEqual([{ id: "dev_1", spki: calls.start!.public_key_spki }]);
    // usage unique : plus rien en attente
    expect(d.session.getItem(STATE_KEY)).toBeNull();
    expect(pending()).toBeUndefined();
  });

  it("un appareil déjà rangé pour ce navigateur est signalé (il reste actif côté nokker.ai)", async () => {
    const { d } = deps();
    await startSso(d, { email: "alice@example.com" });
    expect((await completeSso(d, "?code=abc&state=st-1")).replaced).toBe(false);
    await startSso(d, { email: "alice@example.com" });
    expect((await completeSso(d, "?code=abc&state=st-1")).replaced).toBe(true);
  });

  it("un state qui n'est pas le nôtre ne part jamais au noyau", async () => {
    const { d, calls } = deps();
    await startSso(d, { connection: "sc_0123456789abcdef" });
    expect(calls.start).toMatchObject({ connection: "sc_0123456789abcdef" });
    await expect(completeSso(d, "?code=abc&state=autre")).rejects.toMatchObject({ code: "invalid_state" });
    expect(calls.callback).toBeUndefined();
    // et l'attente est consommée : rejouer le bon state échoue aussi
    await expect(completeSso(d, "?code=abc&state=st-1")).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("refus du fournisseur : `error` part au noyau (qui le journalise) à la place du code", async () => {
    const { d, calls } = deps();
    await startSso(d, { email: "alice@example.com" });
    await completeSso(d, "?error=access_denied&state=st-1");
    expect(calls.callback).toMatchObject({ state: "st-1", error: "access_denied" });
    expect(calls.callback).not.toHaveProperty("code");
  });

  it("hors contexte sécurisé : rien ne part", async () => {
    const { d, calls } = deps({ secure: () => false });
    await expect(startSso(d, { email: "alice@example.com" })).rejects.toMatchObject({ code: "insecure_context" });
    expect(calls.start).toBeUndefined();
  });

  it("retour : un chemin de cette origine seulement", () => {
    expect(safeBack("/?tab=team")).toBe("/?tab=team");
    for (const b of ["https://ailleurs.example", "//ailleurs.example", "/\\ailleurs.example", "", null]) expect(safeBack(b)).toBe("/");
  });

  it("chaque erreur du callback a sa phrase, en français et en anglais", () => {
    for (const code of ["invalid_state", "binding_invalid", "idp_error", "token_invalid", "email_unverified", "domain_refused", "account_conflict", "account_inactive"]) {
      const err = new NokkerApiError("x", 401, { error: { code, message: "m" } });
      expect(ssoErrorCode(err)).toBe(code);
      expect(ssoText("fr", code)).not.toBe(ssoText("fr", "generic"));
      expect(ssoText("en", code)).not.toBe(ssoText("fr", code));
    }
    expect(ssoErrorCode(new NokkerApiError("x", 429, undefined))).toBe("rate");
    expect(ssoErrorCode(new Error("réseau"))).toBe("network");
  });
});

describe("SSO obligatoire : 403 sso_required", () => {
  const required = new NokkerApiError("x", 403, { error: { code: "sso_required", connection: "sc_0123456789abcdef", message: "connexion SSO requise pour ce projet" } });

  it("la connexion exigée se lit dans error.connection ; un autre 403 n'est pas un SSO", () => {
    expect(ssoRequiredConnection(required)).toBe("sc_0123456789abcdef");
    expect(ssoRequiredConnection(new NokkerApiError("x", 403, { error: { code: "sso_required", message: "(sc_0123456789abcdef)" } }))).toBe("");
    expect(ssoRequiredConnection(new NokkerApiError("x", 403, { error: { code: "forbidden", message: "rôle" } }))).toBeNull();
  });

  it("le client gardé signale le 403 puis relance l'erreur ; le reste passe tel quel", async () => {
    const seen: string[] = [];
    const raw = { listProjectMembers: async () => Promise.reject(required), listProjects: async () => ({ projects: [], invitations: 0 }) } as unknown as NokkerClient;
    const c = withSsoGuard(raw, (sc) => seen.push(sc));
    await expect(c.listProjectMembers("pj_1")).rejects.toBe(required);
    expect(seen).toEqual(["sc_0123456789abcdef"]);
    expect(await c.listProjects()).toEqual({ projects: [], invitations: 0 });
  });

  it("une redirection automatique par connexion et par minute", () => {
    const s = memSession();
    expect(mayAutoRedirect(s, "sc_a", 1_000)).toBe(true);
    expect(mayAutoRedirect(s, "sc_a", 30_000)).toBe(false);
    expect(mayAutoRedirect(s, "sc_b", 30_000)).toBe(true);
    expect(mayAutoRedirect(s, "sc_b", 100_000)).toBe(true);
  });

  it("groupes → rôles : vides retirés, doublons fusionnés", () => {
    expect(
      cleanMappings([
        { group: " dev ", role: "member" },
        { group: "", role: "viewer" },
        { group: "dev", role: "member" },
        { group: "dev", role: "maintainer" },
      ]),
    ).toEqual([
      { group: "dev", role: "member" },
      { group: "dev", role: "maintainer" },
    ]);
  });
});
