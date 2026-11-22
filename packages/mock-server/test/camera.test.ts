import { afterEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { b64uEncode, NodeClient, NokkerApiError, NokkerClient, openSealedToken, type PhoneBeat, type PhoneRegistered, type PhoneTask } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";
import { phoneMock } from "../src/phone.js";

let mock: MockServerHandle;
afterEach(async () => {
  delete process.env.NOKKER_MOCK_CAMERA_WAIT_MS;
  await mock.close();
});
const code = (e: unknown) => ({ status: (e as NokkerApiError).status, code: ((e as NokkerApiError).body as { error?: { code?: string } })?.error?.code });
const BEAT: PhoneBeat = { v: 1, app_version: "0.1.0", os: "iOS 18.2", mode: "home", reach: "live", power: { charging: true, level: 1 }, net: { type: "wifi", metered: false, home_wifi: true }, caps: { location: "on", device_calendar: "off", ocr: "on", stt: "off", camera: "on" }, queue: { leased: 0 }, slm: null };
const dev = (path: string, body: object) => fetch(`${mock.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function phone(c: NokkerClient) {
  const k = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const a = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const reg = await c.registerPhone({ name: "Tablette", platform: "ios", os_version: "18.2", app_version: "0.1.0", public_key_spki: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", k.publicKey))), enc_key_spki: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", a.publicKey))), key_storage: "software", attestation: null, push_token: null });
  await dev("/v1/dev/phone/approve", { approval_id: reg.approval_id });
  await new Promise((r) => setTimeout(r, 30));
  const r = (await c.phoneRegistration(reg.approval_id)) as PhoneRegistered;
  const token = await openSealedToken(a.privateKey, reg.approval_id, r.sealed_token, webcrypto as never);
  return { node: new NodeClient(mock.url, token, async (d) => new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, d))), id: r.machine_id };
}
async function next(n: NodeClient): Promise<PhoneTask> {
  for (let i = 0; i < 40; i++) {
    const [t] = (await n.poll(1)).body.tasks;
    if (t) return t;
  }
  throw new Error("aucune tâche");
}
const ev = { id: "cam_1", camera: "Entrée", start: 1762430000, end: 1762430010, severity: "detection", niveau: "inconnu", title: "personne", summary: null, objects: ["person"], zones: [], has_thumb: true, extra: "ignoré", face: "jamais" };

describe("caméra de veille (P10c), routes du titulaire", () => {
  it("événements à la demande (champs sur liste blanche) ; vignette : url + clé, jamais gardées ; codes", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const p = await phone(c);
    // Hors ligne (pas de battement) : 409.
    expect(code(await c.phoneCameraEvents(p.id, 0).catch((e) => e))).toEqual({ status: 409, code: "node_offline" });
    await p.node.beat(BEAT);
    const evs = c.phoneCameraEvents(p.id, 100);
    const t = await next(p.node);
    expect(t).toMatchObject({ op: "camera.watch_event", args: { after: 100, limit: 200 } });
    await p.node.result(t.task_id, { status: "done", result: JSON.stringify({ items: [ev], now: 1762430100 }) });
    const got = await evs;
    expect(got.items).toEqual([{ id: "cam_1", camera: "Entrée", start: 1762430000, end: 1762430010, severity: "detection", niveau: "inconnu", title: "personne", summary: null, objects: ["person"], zones: [], has_thumb: true }]);
    // Vignette : url + clé rendues au titulaire, puis plus rien dans la tâche.
    const th = c.phoneCameraThumb(p.id, "cam_1");
    const t2 = await next(p.node);
    expect(t2).toMatchObject({ op: "camera.thumb_url", args: { id: "cam_1" } });
    await p.node.result(t2.task_id, { status: "done", result: JSON.stringify({ id: "cam_1", url: `http://192.168.1.40:8802/t/${"A".repeat(32)}`, key: "K".repeat(43), expires_in: 900 }) });
    expect(await th).toEqual({ id: "cam_1", url: `http://192.168.1.40:8802/t/${"A".repeat(32)}`, key: "K".repeat(43), expires_in: 300 });
    expect(phoneMock(mock.state).tasks.get(t2.task_id)?.result).toBeUndefined();
    // Codes du nœud : 410 thumb_gone, 404 not_found, 502 avec le code.
    for (const [c2, want] of [["thumb_gone", { status: 410, code: "thumb_gone" }], ["not_found", { status: 404, code: "not_found" }], ["not_home_wifi", { status: 502, code: "not_home_wifi" }]] as const) {
      const pr = c.phoneCameraThumb(p.id, "cam_1").catch((e) => e);
      const tk = await next(p.node);
      await p.node.result(tk.task_id, { status: "failed", error: { code: c2 } });
      expect(code(await pr)).toEqual(want);
    }
    expect(code(await c.phoneCameraThumb(p.id, "../x").catch((e) => e))).toEqual({ status: 400, code: "bad_request" });
    expect(code(await c.phoneCameraEvents("mc_ph_inconnu").catch((e) => e))).toEqual({ status: 404, code: "not_found" });
  }, 20_000);

  it("le nœud ne répond pas : 504", async () => {
    process.env.NOKKER_MOCK_CAMERA_WAIT_MS = "300";
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const p = await phone(c);
    await p.node.beat(BEAT);
    expect(code(await c.phoneCameraEvents(p.id).catch((e) => e))).toEqual({ status: 504, code: "phone_timeout" });
  });
});

describe("découverte du réseau local (P10d), route du titulaire", () => {
  it("à la demande par la file ; types en liste ; nom neutralisé ; adresse ou TXT refusés ; hors Wi-Fi maison : 409", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const p = await phone(c);
    await p.node.beat({ ...BEAT, net: { ...BEAT.net, home_wifi: false } });
    expect(code(await c.phoneLanServices(p.id).catch((e) => e))).toEqual({ status: 409, code: "node_offline" });
    await p.node.beat(BEAT);
    expect(code(await c.phoneLanServices(p.id, ["_ssh._tcp"]).catch((e) => e))).toEqual({ status: 400, code: "bad_op" });
    const pr = c.phoneLanServices(p.id, ["_googlecast._tcp", "_raop._tcp"]);
    const t = await next(p.node);
    expect(t).toMatchObject({ op: "lan.discover", args: { types: ["_googlecast._tcp", "_raop._tcp"], timeout_s: 3 } });
    await p.node.result(t.task_id, { status: "done", result: JSON.stringify({ services: [{ id: "a1", type: "_googlecast._tcp", name: "TV <b>Salon</b>" }], at: "2026-11-06T14:00:00Z" }) });
    expect(await pr).toEqual({ services: [{ id: "a1", types: ["_googlecast._tcp"], name: "TV Salon" }], at: "2026-11-06T14:00:00Z" });
    const bad = c.phoneLanServices(p.id).catch((e) => e);
    const t2 = await next(p.node);
    await p.node.result(t2.task_id, { status: "done", result: JSON.stringify({ services: [{ id: "a2", type: "_sonos._tcp", name: "Cuisine", ip: "192.168.1.9" }] }) });
    expect(code(await bad)).toEqual({ status: 502, code: "bad_result" });
  }, 20_000);
});
