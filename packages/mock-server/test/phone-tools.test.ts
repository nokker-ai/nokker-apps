import { afterEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { b64uEncode, NodeClient, NokkerClient, openSealedToken, type PhoneBeat, type PhoneRegistered, type PhoneTask } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
import { phoneMock, placeNode } from "../src/phone.js";

let mock: MockServerHandle;
afterEach(async () => {
  delete process.env.NOKKER_MOCK_PHONE_WAIT_MS;
  await mock.close();
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const beat = (o: { charging: boolean; net: "wifi" | "cellular"; ocr: "on" | "off" | "denied"; mode?: "home" | "pocket"; homeWifi?: boolean; lan?: "on" | "off" }): PhoneBeat => ({ v: 1, app_version: "0.1.0", os: "iOS 18.2", mode: o.mode ?? "pocket", reach: "live", power: { charging: o.charging, level: 0.5 }, net: { type: o.net, metered: o.net === "cellular", home_wifi: o.homeWifi ?? false }, caps: { location: "on", device_calendar: "on", ocr: o.ocr, stt: "off", lan_home: o.lan ?? "off" }, queue: { leased: 0 }, slm: null });
const dev = (path: string, body: object) => fetch(`${mock.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function phone(c: NokkerClient, name: string): Promise<{ node: NodeClient; id: string }> {
  const k = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const a = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const spki = b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", k.publicKey)));
  const enc = b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", a.publicKey)));
  const reg = await c.registerPhone({ name, platform: "ios", os_version: "18.2", app_version: "0.1.0", public_key_spki: spki, enc_key_spki: enc, key_storage: "software", attestation: null, push_token: null });
  await dev("/v1/dev/phone/approve", { approval_id: reg.approval_id });
  await new Promise((r) => setTimeout(r, 30));
  const r = (await c.phoneRegistration(reg.approval_id)) as PhoneRegistered;
  const token = await openSealedToken(a.privateKey, reg.approval_id, r.sealed_token, webcrypto as never);
  return { node: new NodeClient(mock.url, token, async (d) => new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, d))), id: r.machine_id };
}

async function nextTask(n: NodeClient): Promise<PhoneTask> {
  for (let i = 0; i < 40; i++) {
    const [t] = (await n.poll(1)).body.tasks;
    if (t) return t;
  }
  throw new Error("aucune tâche");
}

const ask = (c: NokkerClient, threadId: string, text: string, image = false) =>
  c.chatCompletion(threadId, [{ role: "user", content: image ? [{ type: "text", text: "voici" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] : text }]);

describe("outils du téléphone (P7b)", () => {
  it("placement par capacité : ocr à on seulement, en charge avant batterie, Wi-Fi avant cellulaire", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const a = await phone(c, "A");
    const b = await phone(c, "B");
    const z = await phone(c, "Z");
    await a.node.beat(beat({ charging: false, net: "cellular", ocr: "on" }));
    await b.node.beat(beat({ charging: false, net: "wifi", ocr: "on" }));
    await z.node.beat(beat({ charging: true, net: "wifi", ocr: "denied" })); // la meilleure, mais ocr refusé par l'OS
    const t = await c.createThread("Ticket");
    await ask(c, t.id, "", true);
    const first = ask(c, t.id, "lis le texte de l'image");
    const got = await nextTask(b.node); // Wi-Fi avant cellulaire, Z exclu
    expect(got.op).toBe("ocr.image");
    expect(String(got.args.image_url)).toMatch(/\/v1\/gateway\/phone\/blobs\//);
    await b.node.result(got.task_id, { status: "done", result: JSON.stringify({ text: "Total 12.50" }) });
    await first;
    let msgs = (await c.getThread(t.id)).messages;
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining("Total 12.50") });
    expect(msgs.at(-1)).not.toHaveProperty("phone_tasks");
    // En charge avant batterie : A passe devant B une fois branché.
    await a.node.beat(beat({ charging: true, net: "cellular", ocr: "on" }));
    const second = ask(c, t.id, "lis le texte de l'image");
    const g2 = await nextTask(a.node);
    await a.node.result(g2.task_id, { status: "done", result: JSON.stringify({ text: "" }) });
    await second;
    msgs = (await c.getThread(t.id)).messages;
    expect(msgs.at(-1)!.content).toContain("aucun texte");
  }, 20_000);

  it("au-delà de l'attente : phone_tasks pending, puis tour de suite phone_continue et état à jour ; échec aussi", async () => {
    process.env.NOKKER_MOCK_PHONE_WAIT_MS = "200";
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const p = await phone(c, "iPhone");
    await p.node.beat(beat({ charging: true, net: "wifi", ocr: "on" }));
    const t = await c.createThread("Lettre");
    await ask(c, t.id, "", true);
    const turn = ask(c, t.id, "lis le texte de l'image");
    const task = await nextTask(p.node);
    await turn; // l'attente est passée, le tour se termine sans résultat
    let msgs = (await c.getThread(t.id)).messages;
    const pending = msgs.at(-1)!;
    expect(pending.content).toContain("phone_pending");
    expect(pending.phone_tasks).toEqual([{ task_id: task.task_id, op: "ocr.image", machine_id: p.id, name: "iPhone", status: "pending" }]);
    await p.node.result(task.task_id, { status: "done", result: JSON.stringify({ text: "Facture 42" }) });
    for (let i = 0; i < 40 && (await c.getThread(t.id)).messages.length === msgs.length; i++) await new Promise((r) => setTimeout(r, 100));
    msgs = (await c.getThread(t.id)).messages;
    const cont = msgs.at(-2)!;
    expect(cont).toMatchObject({ role: "user", origin: "phone_continue" });
    expect(cont.content).toMatch(/^\[Téléphone\] Résultat de « texte d'une image »/);
    expect(msgs.at(-1)!.content).toContain("Facture 42");
    expect(msgs.find((m) => m.phone_tasks)?.phone_tasks?.[0]?.status).toBe("done");

    // Échec sur le téléphone : tour de suite « n'a pas abouti », état failed.
    const t2 = ask(c, t.id, "lis le texte de l'image");
    const k2 = await nextTask(p.node);
    await t2;
    const n = (await c.getThread(t.id)).messages.length;
    await p.node.result(k2.task_id, { status: "failed", error: { code: "bad_image" } });
    for (let i = 0; i < 40 && (await c.getThread(t.id)).messages.length === n; i++) await new Promise((r) => setTimeout(r, 100));
    msgs = (await c.getThread(t.id)).messages;
    expect(msgs.at(-2)!.content).toContain("n'a pas abouti");
    expect(msgs.filter((m) => m.phone_tasks).at(-1)?.phone_tasks?.[0]?.status).toBe("failed");
  }, 20_000);

  it("sans téléphone ocr en ligne, ou sans image : rien n'est mis en file", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const t = await c.createThread("Rien");
    await ask(c, t.id, "lis le texte de l'image");
    expect((await c.getThread(t.id)).messages.at(-1)!.content).toContain("ocr_no_image");
    await ask(c, t.id, "", true);
    await ask(c, t.id, "lis le texte de l'image");
    expect((await c.getThread(t.id)).messages.at(-1)!.content).toContain("phone_unavailable");
  });

  it("P10a : lan_home exige le Wi-Fi maison, mode home d'abord ; action sur la maison refusée à un nœud non attesté", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const pocket = await phone(c, "A-poche");
    const wall = await phone(c, "Z-tablette");
    const away = await phone(c, "B-ailleurs");
    await pocket.node.beat(beat({ charging: true, net: "wifi", ocr: "on", homeWifi: true, lan: "on" }));
    await wall.node.beat(beat({ charging: false, net: "wifi", ocr: "on", mode: "home", homeWifi: true, lan: "on" }));
    await away.node.beat(beat({ charging: true, net: "wifi", ocr: "on", mode: "home", homeWifi: false, lan: "on" })); // pas le Wi-Fi maison
    // Le nœud en mode maison passe avant le téléphone de poche, même sur batterie ; celui hors du Wi-Fi maison est exclu.
    const member = phoneMock(mock.state).nodes.get(wall.id)!.user;
    expect(placeNode(mock.state, member, "lan_home")?.id).toBe(wall.id);
    expect(placeNode(mock.state, member, "ocr")?.id).not.toBe(wall.id); // hors maison : en charge d'abord
    const r = await dev("/v1/dev/phone/task", { machine_id: wall.id, op: "ha.call_service", args: { domain: "light", service: "turn_on", entity_ids: ["light.salon"] } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("attestation_required");
    expect((await dev("/v1/dev/phone/task", { machine_id: wall.id, op: "ha.states", args: {} })).status).toBe(201);
  });
});
