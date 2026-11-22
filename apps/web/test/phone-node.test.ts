import { describe, expect, it, vi } from "vitest";
import { NokkerApiError } from "@nokker-apps/sdk";
import { beatMinutes, enrollPhone, removePhone, type EnrollStep, type NodePlugin } from "../src/platform/node.js";

const plugin = (): NodePlugin & { enrolled?: unknown } => {
  const p: NodePlugin & { enrolled?: unknown } = {
    status: async () => ({ enrolled: false, running: false }),
    prepareKey: async () => ({ public_key_spki: "SPKI", enc_key_spki: "ENC", key_storage: "software", key_fingerprint: "ab12cd34" }),
    enroll: async (o) => ((p.enrolled = o), { enrolled: true, running: false, machine_id: o.machine_id }),
    start: async () => ({ enrolled: true, running: true, machine_id: "mc_ph_1" }),
    stop: async () => ({ enrolled: true, running: false }),
    forget: async () => ({ enrolled: false, running: false }),
  };
  return p;
};
const SEALED = { v: 1 as const, epk: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" }, iv: "iv", ct: "ct" };
const apiErr = (status: number, code: string) => new NokkerApiError(`x → ${status}`, status, { error: { code } });
const noSleep = async () => undefined;
const opts = (steps: EnrollStep[]) => ({ name: "iPhone", baseUrl: "https://app.example.test", appVersion: "0.1.0", osVersion: "18.2", onStep: (s: EnrollStep) => steps.push(s), sleep: noSleep, everyMs: 1 });

describe("inscription du téléphone (P7)", () => {
  it("attente avec l'empreinte, puis jeton remis au plugin et démarrage", async () => {
    const p = plugin();
    let polls = 0;
    const registerPhone = vi.fn(async () => ({ approval_id: "appr_1", key_fingerprint: "ab12cd34", expires_at: new Date(Date.now() + 60_000).toISOString() }));
    const client = {
      registerPhone,
      phoneRegistration: async () => (++polls < 3 ? { status: "pending" as const } : { machine_id: "mc_ph_1", sealed_token: SEALED, member: "m", caps_allowed: [] }),
    };
    const steps: EnrollStep[] = [];
    const r = await enrollPhone(client as never, p, opts(steps));
    expect(r).toMatchObject({ kind: "done", status: { running: true } });
    expect(steps[0]).toMatchObject({ kind: "waiting", fingerprint: "ab12cd34" });
    expect(p.enrolled).toEqual({ machine_id: "mc_ph_1", approval_id: "appr_1", sealed_token: SEALED, base_url: "https://app.example.test" });
    expect(registerPhone.mock.calls[0]![0]).toMatchObject({ public_key_spki: "SPKI", enc_key_spki: "ENC", key_storage: "software", attestation: null, push_token: null });
  });

  it("refus, échéance, compte non ouvert, trop de téléphones, coupure passagère", async () => {
    const reg = async () => ({ approval_id: "a", key_fingerprint: "f", expires_at: new Date(Date.now() + 60_000).toISOString() });
    const run = (c: object) => enrollPhone(c as never, plugin(), opts([]));
    expect(await run({ registerPhone: reg, phoneRegistration: async () => Promise.reject(apiErr(403, "rejected")) })).toEqual({ kind: "failed", code: "rejected" });
    expect(await run({ registerPhone: reg, phoneRegistration: async () => Promise.reject(apiErr(410, "gone")) })).toEqual({ kind: "failed", code: "expired" });
    expect(await run({ registerPhone: async () => Promise.reject(apiErr(400, "attestation_required")) })).toEqual({ kind: "failed", code: "not_available" });
    expect(await run({ registerPhone: async () => Promise.reject(apiErr(409, "too_many_phones")) })).toEqual({ kind: "failed", code: "too_many" });
    let n = 0;
    const flaky = { registerPhone: reg, phoneRegistration: async () => (++n === 1 ? Promise.reject(new TypeError("network")) : { machine_id: "m", sealed_token: SEALED, member: "x", caps_allowed: [] }) };
    expect((await run(flaky)).kind).toBe("done");
    const ab = new AbortController();
    ab.abort();
    expect(await enrollPhone({ registerPhone: reg, phoneRegistration: async () => ({ status: "pending" }) } as never, plugin(), { ...opts([]), signal: ab.signal })).toEqual({ kind: "failed", code: "expired" });
  });

  it("sceau que le natif ne sait pas ouvrir : échec propre, rien d'enregistré", async () => {
    const p = plugin();
    p.enroll = async () => Promise.reject(new Error("seal_invalid"));
    const client = { registerPhone: async () => ({ approval_id: "a", key_fingerprint: "f", expires_at: new Date(Date.now() + 60_000).toISOString() }), phoneRegistration: async () => ({ machine_id: "m", sealed_token: SEALED, member: "x", caps_allowed: [] }) };
    expect(await enrollPhone(client as never, p, opts([]))).toEqual({ kind: "failed", code: "key" });
  });

  it("retrait : révocation puis oubli ; un 404 n'empêche pas l'oubli", async () => {
    const p = plugin();
    const forget = vi.spyOn(p, "forget");
    await removePhone({ revokeMachine: async () => Promise.reject(apiErr(404, "not_found")) } as never, p, "mc_ph_1");
    expect(forget).toHaveBeenCalledTimes(1);
    await expect(removePhone({ revokeMachine: async () => Promise.reject(apiErr(500, "x")) } as never, p, "mc_ph_1")).rejects.toBeTruthy();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(beatMinutes({ last_beat_at: new Date(Date.now() - 5 * 60_000).toISOString() })).toBe(5);
    expect(beatMinutes({})).toBeNull();
  });
});
