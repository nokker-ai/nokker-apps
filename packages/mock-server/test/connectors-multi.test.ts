import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient, NokkerApiError } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
const prev = process.env.MOCK_CONNECTORS_MULTI;
beforeEach(async () => {
  process.env.MOCK_CONNECTORS_MULTI = "1";
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
});
afterEach(async () => {
  await mock.close();
  if (prev === undefined) delete process.env.MOCK_CONNECTORS_MULTI;
  else process.env.MOCK_CONNECTORS_MULTI = prev;
});

const status = (e: unknown): number | undefined => (e instanceof NokkerApiError ? e.status : undefined);
const code = (e: unknown): unknown => (e instanceof NokkerApiError ? (e.body as { error?: unknown })?.error : undefined);

describe("connecteurs multiples (CONNECTORS-MULTI.md)", () => {
  it("liste : partagée avec moi, membres, préréglages (aide, régions, bientôt)", async () => {
    const l = await c.listConnectorsMulti();
    expect(l.connectors).toEqual([expect.objectContaining({ id: "mb_c8w2m4p6zt", access: "read", default: false, owner: { account_id: "ac_camille", name: "camille" }, settings: { address: "camille@example.org" } })]);
    expect(l.members).toEqual([{ account_id: "ac_camille", name: "camille", minor: false }, { account_id: "ac_sam", name: "sam", minor: true }]);
    expect(l.presets.mail).toContain("bluewin");
    expect(l.presets.mail_soon).toEqual(["outlook"]);
    expect(l.presets.mail_regions).toEqual({ zoho: ["eu", "com"] });
    expect(l.presets.mail_help?.bluewin?.fr).toMatch(/ton Swisscom Login/);
  });

  it("ajout : le premier est le défaut, libellé = adresse, libellé pris / en forme d'id refusé", async () => {
    const a = await c.createConnector({ kind: "mail", settings: { preset: "gmail", address: "alex@example.org" }, secret: "x" });
    expect(a).toMatchObject({ kind: "mail", label: "alex@example.org", default: true, access: "owner", grants: [] });
    expect(a.id).toMatch(/^mb_[a-z2-9]{10}$/);
    const b = await c.createConnector({ kind: "mail", label: "perso", settings: { preset: "bluewin", address: "alex@bluewin.example" }, secret: "x" });
    expect(b.default).toBe(false);
    expect(code(await c.createConnector({ kind: "mail", label: "PERSO", settings: { preset: "gmail", address: "z@example.org" }, secret: "x" }).catch((e) => e))).toBe("label_taken");
    expect(code(await c.createConnector({ kind: "mail", label: "mb_7f3k2q9xa4", settings: { preset: "gmail", address: "z@example.org" }, secret: "x" }).catch((e) => e))).toBe("bad_label");
    for (const bad of ["a/b", "a|b", "a·b", "x".repeat(41)]) expect(code(await c.createConnector({ kind: "mail", label: bad, settings: { preset: "gmail", address: "z@example.org" }, secret: "x" }).catch((e) => e))).toBe("bad_label");
    expect(code(await c.createConnector({ kind: "mail", settings: { preset: "outlook", address: "z@example.org" }, secret: "x" }).catch((e) => e))).toBe("unsupported");
    expect(status(await c.createConnector({ kind: "mail", settings: { preset: "gmail", address: "z@example.org" }, secret: "bad" }).catch((e) => e))).toBe(422);
    const cal = await c.createConnector({ kind: "calendar", settings: { mode: "ical", label: "École" }, secret: "https://cal.example/x.ics" });
    expect(cal).toMatchObject({ label: "Agenda", default: true });
  });

  it("renommer, défaut, supprimer (le plus ancien restant devient le défaut)", async () => {
    const a = await c.createConnector({ kind: "mail", settings: { preset: "gmail", address: "alex@example.org" }, secret: "x" });
    const b = await c.createConnector({ kind: "mail", label: "perso", settings: { preset: "gmail", address: "p@example.org" }, secret: "x" });
    expect((await c.patchConnector(a.id, { label: "pro" })).label).toBe("pro");
    expect((await c.patchConnector(b.id, { default: true })).default).toBe(true);
    expect((await c.listConnectorsMulti()).connectors.find((x) => x.id === a.id)?.default).toBe(false);
    await c.deleteConnectorById(b.id);
    expect((await c.listConnectorsMulti()).connectors.find((x) => x.id === a.id)?.default).toBe(true);
    expect(status(await c.deleteConnectorById("mb_inconnu000").catch((e) => e))).toBe(404);
  });

  it("partage : carte forte en attente, visible ; même demande = même carte ; monter = carte, descendre = immédiat", async () => {
    const a = await c.createConnector({ kind: "mail", label: "pro", settings: { preset: "gmail", address: "alex@example.org" }, secret: "x" });
    const r = await c.grantConnector(a.id, "ac_sam", "read");
    expect(r).toMatchObject({ status: "pending", approval_id: expect.any(String) });
    const again = await c.grantConnector(a.id, "ac_sam", "read");
    expect(again).toEqual(r);
    const ap = await c.getApproval((r as { approval_id: string }).approval_id);
    expect(ap).toMatchObject({ strength: "strong", tool_name: "connector_grant", rule: "connector:grant", status: "pending", arguments: { connector_id: a.id, grantee: "ac_sam", grantee_email: "sam@example.org", level: "read" } });
    expect(ap.reason).toMatch(/sam \(sam@example.org, profil mineur\).*lecture.*« pro » — alex@example.org/);
    let g = (await c.listConnectorsMulti()).connectors.find((x) => x.id === a.id)!.grants!;
    expect(g).toEqual([expect.objectContaining({ account_id: "ac_sam", name: "sam", minor: true, level: "read", status: "pending" })]);
    await fetch(`${mock.url}/v1/dev/connectors-mock`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ approve: "all" }) });
    g = (await c.listConnectorsMulti()).connectors.find((x) => x.id === a.id)!.grants!;
    expect(g[0]).toMatchObject({ level: "read", status: "active", granted_at: expect.any(String) });
    expect(await c.grantConnector(a.id, "ac_sam", "read")).toEqual({ status: "unchanged" });
    expect((await c.grantConnector(a.id, "ac_sam", "send")).status).toBe("pending");
    g = (await c.listConnectorsMulti()).connectors.find((x) => x.id === a.id)!.grants!;
    expect(g[0]).toMatchObject({ level: "read", status: "active", pending_level: "send" });
    await fetch(`${mock.url}/v1/dev/connectors-mock`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ approve: "all" }) });
    expect(await c.grantConnector(a.id, "ac_sam", "read")).toEqual({ status: "updated" });
    // Montée en attente puis retour au niveau actif : la demande tombe (unchanged), sa carte est retirée.
    const up = (await c.grantConnector(a.id, "ac_sam", "send")) as { approval_id: string };
    expect(await c.grantConnector(a.id, "ac_sam", "read")).toEqual({ status: "unchanged" });
    expect((await c.getApproval(up.approval_id)).status).not.toBe("pending");
    g = (await c.listConnectorsMulti()).connectors.find((x) => x.id === a.id)!.grants!;
    expect(g[0]).toMatchObject({ level: "read", status: "active" });
    expect(g[0]).not.toHaveProperty("pending_level");
    expect(code(await c.grantConnector(a.id, "ac_sam", "write").catch((e) => e))).toBe("bad_level");
    expect(code(await c.grantConnector(a.id, "ac_inconnu", "read").catch((e) => e))).toBe("not_household_member");
    await c.revokeConnectorGrant(a.id, "ac_sam");
    expect((await c.listConnectorsMulti()).connectors.find((x) => x.id === a.id)!.grants).toEqual([]);
  });

  it("partagée avec moi : pas de gestion (not_owner), je retire mon accès avec « me »", async () => {
    const id = "mb_c8w2m4p6zt";
    expect(code(await c.patchConnector(id, { label: "x" }).catch((e) => e))).toBe("not_owner");
    expect(code(await c.grantConnector(id, "ac_sam", "read").catch((e) => e))).toBe("not_owner");
    expect(code(await c.revokeConnectorGrant(id, "ac_sam").catch((e) => e))).toBe("not_owner");
    expect(await c.revokeConnectorGrant(id, "me")).toEqual({ revoked: true });
    expect((await c.listConnectorsMulti()).connectors).toEqual([]);
  });
});
