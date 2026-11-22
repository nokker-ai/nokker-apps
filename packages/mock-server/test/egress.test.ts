import { afterEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { b64uEncode, NodeClient, NokkerApiError, NokkerClient, openSealedToken, type FetchGetArgs, type PhoneBeat, type PhoneRegistered } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let stop = false;
afterEach(async () => {
  stop = true;
  await mock.close();
});
const code = (e: unknown): unknown => ((e as NokkerApiError).body as { error?: { code?: string } })?.error?.code;
const BEAT = (egress: "on" | "off"): PhoneBeat => ({ v: 1, app_version: "0.1.0", os: "iOS 18.2", mode: "pocket", reach: "live", power: { charging: true, level: 0.8 }, net: { type: "wifi", metered: false, home_wifi: true }, caps: { location: "on", device_calendar: "on", ocr: "on", stt: "off", egress }, queue: { leased: 0 }, slm: null });
const dev = (path: string, body: object) => fetch(`${mock.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

/** Téléphone inscrit qui répond aux fetch.get comme le natif (statut 200 et un texte), en notant ce qu'il reçoit. */
async function phone(c: NokkerClient) {
  const k = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const a = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const spki = b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", k.publicKey)));
  const enc = b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey("spki", a.publicKey)));
  const reg = await c.registerPhone({ name: "iPhone", platform: "ios", os_version: "18.2", app_version: "0.1.0", public_key_spki: spki, enc_key_spki: enc, key_storage: "software", attestation: null, push_token: null });
  await dev("/v1/dev/phone/approve", { approval_id: reg.approval_id });
  const r = (await c.phoneRegistration(reg.approval_id)) as PhoneRegistered;
  const token = await openSealedToken(a.privateKey, reg.approval_id, r.sealed_token, webcrypto as never);
  const node = new NodeClient(mock.url, token, async (d) => new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, d)));
  const seen: FetchGetArgs[] = [];
  const loop = async () => {
    while (!stop) {
      const p = await node.poll(1).catch(() => null);
      for (const t of p?.body?.tasks ?? []) {
        if (t.op !== "fetch.get") continue;
        seen.push(t.args as unknown as FetchGetArgs);
        await node.result(t.task_id, { status: "done", result: JSON.stringify({ status: 200, final_url: t.args.url, content_type: "text/html", charset: "utf-8", text: "<p>Grille tarifaire 2027</p>", bytes: 28, truncated: false, hops: 0 }) });
      }
    }
  };
  return { node, machineId: r.machine_id, seen, loop };
}

async function say(c: NokkerClient, threadId: string, text: string) {
  await c.streamChatCompletion(threadId, [{ role: "user", content: text }], () => undefined, "nokker");
  return (await c.getThread(threadId)).messages;
}

describe("pages par le téléphone (P11)", () => {
  it("liste d'hôtes : normalisée, bornée, refus des IP, jokers nus et suffixes locaux", async () => {
    mock = await startMockServer({ speed: 0.01 });
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    expect((await c.putEgressHosts([" Tarifs.Example.CH ", "*.meteo.example.ch", "tarifs.example.ch"])).hosts).toEqual(["tarifs.example.ch", "*.meteo.example.ch"]);
    for (const bad of ["*", "*.ch", "10.0.0.1", "nas.local", "router.home.arpa", "intranet", "a/b.ch", "x:443"]) {
      const e = await c.putEgressHosts([bad]).catch((x) => x);
      expect(code(e), bad).toBe("bad_host");
    }
    expect(code(await c.putEgressHosts(Array.from({ length: 51 }, (_, i) => `h${i}.example.ch`)).catch((x) => x))).toBe("too_many_hosts");
    expect((await c.getEgressHosts()).hosts).toHaveLength(2);
  });

  it("refus → offre seulement si egress allumé ; geste → tour de la personne, droit à usage unique ; jamais de repli automatique", async () => {
    mock = await startMockServer({ speed: 0.01 });
    stop = false;
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const t = await c.createThread("Tarifs");
    const p = await phone(c);
    void p.loop();
    // egress coupé : refus, pas d'offre, rien en file.
    await p.node.beat(BEAT("off"));
    let msgs = await say(c, t!.id, "ouvre https://tarifs.blocked.example.test/2027");
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: expect.stringMatching(/refused access \(403\)\.$/) });
    expect(msgs.at(-1)).not.toHaveProperty("phone_fetch_offers");
    // egress allumé : offre, MAIS aucun fetch tant que la personne n'a pas fait le geste.
    await p.node.beat(BEAT("on"));
    msgs = await say(c, t!.id, "ouvre https://tarifs.blocked.example.test/2027");
    const offer = msgs.at(-1)!.phone_fetch_offers![0]!;
    expect(offer).toMatchObject({ url: "https://tarifs.blocked.example.test/2027", host: "tarifs.blocked.example.test", reason: "http_403" });
    await new Promise((r) => setTimeout(r, 300));
    expect(p.seen).toHaveLength(0);
    // Une offre d'un autre fil, ou une autre url : refus.
    const other = await c.createThread("Autre");
    expect(code(await c.phoneFetch(other!.id, { url: offer.url, call_id: offer.call_id }).catch((e) => e))).toBe("no_offer");
    expect(code(await c.phoneFetch(t!.id, { url: "https://ailleurs.example.ch/", call_id: offer.call_id }).catch((e) => e))).toBe("no_offer");
    // Le geste.
    const g = await c.phoneFetch(t!.id, { url: offer.url, call_id: offer.call_id });
    expect(g.turn_id).toMatch(/:/);
    const end = Date.now() + 5000;
    while (Date.now() < end && !(await c.getThread(t!.id)).messages.some((m) => m.origin === "phone_fetch")) await new Promise((r) => setTimeout(r, 50));
    msgs = (await c.getThread(t!.id)).messages;
    const u = msgs.find((m) => m.origin === "phone_fetch")!;
    expect(u).toMatchObject({ role: "user", content: "Ouvre cette page par mon téléphone : https://tarifs.blocked.example.test/2027" });
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", phone_fetched: [{ host: "tarifs.blocked.example.test", ok: true, status: 200 }] });
    expect(p.seen).toEqual([{ url: offer.url, trigger: "explicit", turn_id: g.turn_id, grant_id: expect.stringMatching(/^pfg_/) }]);
    expect(code(await c.phoneFetch(t!.id, { url: offer.url, call_id: offer.call_id }).catch((e) => e))).toBe("offer_used");
    // Journal : l'hôte seulement.
    const log = await c.phoneTasks(p.machineId);
    expect(log.tasks[0]).toMatchObject({ op: "fetch.get", host: "tarifs.blocked.example.test", status: "done" });
    expect(JSON.stringify(log)).not.toContain("/2027");
    // La route de réglage ne met jamais un fetch.get en file.
    expect((await dev("/v1/dev/phone/task", { op: "fetch.get", args: { url: "https://x.example.ch/" } })).body).toMatchObject({ error: { code: "fetch_needs_grant" } });
  }, 20_000);

  it("hôte de la liste : la page passe par le téléphone (allowlist), avec la liste pour revérifier les redirections", async () => {
    mock = await startMockServer({ speed: 0.01 });
    stop = false;
    const c = new NokkerClient({ baseUrl: mock.url });
    await c.demoSessionMockExtension();
    const t = await c.createThread("Météo");
    const p = await phone(c);
    void p.loop();
    await p.node.beat(BEAT("on"));
    await c.putEgressHosts(["*.meteo.example.ch"]);
    const msgs = await say(c, t!.id, "ouvre https://geneve.meteo.example.ch/demain");
    expect(msgs.at(-1)).toMatchObject({ phone_fetched: [{ host: "geneve.meteo.example.ch", ok: true }] });
    expect(p.seen[0]).toMatchObject({ trigger: "allowlist", allow_hosts: ["*.meteo.example.ch"], url: "https://geneve.meteo.example.ch/demain" });
    // `*.meteo.example.ch` ne couvre pas meteo.example.ch lui-même : lu par le cloud.
    expect((await say(c, t!.id, "ouvre https://meteo.example.ch/")).at(-1)!.content).toMatch(/read from the cloud/);
    expect(p.seen).toHaveLength(1);
  }, 20_000);
});
