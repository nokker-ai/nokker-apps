import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, generateDeviceKeyPair, isGatedProject, signChallenge, type DeviceKeyPair } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock?.close();
});

async function boot(sso: boolean): Promise<NokkerClient> {
  mock = await startMockServer({ speed: 0.01, sso });
  const c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
  return c;
}

const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } } | undefined)?.error?.code };
  }
};

/** Page du fournisseur simulé → lien de retour de l'identité choisie (`code` ou `error`). */
async function idpReturn(authorizeUrl: string, pick: string): Promise<URLSearchParams> {
  const html = await (await fetch(new URL(authorizeUrl, mock.url))).text();
  const links = [...html.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => ({ href: m[1]!.replace(/&amp;/g, "&"), label: m[2]! }));
  const hit = links.find((l) => l.label.includes(pick));
  if (!hit) throw new Error(`identité « ${pick} » absente de la page`);
  expect(hit.href.startsWith("/sso/callback?")).toBe(true);
  return new URLSearchParams(hit.href.split("?")[1]);
}

async function login(c: NokkerClient, pick: string, opts: { pair?: DeviceKeyPair; connection?: string; email?: string } = {}) {
  const pair = opts.pair ?? (await generateDeviceKeyPair());
  const start = await c.startOidc({ ...(opts.connection ? { connection: opts.connection } : { email: opts.email ?? "alice@example.com" }), public_key_spki: pair.publicKeySpkiB64Url, name: "test" });
  const back = await idpReturn(start.authorize_url, pick);
  const state = back.get("state")!;
  expect(state).toBe(start.state);
  const code = back.get("code");
  const error = back.get("error");
  return { pair, start, state, call: (signWith: DeviceKeyPair = pair, st = state) => signChallenge(signWith.privateKey, st, "oidc").then((signature) => c.oidcCallback({ state: st, ...(error ? { error } : { code: code! }), signature })) };
}

