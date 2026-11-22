import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NokkerApiError, NokkerClient } from "@nokker-apps/sdk";
import { accordRequest, accordReset, accordSeedDevice, accordSet, accordSetLastSeen, startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle;
let owner: NokkerClient;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nokker-mock-accord-"));
  mock = await startMockServer({ port: 0, seed: false, speed: 0.01, configDir: dir });
  owner = new NokkerClient({ baseUrl: mock.url, token: mock.localToken! });
});
afterAll(async () => {
  await mock.close();
  await rm(dir, { recursive: true, force: true });
});

const code = async (p: Promise<unknown>): Promise<string | number | undefined> => p.then(() => undefined, (e) => (e instanceof NokkerApiError ? (e.code ?? e.status) : "autre"));

describe("ACCORD (mock)", () => {
  it("drapeau éteint (défaut) : 404 partout, comme le noyau", async () => {
    mock.state.accordEnabled = false;
    expect(await code(owner.getLocalAccord())).toBe(404);
    expect(await code(owner.openAccordPairing())).toBe(404);
  });

  it("propriétaire local seulement : un autre jeton ne voit rien", async () => {
    mock.state.accordEnabled = true;
    accordReset(mock.state);
    const other = new NokkerClient({ baseUrl: mock.url });
    expect(await code(other.getLocalAccord())).toBeDefined();
    const s = await owner.getLocalAccord();
    expect(s).toMatchObject({ enabled: true, pairing: { open: false, locked: false, requests: [] }, devices: [] });
    expect(s.host_fp).toMatch(/^[0-9a-f]{64}$/);
    expect(s.host_fp8).toBe(s.host_fp.slice(0, 8));
  });

  it("appairage : fenêtre fermée → refus ; ouverte → l'appareil demande, le bon code l'appaire", async () => {
    accordReset(mock.state);
    expect(await code(owner.pairAccordDevice("123456"))).toBe("pairing_closed");
    const open = await owner.openAccordPairing();
    expect(open.pairing.open).toBe(true);
    expect(open.pairing.closes_in_s).toBeGreaterThan(100);
    expect(accordRequest(mock.state, { key8: "1a2b3c4d", code: "246810" })).toBe(true);
    expect((await owner.getLocalAccord()).pairing.requests).toEqual([{ key8: "1a2b3c4d" }]);
    const dev = await owner.pairAccordDevice("246810");
    expect(dev).toMatchObject({ key8: "1a2b3c4d", revoked: false });
    expect(dev.device_id).toMatch(/^acc_[0-9a-f]{12}$/);
    const after = await owner.getLocalAccord();
    expect(after.pairing.open).toBe(false); // la fenêtre se ferme à l'appairage
    expect(after.devices.map((d) => d.device_id)).toEqual([dev.device_id]);
  });

  it("code faux : 400 bad_code ; trois codes faux : appairage bloqué 10 min (423), « Ajouter » refusé aussi", async () => {
    accordReset(mock.state);
    await owner.openAccordPairing();
    accordRequest(mock.state, { key8: "aaaa1111", code: "111111" });
    expect(await code(owner.pairAccordDevice("000000"))).toBe("bad_code");
    expect(await code(owner.pairAccordDevice("000001"))).toBe("bad_code");
    expect(await code(owner.pairAccordDevice("000002"))).toBe("pairing_locked");
    const s = await owner.getLocalAccord();
    expect(s.pairing).toMatchObject({ open: false, locked: true });
    expect(s.pairing.locked_for_s).toBeGreaterThan(590);
    expect(await code(owner.openAccordPairing())).toBe("pairing_locked");
    expect(await code(owner.pairAccordDevice("111111"))).toBe("pairing_locked"); // même le bon code
  });

  it("deux demandes pour le même code : ambigu, la fenêtre se ferme", async () => {
    accordReset(mock.state);
    await owner.openAccordPairing();
    accordRequest(mock.state, { key8: "aaaa0001", code: "555555" });
    accordRequest(mock.state, { key8: "bbbb0002", code: "555555" });
    expect(await code(owner.pairAccordDevice("555555"))).toBe("ambiguous");
    const s = await owner.getLocalAccord();
    expect(s.pairing.open).toBe(false);
    expect(s.pairing.requests).toEqual([]);
  });

  it("au plus 3 demandes en attente ; hors fenêtre une demande est refusée", async () => {
    accordReset(mock.state);
    expect(accordRequest(mock.state, { key8: "00000000", code: "000000" })).toBe(false);
    await owner.openAccordPairing();
    for (const k of ["a1", "a2", "a3"]) expect(accordRequest(mock.state, { key8: `${k}000000`, code: "100000" })).toBe(true);
    expect(accordRequest(mock.state, { key8: "a4000000", code: "100000" })).toBe(false);
  });

  it("la fenêtre se compte à rebours (échéance du noyau)", async () => {
    accordReset(mock.state);
    await owner.openAccordPairing();
    accordSet(mock.state, { windowS: 42 });
    const s = await owner.getLocalAccord();
    expect(s.pairing.open).toBe(true);
    expect(s.pairing.closes_in_s).toBeLessThanOrEqual(42);
    expect(s.pairing.closes_in_s).toBeGreaterThan(38);
  });

  it("révocation : la clé est oubliée (révoqué) ; une seconde révocation ou un inconnu : 404", async () => {
    accordReset(mock.state);
    const d = accordSeedDevice(mock.state, { device_id: "acc_7d4291008af2", key8: "7d429100" });
    expect(await owner.revokeAccordDevice(d.device_id)).toEqual({ device_id: "acc_7d4291008af2", revoked: true });
    const s = await owner.getLocalAccord();
    expect(s.devices[0]).toMatchObject({ device_id: "acc_7d4291008af2", revoked: true });
    expect(s.devices[0]!.revoked_at).toBeGreaterThan(0);
    expect(await code(owner.revokeAccordDevice("acc_7d4291008af2"))).toBe(404);
    expect(await code(owner.revokeAccordDevice("acc_000000000000"))).toBe(404);
  });
});

