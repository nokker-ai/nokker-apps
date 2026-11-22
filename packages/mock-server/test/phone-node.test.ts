import { afterEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { b64uEncode, keyFingerprint, NodeClient, openSealedToken, NokkerApiError, NokkerClient, type PhoneBeat, type PhoneRegistered } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
afterEach(async () => {
  await mock.close();
});
const code = (e: unknown): unknown => ((e as NokkerApiError).body as { error?: { code?: string } })?.error?.code;
const BEAT: PhoneBeat = { v: 1, app_version: "0.1.0", os: "iOS 18.2", mode: "pocket", reach: "live", power: { charging: true, level: 0.8 }, net: { type: "wifi", metered: false, home_wifi: true }, caps: { location: "on", device_calendar: "on", ocr: "on", stt: "off" }, queue: { leased: 0 }, slm: null };

async function keyPair() {
  const k = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", k.publicKey)));
  const sign = async (d: Uint8Array) => new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, d));
  const agree = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const encSpki = b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", agree.publicKey)));
  return { spki, sign, encSpki, agree };
}
type Keys = Awaited<ReturnType<typeof keyPair>>;
/** Ce que fait le natif : ouvrir le sceau avec sa clé privée d'accord. */
async function claim(c: NokkerClient, k: Keys, approvalId: string): Promise<{ machine_id: string; machine_token: string; raw: PhoneRegistered }> {
  const raw = (await c.phoneRegistration(approvalId)) as PhoneRegistered;
  return { machine_id: raw.machine_id, machine_token: await openSealedToken(k.agree.privateKey, approvalId, raw.sealed_token, webcrypto as never), raw };
}
const dev = (path: string, body: object) => fetch(`${mock.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function enroll(c: NokkerClient, k: Keys, name = "iPhone de test") {
  const reg = await c.registerPhone({ name, platform: "ios", os_version: "18.2", app_version: "0.1.0", public_key_spki: k.spki, enc_key_spki: k.encSpki, key_storage: "software", attestation: null, push_token: null });
  return reg;
}

describe("nœud téléphone (P7, phase S)", () => {
  it("inscription par carte forte (nom + empreinte), jeton rendu une fois, autre appareil exigé", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const k = await keyPair();
    const { spki } = k;
    const reg = await enroll(c, k);
    expect(reg.key_fingerprint).toBe(await keyFingerprint(spki));
    expect(reg.key_fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const card = await c.getApproval(reg.approval_id);
    expect(card).toMatchObject({ tool_name: "phone_register", strength: "strong", arguments: { name: "iPhone de test", key_fingerprint: reg.key_fingerprint, attested: false } });
    expect(await c.phoneRegistration(reg.approval_id)).toEqual({ status: "pending" });
    expect((await dev("/v1/dev/phone/approve", { approval_id: reg.approval_id })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    const got = await claim(c, k, reg.approval_id);
    expect(got.machine_id).toMatch(/^mc_ph_/);
    expect(got.machine_token).toMatch(/^mt_/);
    // Le jeton ne passe jamais en clair : la réponse ne porte que le sceau.
    expect(JSON.stringify(got.raw)).not.toContain(got.machine_token);
    expect(got.raw).not.toHaveProperty("machine_token");
    expect(got.raw.sealed_token).toMatchObject({ v: 1, epk: { kty: "EC", crv: "P-256" } });
    expect(got.raw.caps_allowed).toContain("ocr");
    // Une autre clé d'accord ne l'ouvre pas ; un autre approval_id (données associées) non plus.
    const stranger = await keyPair();
    await expect(openSealedToken(stranger.agree.privateKey, reg.approval_id, got.raw.sealed_token, webcrypto as never)).rejects.toBeTruthy();
    await expect(openSealedToken(k.agree.privateKey, "appr_autre", got.raw.sealed_token, webcrypto as never)).rejects.toBeTruthy();
    // Une seule liste « mes machines » : le téléphone y est, kind phone, sans passerelle.
    const mine = (await c.listMachines()).machines.find((x) => x.machine_id === got.machine_id);
    expect(mine).toMatchObject({ kind: "phone", host: "", name: "iPhone de test", last_seen_at: null });
    expect(code(await c.phoneRegistration(reg.approval_id).catch((e) => e))).toBe("gone");
    // Refus sur l'autre appareil → 403 rejected.
    const r2 = await enroll(c, await keyPair(), "iPad");
    await dev("/v1/dev/phone/approve", { approval_id: r2.approval_id, decision: "reject" });
    expect(code(await c.phoneRegistration(r2.approval_id).catch((e) => e))).toBe("rejected");
    // Champs : inconnus, attestation, nom.
    const base = { name: "x", platform: "ios", os_version: "1", app_version: "1", public_key_spki: spki, enc_key_spki: k.encSpki, key_storage: "software", attestation: null, push_token: null } as const;
    expect(code(await c.registerPhone({ ...base, enc_key_spki: "AAAA" }).catch((e) => e))).toBe("bad_enc_key");
    expect(code(await c.registerPhone({ ...base, extra: 1 } as never).catch((e) => e))).toBe("unknown_field");
    expect(code(await c.registerPhone({ ...base, attestation: "abc" } as never).catch((e) => e))).toBe("attestation_unsupported");
    expect(code(await c.registerPhone({ ...base, public_key_spki: "AAAA" }).catch((e) => e))).toBe("bad_public_key");
    await dev("/v1/dev/phone/flags", { unattested: false });
    expect(code(await c.registerPhone(base).catch((e) => e))).toBe("attestation_required");
  });

  it("preuve : signature, hôte, horloge, nonce rejoué, corps modifié ; battement ; file ; bail ; résultat idempotent", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const k = await keyPair();
    const reg = await enroll(c, k);
    await dev("/v1/dev/phone/approve", { approval_id: reg.approval_id });
    await new Promise((r) => setTimeout(r, 30));
    const { machine_id, machine_token } = await claim(c, k, reg.approval_id);
    const node = new NodeClient(mock.url, machine_token, k.sign);
    expect(await node.beat(BEAT)).toMatchObject({ status: 200, body: { ok: true, state: "live" } });
    expect((await node.beat({ ...BEAT, reach: "push" })).body).toMatchObject({ error: { code: "push_unavailable" } });
    // Autre clé, même jeton → 401.
    const other = new NodeClient(mock.url, machine_token, (await keyPair()).sign);
    expect((await other.beat(BEAT)).status).toBe(401);
    // Horloge à 2 min.
    expect((await node.call("POST", "/v1/gateway/phone/beat", BEAT, { ts: Math.floor(Date.now() / 1000) - 120 })).status).toBe(401);
    // Nonce rejoué.
    const nonce = b64uEncode(webcrypto.getRandomValues(new Uint8Array(16)));
    expect((await node.call("POST", "/v1/gateway/phone/beat", BEAT, { nonce })).status).toBe(200);
    expect((await node.call("POST", "/v1/gateway/phone/beat", BEAT, { nonce })).body).toMatchObject({ error: { code: "proof_invalid" } });
    // Preuve signée pour un AUTRE hôte puis présentée ici → 401 (l'hôte fait partie de la chaîne signée).
    const elsewhere = new NodeClient(mock.url.replace("127.0.0.1", "autre.example.test"), machine_token, k.sign, (u, init) => fetch(String(u).replace("autre.example.test", "127.0.0.1"), init));
    expect((await elsewhere.beat(BEAT)).status).toBe(401);
    // Corps modifié après signature.
    const tampered = new NodeClient(mock.url, machine_token, k.sign, (url, init) => fetch(url, { ...init, body: JSON.stringify({ ...BEAT, mode: "home" }) }));
    expect((await tampered.beat(BEAT)).status).toBe(401);

    // Long poll vide puis réveillé par une tâche.
    const empty = await node.poll(0);
    expect(empty.body.tasks).toEqual([]);
    const waiting = node.poll(5);
    await new Promise((r) => setTimeout(r, 100));
    const q = await dev("/v1/dev/phone/task", { op: "zone.state", args: { zone_id: "zn_maison01" } });
    expect(q.status).toBe(201);
    const polled = await waiting;
    expect(polled.body.tasks).toHaveLength(1);
    const t = polled.body.tasks[0]!;
    expect(t).toMatchObject({ op: "zone.state", args: { zone_id: "zn_maison01" }, heavy: false });
    expect(t.args_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await node.lease(t.task_id)).status).toBe(200);
    expect((await node.result(t.task_id, { status: "done", result: JSON.stringify({ inside: true, since: "2026-11-06T08:00:00Z" }) })).body).toEqual({ stored: true });
    expect((await node.result(t.task_id, { status: "done", result: JSON.stringify({ inside: true, since: "2026-11-06T08:00:00Z" }) })).body).toEqual({ stored: false });
    expect((await node.result(t.task_id, { status: "done", result: "{}" })).status).toBe(409);
    expect((await fetch(`${mock.url}/v1/dev/phone/task/${t.task_id}`).then((r) => r.json())).status).toBe("done");
    // Résultat trop gros.
    const big = await dev("/v1/dev/phone/task", { op: "zone.state", args: { zone_id: "zn_maison01" } });
    const [bt] = (await node.poll(0)).body.tasks;
    expect(bt!.task_id).toBe(big.body.task_id);
    expect((await node.result(bt!.task_id, { status: "done", result: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    expect(code({ body: (await node.result(bt!.task_id, { status: "failed", error: { code: "denied" } })).body })).toBeUndefined();
    // Journal côté membre, sans contenu.
    const log = await c.phoneTasks(machine_id);
    expect(log.tasks.map((x) => x.status).sort()).toEqual(["done", "failed"]);
    expect(JSON.stringify(log)).not.toContain("inside");
    expect((await c.listPhones()).phones[0]).toMatchObject({ machine_id, live: true, key_fingerprint: reg.key_fingerprint });
    // Révocation : le jeton ne vaut plus rien.
    await c.revokeMachine(machine_id);
    expect((await node.beat(BEAT)).status).toBe(401);
  });

  it("blob signé : usage unique, lié au nœud (403 pour une autre machine) ; P8 passe par la file", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const nodes: NodeClient[] = [];
    for (const name of ["iPhone A", "iPhone B"]) {
      const k = await keyPair();
      const reg = await enroll(c, k, name);
      await dev("/v1/dev/phone/approve", { approval_id: reg.approval_id });
      await new Promise((r) => setTimeout(r, 30));
      nodes.push(new NodeClient(mock.url, (await claim(c, k, reg.approval_id)).machine_token, k.sign));
    }
    const [a, b] = nodes as [NodeClient, NodeClient];
    await b.beat(BEAT);
    const ids = (await c.listPhones()).phones;
    const aId = ids.find((p) => p.name === "iPhone A")!.machine_id;
    const png = "data:image/png;base64," + Buffer.from("PNGDATA").toString("base64");
    await dev("/v1/dev/phone/task", { machine_id: aId, op: "ocr.image", image: png });
    const [t] = (await a.poll(0)).body.tasks;
    const url = new URL(String(t!.args.image_url));
    expect((await b.call("GET", url.pathname)).status).toBe(403);
    const ok = await a.fetchImpl(url.toString(), { headers: {} }).catch(() => null);
    expect(ok?.status).toBe(401); // sans preuve
    const signed = await fetch(url, { headers: await proofHeaders(a, "GET", url.pathname) });
    expect(signed.status).toBe(200);
    expect(Buffer.from(await signed.arrayBuffer()).toString()).toBe("PNGDATA");
    expect((await a.call("GET", url.pathname)).status).toBe(410);
    expect((await dev("/v1/dev/phone/task", { op: "shell.exec" })).body).toMatchObject({ error: { code: "unknown_op" } });

    await c.revokeMachine(aId);
    // P8 : le membre a un nœud en ligne (B) → calendar.list passe par la file, pas par device.request.
    const ask = fetch(`${mock.url}/v1/dev/device-request`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ op: "calendar.list", args: { from: "2026-11-07T00:00:00Z", to: "2026-11-08T00:00:00Z" }, timeout_ms: 4000 }) }).then((r) => r.json());
    const [ct] = (await b.poll(5)).body.tasks;
    expect(ct).toMatchObject({ op: "calendar.list", args: { from: "2026-11-07T00:00:00Z" } });
    await b.result(ct!.task_id, { status: "done", result: JSON.stringify({ items: [{ title: "Dentiste", start: "2026-11-07T09:00:00Z", end: "2026-11-07T09:30:00Z", all_day: false, calendar: "Perso" }] }) });
    const r = await ask;
    expect(r).toMatchObject({ via: "node", items: [{ title: "Dentiste" }] });
  }, 15_000);
});

async function proofHeaders(n: NodeClient, method: string, pathQuery: string): Promise<Record<string, string>> {
  let h: Record<string, string> = {};
  await new NodeClient(n.baseUrl, n.machineToken, n.sign, async (_u, init) => {
    h = init!.headers as Record<string, string>;
    return new Response("{}");
  }).call(method, pathQuery);
  return h;
}