describe("SSO OIDC (§7.24)", () => {
  it("drapeau éteint : aucune route, la liste des projets inchangée", async () => {
    const c = await boot(false);
    expect((await fail(c.listSsoConnections())).status).toBe(404);
    expect((await fail(c.startOidc({ email: "alice@example.com", public_key_spki: (await generateDeviceKeyPair()).publicKeySpkiB64Url }))).status).toBe(404);
    expect((await c.listProjects()).projects.some(isGatedProject)).toBe(false);
  });

  it("connexions : création, valeur de secret refusée dans le corps, secret en écriture seule", async () => {
    const c = await boot(true);
    const before = (await c.listSsoConnections()).connections;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ client_secret: { set: true }, domains: [{ domain: "example.com", verified: true }] });
    expect(await fail(c.createSsoConnection({ name: "x", issuer: "https://idp.example.org", client_id: "a", client_secret_name: "S", client_secret: "valeur" } as never))).toEqual({ status: 400, code: "secret_value_refused" });
    expect(await fail(c.createSsoConnection({ name: "x", issuer: "http://idp.example.org", client_id: "a", client_secret_name: "S" }))).toEqual({ status: 400, code: "bad_issuer" });
    const made = await c.createSsoConnection({ name: "Annuaire", issuer: "https://idp.example.org", client_id: "nokker", client_secret_name: "SSO_CLIENT" });
    expect(made).toMatchObject({ client_secret: { name: "SSO_CLIENT", set: false }, redirect_uri: expect.stringMatching(/^https:\/\/.+\/sso\/callback$/), groups_claim: "groups", token_auth: "client_secret_basic" });
    expect(await c.setSsoClientSecret(made.id, "s3cret")).toEqual({ client_secret: { name: "SSO_CLIENT", set: true } });
    expect(JSON.stringify(await c.getSsoConnection(made.id))).not.toContain("s3cret");
    expect((await c.patchSsoConnection(made.id, { name: "Annuaire 2" })).name).toBe("Annuaire 2");
    expect((await c.getSsoAudit(made.id)).events.map((e) => e.event)).toEqual(["connection_changed", "client_secret_set", "connection_created"]);
    expect(await c.deleteSsoConnection(made.id)).toEqual({ deleted: true });
    expect((await fail(c.getSsoConnection(made.id))).status).toBe(404);
  });

  it("domaines : TXT à poser, preuve, refus simulés", async () => {
    const c = await boot(true);
    const made = await c.createSsoConnection({ name: "D", issuer: "https://idp.example.org", client_id: "d", client_secret_name: "S" });
    const d = await c.addSsoDomain(made.id, "Equipe.Example.org");
    expect(d).toMatchObject({ domain: "equipe.example.org", verified: false, txt: { name: "_nokker-sso.equipe.example.org", value: expect.stringMatching(/^nokker-sso=[0-9a-f]{32}$/) } });
    expect((await c.verifySsoDomain(made.id, "equipe.example.org")).verified).toBe(true);
    await c.addSsoDomain(made.id, "absent.example.org");
    expect(await fail(c.verifySsoDomain(made.id, "absent.example.org"))).toEqual({ status: 409, code: "not_verified" });
    await c.addSsoDomain(made.id, "example.com");
    expect(await fail(c.verifySsoDomain(made.id, "example.com"))).toEqual({ status: 409, code: "domain_claimed" });
    await c.addSsoDomain(made.id, "dns-hs.example.org");
    expect(await fail(c.verifySsoDomain(made.id, "dns-hs.example.org"))).toEqual({ status: 503, code: "dns_unavailable" });
    expect(await c.removeSsoDomain(made.id, "absent.example.org")).toEqual({ removed: true });
  });

  it("lien projet : propriétaire seulement, jamais owner par un groupe, max_age borné", async () => {
    const c = await boot(true);
    const { projects } = await c.listProjects();
    const site = projects.find((p) => p.name === "Marketing site")!;
    const sc = (await c.listSsoConnections()).connections[0]!.id;
    expect(await c.getProjectSso(site.id)).toMatchObject({ connection: sc, required: false, max_age_s: 43200 });
    expect(await fail(c.putProjectSso(site.id, { connection: sc, mappings: [{ group: "g", role: "owner" as never }] }))).toEqual({ status: 400, code: "owner_not_mappable" });
    expect(await fail(c.putProjectSso(site.id, { connection: sc, mappings: [], max_age_s: 10 }))).toEqual({ status: 400, code: "bad_request" });
    expect((await c.putProjectSso(site.id, { connection: sc, mappings: [{ group: "g", role: "viewer" }], required: true, max_age_s: 3600 })).required).toBe(true);
    const recherche = projects.find((p) => p.name === "Research")!;
    expect((await fail(c.getProjectSso(recherche.id))).status).toBe(403);
    expect(await c.deleteProjectSso(site.id)).toEqual({ removed: true });
    expect((await fail(c.getProjectSso(site.id))).status).toBe(404);
  });

  it("SSO obligatoire : projet réduit et 403 sso_required, puis ouvert après la connexion SSO", async () => {
    const c = await boot(true);
    const gated = (await c.listProjects()).projects.find((p) => p.name === "Research")!;
    expect(isGatedProject(gated)).toBe(true);
    if (!isGatedProject(gated)) return;
    expect(Object.keys(gated).sort()).toEqual(["created_at", "id", "name", "role", "sso"]);
    expect(await fail(c.listProjectMembers(gated.id))).toEqual({ status: 403, code: "sso_required" });
    const body = await fetch(`${mock.url}/v1/projects/${gated.id}/members`, { headers: { Authorization: `Bearer ${(c as unknown as { token: string }).token}` } }).then((r) => r.json());
    expect(body.error).toMatchObject({ code: "sso_required", connection: gated.sso.connection });
    // Le propriétaire n'est jamais bloqué : Marketing site (alice propriétaire) reste ouvert.
    expect((await c.listProjects()).projects.filter(isGatedProject)).toHaveLength(1);

    const { pair, call } = await login(c, "groups site-team", { connection: gated.sso.connection });
    const r = await call();
    expect(r.user).toBe("alice");
    expect(r.projects).toEqual([{ id: gated.id, role: "viewer" }]);
    // La session s'ouvre par le défi habituel, avec l'appareil SSO.
    const { challenge } = await c.requestSessionChallenge(r.device_id);
    await c.createSession({ device_id: r.device_id, challenge, signature: await signChallenge(pair.privateKey, challenge, "login") });
    expect((await c.listProjects()).projects.some(isGatedProject)).toBe(false);
    expect((await c.listProjectMembers(gated.id)).members.length).toBeGreaterThan(0);
  });

  it("callback : state à usage unique, lié à la clé du start, refus du fournisseur", async () => {
    const c = await boot(true);
    const a = await login(c, "groups site-team");
    expect(await fail(a.call(await generateDeviceKeyPair()))).toEqual({ status: 401, code: "binding_invalid" });
    expect(await fail(a.call())).toEqual({ status: 401, code: "invalid_state" }); // consommé même en échec
    expect(await fail(c.oidcCallback({ state: "inconnu", code: "x", signature: "x" }))).toEqual({ status: 401, code: "invalid_state" });
    const refused = await login(c, "Refuse");
    expect(await fail(refused.call())).toEqual({ status: 401, code: "idp_error" });
  });

  it.each([
    ["not verified", 403, "email_unverified"],
    ["other.example", 403, "domain_refused"],
    ["already linked", 409, "account_conflict"],
    ["suspended", 403, "account_inactive"],
    ["token", 401, "token_invalid"],
  ])("identité « %s » : %i %s", async (pick, status, code) => {
    const c = await boot(true);
    expect(await fail((await login(c, pick)).call())).toEqual({ status, code });
  });

  it("start : domaine non prouvé = connexion inconnue ; clé illisible refusée", async () => {
    const c = await boot(true);
    const pair = await generateDeviceKeyPair();
    expect(await fail(c.startOidc({ email: "x@other.example", public_key_spki: pair.publicKeySpkiB64Url }))).toEqual({ status: 404, code: "unknown_connection" });
    expect(await fail(c.startOidc({ email: "x@example.com", public_key_spki: "pas-une-cle" }))).toEqual({ status: 400, code: "invalid_key" });
  });

  it("groupes → rôles : le journal garde la connexion et le changement de rôle", async () => {
    const c = await boot(true);
    const sc = (await c.listSsoConnections()).connections[0]!.id;
    const r = await (await login(c, "groups site-team")).call();
    const site = (await c.listProjects()).projects.find((p) => p.name === "Marketing site")!;
    expect(r.projects).toEqual([{ id: site.id, role: "owner" }]); // le propriétaire n'est jamais touché
    const events = (await c.getSsoAudit(sc)).events.map((e) => e.event);
    expect(events[0]).toBe("login_ok");
    expect(JSON.stringify(await c.getSsoAudit(sc))).not.toMatch(/"(state|code|nonce)"/);
  });
});