describe("ACCORD (mock) · nom et dernière connexion (noyau p2/integ-accord-name)", () => {
  it("l'appareil porte son nom (par défaut « ACCORD <key8> »), name_is_default, last_seen_at (null : jamais)", async () => {
    accordReset(mock.state);
    accordSeedDevice(mock.state, { device_id: "acc_aaaaaaaaaaaa", key8: "c0ffee00" });
    const d = (await owner.getLocalAccord()).devices[0]!;
    expect(d).toMatchObject({ name: "ACCORD c0ffee00", name_is_default: true, last_seen_at: null });
  });
  it("PATCH : nom donné, vide = retour au défaut ; 40 caractères visibles ; 400 bad_name (contrôle, trop long) ; 404 révoqué", async () => {
    accordReset(mock.state);
    accordSeedDevice(mock.state, { device_id: "acc_bbbbbbbbbbbb", key8: "deadbeef" });
    expect(await owner.renameAccordDevice("acc_bbbbbbbbbbbb", "  Bureau de Nina ")).toMatchObject({ name: "Bureau de Nina", name_is_default: false });
    expect((await owner.getLocalAccord()).devices[0]!.name).toBe("Bureau de Nina");
    expect(await owner.renameAccordDevice("acc_bbbbbbbbbbbb", "")).toMatchObject({ name: "ACCORD deadbeef", name_is_default: true });
    expect(await owner.renameAccordDevice("acc_bbbbbbbbbbbb", "😀".repeat(40))).toMatchObject({ name_is_default: false });
    expect(await code(owner.renameAccordDevice("acc_bbbbbbbbbbbb", "a".repeat(41)))).toBe("bad_name");
    expect(await code(owner.renameAccordDevice("acc_bbbbbbbbbbbb", "ligne\nsuivante"))).toBe("bad_name");
    await owner.revokeAccordDevice("acc_bbbbbbbbbbbb");
    expect(await code(owner.renameAccordDevice("acc_bbbbbbbbbbbb", "Trop tard"))).toBe(404);
    expect(await code(owner.renameAccordDevice("acc_000000000000", "Inconnu"))).toBe(404);
  });
  it("last_seen_at suit l'appareil", async () => {
    accordReset(mock.state);
    accordSeedDevice(mock.state, { device_id: "acc_cccccccccccc", key8: "12345678" });
    accordSetLastSeen(mock.state, "acc_cccccccccccc", 1_700_000_000);
    expect((await owner.getLocalAccord()).devices[0]!.last_seen_at).toBe(1_700_000_000);
  });
});
