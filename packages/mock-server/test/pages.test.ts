import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NokkerClient, generateDeviceKeyPair, signChallenge, type Bubble, type NokkerEvent } from "@nokker-apps/sdk";
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
    expect(bubble.actions.map((a) => a.id)).toEqual([]); // publier est un geste du client (BUBBLES §10.4)
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

  it("réécriture en direct (X22) : state.writing pendant le write_file, deltas du HTML, puis recalage sans writing", async () => {
    const { thread, bubble } = await newPage();
    const seen: NokkerEvent[] = [];
    const sub = client.subscribeEvents({ onEvent: (e) => seen.push(e) });
    await new Promise((r) => setTimeout(r, 100));
    await client.chatCompletion(thread, [{ role: "user", content: "modifie la page" }]);
    await new Promise((r) => setTimeout(r, 300));
    sub.close();
    const updates = seen.filter((e) => e.type === "bubble.updated" && e.bubble.id === bubble.id) as Array<Extract<NokkerEvent, { type: "bubble.updated" }>>;
    const writing = (updates[0]!.bubble.state as { writing?: { call_id: string; name: string } }).writing;
    expect(updates[0]!.bubble.status).toBe("working");
    expect(writing?.name).toBe("write_file");
    const deltas = seen.filter((e) => e.type === "tool.input.delta" && e.call_id === writing!.call_id) as Array<Extract<NokkerEvent, { type: "tool.input.delta" }>>;
    expect(deltas.map((d) => d.text).join("")).toContain("Version <b>2</b>");
    expect(deltas.every((d) => d.path === "tarifs-d-automne.html" && d.field === "content")).toBe(true);
    const last = updates.at(-1)!.bubble;
    expect(last.status).toBe("done");
    expect((last.state as { writing?: unknown; version: number }).writing).toBeUndefined();
    expect((last.state as { version: number }).version).toBe(2);
    expect(seen.some((e) => e.type === "tool.result" && e.call_id === writing!.call_id)).toBe(true);
  });

  it("publier passe par une carte forte ; publiée, la page se lit par son id public seulement ; dépublier tue l'URL", async () => {
    const { bubble, pageId } = await newPage();
    expect(bubble.actions.map((a) => a.id)).not.toContain("publish"); // geste du client, pas une action de la bulle
    const req = await client.publishPage(pageId, { index: false });
    expect(req).toMatchObject({ strength: "strong", rule: "pages:publish", version: 1 });
    expect((await client.getBubble(bubble.id)).state).toMatchObject({ public: false });
    const dev = (b: unknown) => fetch(`${mock.url}/v1/dev/pages-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await dev({ approve: req.approval_id });
    expect((await client.getBubble(bubble.id)).state).toMatchObject({ public: true, public_version: 1, public_index: false });
    expect((await fetch(`${mock.url}/v1/pages/${pageId}`)).status).toBe(404); // jamais par le page_id sans preuve
    const link = await client.getPageLink(pageId);
    expect(link.public_url).toMatch(/^\/v1\/pages\/public\/[A-Za-z0-9_-]{24}$/);
    expect(link.public_url).not.toContain(pageId);
    const res = await fetch(`${mock.url}${link.public_url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await client.unpublishPage(pageId)).toEqual({ page_id: pageId, public: false, purge: "done" });
    expect((await fetch(`${mock.url}${link.public_url}`)).status).toBe(404);
    expect((await client.getBubble(bubble.id)).state).toMatchObject({ public: false, public_version: null });
  });

  it("publication : page épinglée local refusée (409), compte sans droit (403), refus de la carte", async () => {
    const { bubble, pageId } = await newPage();
    const fail = (p: Promise<unknown>) => p.then(() => null, (e: { status: number; body: { error: { code?: string } } }) => [e.status, e.body.error.code]);
    await fetch(`${mock.url}/v1/dev/pages-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages_public: false }) });
    expect(await fail(client.publishPage(pageId))).toEqual([403, "pages_public_not_allowed"]);
    await fetch(`${mock.url}/v1/dev/pages-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages_public: true }) });
    const req = await client.publishPage(pageId);
    await fetch(`${mock.url}/v1/dev/pages-mock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reject: req.approval_id }) });
    expect((await client.getBubble(bubble.id)).state).toMatchObject({ public: false });
    expect((await client.setPageLocality(pageId, "local")).locality).toBe("local");
    expect(await fail(client.publishPage(pageId))).toEqual([409, "local_page"]);
    expect((await client.getBubble(bubble.id)).state).toMatchObject({ locality: "local" });
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
