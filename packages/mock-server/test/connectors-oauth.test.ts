import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let c: NokkerClient;
const saved = { multi: process.env.MOCK_CONNECTORS_MULTI, oauth: process.env.MOCK_CONNECTORS_OAUTH, caps: process.env.MOCK_CAPABILITIES };
beforeEach(async () => {
  process.env.MOCK_CONNECTORS_MULTI = "1";
  process.env.MOCK_CONNECTORS_OAUTH = "1";
  process.env.MOCK_CAPABILITIES = "1";
  mock = await startMockServer({ speed: 0.01 });
  c = new NokkerClient({ baseUrl: mock.url });
  await c.demoSessionMockExtension();
});
afterEach(async () => {
  await mock.close();
  for (const [k, v] of [["MOCK_CONNECTORS_MULTI", saved.multi], ["MOCK_CONNECTORS_OAUTH", saved.oauth], ["MOCK_CAPABILITIES", saved.caps]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const code = (e: unknown): unknown => (e instanceof NokkerApiError ? (e.body as { error?: unknown })?.error : undefined);

/** Joue le faux fournisseur : page de consentement, puis callback ; rend l'adresse de retour (302). */
async function consent(url: string, decision: "allow" | "deny", granted: string[]): Promise<URL> {
  const page = await fetch(`${mock.url}${url}`);
  expect(page.status).toBe(200);
  const state = new URL(url, "http://x").searchParams.get("state")!;
  const q = new URLSearchParams({ state, decision });
  for (const g of granted) q.append("granted", g);
  const r = await fetch(`${mock.url}/v1/connectors/oauth/callback?${q}`, { redirect: "manual" });
  expect(r.status).toBe(302);
  return new URL(r.headers.get("location")!, "https://app.example");
}

describe("connexions OAuth (CONNECTORS-OAUTH, mock)", () => {
  it("presets seulement (OAuth éteint en prod) : fournisseurs listés éteints, capacité fausse", async () => {
    process.env.MOCK_CONNECTORS_OAUTH = "presets";
    const l = await c.listConnectorsMulti();
    expect(l.presets.oauth?.map((o) => [o.provider, o.enabled])).toEqual([["microsoft", false], ["google", false]]);
    expect(l.presets.kinds).toEqual(["mail", "calendar"]);
    expect((await c.getCapabilities()).features).toMatchObject({ connectors_oauth: false });
    expect(l.presets.mail_soon).toEqual(["outlook"]);
  });

  it("préréglages : natures, fournisseurs (Drive à part avec sélecteur), Outlook plus « bientôt »", async () => {
    const l = await c.listConnectorsMulti();
    expect(l.presets.kinds).toEqual(["mail", "calendar", "contacts", "files", "tasks"]);
    expect(l.presets.oauth?.filter((o) => o.provider === "google").map((o) => [o.services, !!o.picker])).toEqual([[["calendar", "contacts", "tasks"], false], [["files"], true]]);
    expect(l.presets.mail_soon).toEqual([]);
    expect((await c.getCapabilities()).features).toMatchObject({ connectors_multi: true, connectors_oauth: true });
  });

  it("Microsoft : un compte, trois services ; un décoché revient dans missing ; cartes oauth", async () => {
    const s = await c.startOAuth("microsoft", { services: ["mail", "calendar", "contacts"] });
    expect(s.url).toMatch(/^\/v1\/dev\/oauth\/authorize\?state=/);
    const back = await consent(s.url, "allow", ["mail", "calendar"]);
    expect(back.pathname).toBe("/account/connectors");
    expect(back.searchParams.get("oauth")).toBe("done");
    expect(back.searchParams.get("missing")).toBe("contacts");
    const oa = back.searchParams.get("account")!;
    expect(oa).toMatch(/^oa_[a-z2-9]{10}$/);
    const cards = (await c.listConnectorsMulti()).connectors.filter((x) => x.auth === "oauth");
    expect(cards.map((x) => [x.kind, x.provider, x.oauth_account?.id, x.oauth_account?.connectors])).toEqual([["mail", "microsoft", oa, 2], ["calendar", "microsoft", oa, 2]]);
    expect(cards[0]).toMatchObject({ label: "alex@outlook.example", default: true, settings: { address: "alex@outlook.example" } });
  });

  it("refus, Drive mélangé, fournisseur inconnu ; reconnect puis Reconnecter", async () => {
    const d = await consent((await c.startOAuth("google", { services: ["calendar"] })).url, "deny", []);
    expect([d.searchParams.get("oauth"), d.searchParams.get("code")]).toEqual(["error", "denied"]);
    expect(code(await c.startOAuth("google", { services: ["calendar", "files"] }).catch((e) => e))).toBe("bad_service");
    expect(code(await c.startOAuth("dropbox", { services: ["files"] }).catch((e) => e))).toBe("provider_off");
    const back = await consent((await c.startOAuth("google", { services: ["calendar", "tasks"] })).url, "allow", ["calendar", "tasks"]);
    const oa = back.searchParams.get("account")!;
    await fetch(`${mock.url}/v1/dev/connectors-mock`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ oauth_reconnect: oa }) });
    let mine = (await c.listConnectorsMulti()).connectors.filter((x) => x.oauth_account?.id === oa);
    expect(mine.map((x) => x.state)).toEqual(["reconnect", "reconnect"]);
    const r = await c.reconnectOAuth(oa);
    const again = await consent(r.url, "allow", ["calendar", "tasks"]);
    expect(again.searchParams.get("account")).toBe(oa);
    mine = (await c.listConnectorsMulti()).connectors.filter((x) => x.oauth_account?.id === oa);
    expect(mine.map((x) => x.state)).toEqual(["ok", "ok"]);
    expect(mine.length).toBe(2);
  });

  it("Drive : sélecteur (jeton drive.file), fichiers choisis, retrait ; supprimer le dernier service retire le compte", async () => {
    const back = await consent((await c.startOAuth("google", { services: ["files"] })).url, "allow", ["files"]);
    const drive = (await c.listConnectorsMulti()).connectors.find((x) => x.kind === "files")!;
    expect(drive).toMatchObject({ label: "Google Drive", provider: "google" });
    const g = await c.pickerGrant(drive.id);
    expect(g.expires_in).toBeLessThanOrEqual(600);
    expect(g.developer_key).toBe("mock-picker");
    expect((await c.addPickedFiles(drive.id, ["drv_facture", "drv_inconnu"])).files.map((f) => f.name)).toEqual(["Facture-2026-10.pdf"]);
    expect((await c.listPickedFiles(drive.id)).files).toHaveLength(1);
    await c.removePickedFile(drive.id, "drv_facture");
    expect((await c.listPickedFiles(drive.id)).files).toHaveLength(0);
    await c.deleteConnectorById(drive.id);
    const oa = back.searchParams.get("account")!;
    expect(code(await c.reconnectOAuth(oa).catch((e) => e))).toBe("not_found");
  });

  it("supprimer le compte OAuth retire tous ses connecteurs ; contacts iCloud sans OAuth", async () => {
    const back = await consent((await c.startOAuth("microsoft", { services: ["calendar", "tasks"] })).url, "allow", ["calendar", "tasks"]);
    await c.deleteOAuthAccount(back.searchParams.get("account")!);
    expect((await c.listConnectorsMulti()).connectors.filter((x) => x.auth === "oauth")).toEqual([]);
    const ct = await c.createConnector({ kind: "contacts" as never, settings: { mode: "icloud", username: "alex@icloud.example" } as never, secret: "x" });
    expect(ct).toMatchObject({ kind: "contacts", auth: "password", default: true });
    expect(ct.id).toMatch(/^ct_/);
  });
});
