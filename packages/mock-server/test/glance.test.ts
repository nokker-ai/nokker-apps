import { afterEach, describe, expect, it } from "vitest";
import { NokkerApiError, NokkerClient, normalizeGlanceCode } from "@nokker-apps/sdk";
import { startMockServer, type MockServerHandle } from "../src/index.js";

let mock: MockServerHandle | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});
const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (!(e instanceof NokkerApiError)) return { status: -1 };
    return { status: e.status, code: (e.body as { error?: { code?: string } }).error?.code };
  }
};
async function boot(): Promise<NokkerClient> {
  const m = await startMockServer({ speed: 0.01, configDir: null });
  mock = m;
  const phone = new NokkerClient({ baseUrl: m.url });
  await phone.demoSessionMockExtension();
  return phone;
}

describe("glance view for glasses (AMBIENT.md §6)", () => {
  it("pair on the phone, claim on the glasses (code typed loosely or QR text), read the view", async () => {
    const phone = await boot();
    const offer = await phone.pairGlance("Ray-Ban");
    expect(offer.code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    expect(offer.qr).toBe(`NOKKER-GLANCE:${offer.code.replace("-", "")}`);
    expect(offer.expires_in).toBe(300);
    const glasses = new NokkerClient({ baseUrl: mock!.url });
    const claim = await glasses.claimGlance(offer.code.toLowerCase().replace("-", " "));
    expect(claim.token.startsWith("nkg_")).toBe(true);
    expect(claim).toMatchObject({ device: { name: "Ray-Ban" }, scope: "glance" });
    // single use
    expect(await fail(new NokkerClient({ baseUrl: mock!.url }).claimGlance(offer.code))).toEqual({ status: 404, code: "unknown_code" });
    const reader = new NokkerClient({ baseUrl: mock!.url, token: claim.token });
    const v = await reader.getGlance();
    expect(Object.keys(v).sort()).toEqual(["approvals", "at", "brief", "brief_last_run", "incidents", "unavailable"]);
    expect(Array.isArray(v.approvals)).toBe(true);
    expect((await phone.listGlanceDevices()).devices.map((d) => [d.name, d.revoked])).toEqual([["Ray-Ban", false]]);
  });

  it("a glance token opens nothing else; revoked, it opens nothing at all", async () => {
    const phone = await boot();
    const offer = await phone.pairGlance();
    const claim = await new NokkerClient({ baseUrl: mock!.url }).claimGlance(offer.qr);
    const reader = new NokkerClient({ baseUrl: mock!.url, token: claim.token });
    expect(await fail(reader.listThreads())).toEqual({ status: 403, code: "glance_scope" });
    expect(await fail(reader.listApprovals("pending"))).toEqual({ status: 403, code: "glance_scope" });
    expect(await fail(reader.pairGlance())).toEqual({ status: 403, code: "glance_scope" });
    expect(await fail(phone.getGlance())).toEqual({ status: 401, code: "glance_token_required" });
    const id = (await phone.listGlanceDevices()).devices[0]!.id;
    expect(await phone.revokeGlanceDevice(id)).toEqual({ revoked: true });
    expect(await fail(reader.getGlance())).toEqual({ status: 401, code: "bad_glance_token" });
  });

  it("five glance views per account; wrong codes end in 429", async () => {
    const phone = await boot();
    for (let i = 0; i < 5; i++) await new NokkerClient({ baseUrl: mock!.url }).claimGlance((await phone.pairGlance()).code);
    expect(await fail(phone.pairGlance())).toEqual({ status: 409, code: "too_many_glance" });
    const stranger = new NokkerClient({ baseUrl: mock!.url });
    for (let i = 0; i < 10; i++) expect((await fail(stranger.claimGlance("ZZZZ-ZZZZ"))).status).toBe(404);
    expect(await fail(stranger.claimGlance("ZZZZ-ZZZZ"))).toEqual({ status: 429, code: "too_many_attempts" });
  });

  it("at most 2 reads per minute per token: the third is 429 glance_rate with Retry-After", async () => {
    const phone = await boot();
    const claim = await new NokkerClient({ baseUrl: mock!.url }).claimGlance((await phone.pairGlance()).code);
    const reader = new NokkerClient({ baseUrl: mock!.url, token: claim.token });
    await reader.getGlance();
    await reader.getGlance();
    const err = await reader.getGlance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NokkerApiError);
    const e = err as NokkerApiError;
    expect(e.status).toBe(429);
    expect((e.body as { error: { code: string } }).error.code).toBe("glance_rate");
    expect(e.retryAfterS).toBeGreaterThan(0);
    expect(e.retryAfterS).toBeLessThanOrEqual(60);
  });

  it("normalizeGlanceCode accepts what the core accepts", () => {
    expect(normalizeGlanceCode(" abcd-efgh ")).toBe("ABCDEFGH");
    expect(normalizeGlanceCode("NOKKER-GLANCE:ABCDEFGH")).toBe("ABCDEFGH");
  });
});
