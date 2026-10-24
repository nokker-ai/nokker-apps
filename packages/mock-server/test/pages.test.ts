import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient, generateDeviceKeyPair, signChallenge, type Bubble } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let client: NokkerClient;

beforeEach(async () => {
  mock = await startMockServer({ speed: 0.01 });
  client = new NokkerClient({ baseUrl: mock.url });
  const keys = await generateDeviceKeyPair();
  const dev = await client.enrollDevice({ name: "test", public_key_spki: keys.publicKeySpkiB64Url });
  const { challenge } = await client.requestSessionChallenge(dev.id);
  await client.createSession({ device_id: dev.id, challenge, signature: await signChallenge(keys.privateKey, challenge, "login") });
});
afterEach(async () => {
  await mock.close();
});

async function newPage(): Promise<{ thread: string; bubble: Bubble; pageId: string }> {
  const thread = (await client.createThread("Pages")).id;
  await client.chatCompletion(thread, [{ role: "user", content: "crée une page tarifs d'automne" }]);
  await new Promise((r) => setTimeout(r, 100));
  const bubble = (await client.listBubbles(thread)).find((b) => b.kind === "artifact")!;
  return { thread, bubble, pageId: (bubble.state as { page_id: string }).page_id };
}

describe("pages (BUBBLES.md §10)", () => {
  it("« crée une page » ouvre une bulle artifact privée, sans HTML dans le state", async () => {
    const { bubble, pageId } = await newPage();
    expect(pageId).toMatch(/^pg_[0-9a-f]{16}$/);
    expect(bubble.state).toMatchObject({ path: "tarifs-d-automne.html", title: "Tarifs d'automne", mime: "text/html", version: 1, public: false });
    expect(JSON.stringify(bubble.state)).not.toContain("<html");
    expect(bubble.actions.map((a) => a.id)).toEqual(["publish"]);
  });

  it("une page privée est 404 sans preuve, servie sous CSP sandbox avec un lien signé", async () => {
    const { pageId } = await newPage();
    expect((await fetch(`${mock.url}/v1/pages/${pageId}`)).status).toBe(404);
    const link = await client.getPageLink(pageId, { embed: true });
    expect(Date.parse(link.expires_at)).toBeGreaterThan(Date.now());
    const res = await fetch(client.resolveUrl(link.url)!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
    expect(await res.text()).toContain("Tarifs d'automne");
    const tampered = new URL(client.resolveUrl(link.url)!);
    tampered.searchParams.set("sig", "0".repeat(32));
    expect((await fetch(tampered)).status).toBe(404);
  });

  it("un lien signé d'une autre page ne vaut rien", async () => {
    const a = await newPage();
    const b = await newPage();
    const link = new URL(client.resolveUrl((await client.getPageLink(a.pageId)).url)!);
    link.pathname = link.pathname.replace(a.pageId, b.pageId);
    expect((await fetch(link)).status).toBe(404);
  });

  it("« modifie la page » publie une nouvelle version dans la bulle", async () => {
    const { thread, bubble } = await newPage();
    await client.chatCompletion(thread, [{ role: "user", content: "modifie la page" }]);
    await new Promise((r) => setTimeout(r, 200));
    const after = await client.getBubble(bubble.id);
    expect(after.status).toBe("done");
    expect((after.state as { version: number }).version).toBe(2);
    expect(after.version).toBeGreaterThan(bubble.version);
  });

  it("publier rend la page lisible sans preuve, dépublier la referme", async () => {
    const { bubble, pageId } = await newPage();
    await client.bubbleAction(bubble.id, "publish");
    await new Promise((r) => setTimeout(r, 300));
    const pub = await client.getBubble(bubble.id);
    expect((pub.state as { public: boolean }).public).toBe(true);
    expect(pub.actions.map((a) => a.id)).toEqual(["unpublish"]);
    expect((await fetch(`${mock.url}/v1/pages/${pageId}`)).status).toBe(200);
    expect((await client.getPageLink(pageId)).public_url).toBe(`/v1/pages/${pageId}`);
    await client.bubbleAction(bubble.id, "unpublish");
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`${mock.url}/v1/pages/${pageId}`)).status).toBe(404);
  });

  it("télécharger : pièce jointe par lien signé download seulement ; pas d'adresse publique d'une page privée", async () => {
    const { pageId } = await newPage();
    const link = await client.getPageLink(pageId, { download: true });
    expect(link.public_url).toBeUndefined();
    const res = await fetch(client.resolveUrl(link.url)!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.html"$/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const view = new URL(client.resolveUrl((await client.getPageLink(pageId)).url)!);
    expect((await fetch(view)).headers.get("content-disposition")).toBeNull();
    view.searchParams.set("dl", "1");
    expect((await fetch(view)).status).toBe(404);
  });
});
