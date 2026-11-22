import { afterEach, describe, expect, it, vi } from "vitest";
import { redeemSessionCode, takeCodeNote } from "../src/onboarding/sessionCode.js";
import { takeLocalToken } from "../src/onboarding/localToken.js";
import { onPresentScreen, PRESENT_WRITE_BLOCKED, tokenScope } from "../src/kiosk/scope.js";
import { takeKioskToken } from "../src/kiosk/mode.js";


function fakeWindow(pathname: string, hash = "") {
  const store = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
  };
  const w = {
    location: { hash, pathname, search: "", origin: "http://127.0.0.1:8743", hostname: "127.0.0.1" },
    history: { replaceState: vi.fn() },
    localStorage: store(),
    sessionStorage: store(),
  };
  vi.stubGlobal("window", w);
  vi.stubGlobal("location", w.location);
  return w;
}
afterEach(() => vi.unstubAllGlobals());
const exchange = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("échange d'un code : la portée décide où va le jeton", () => {
  it("/kiosk + scope kiosk : clé du kiosque (nokker.kiosk-token), JAMAIS la clé de l'app", async () => {
    const w = fakeWindow("/kiosk");
    expect(await redeemSessionCode("http://x", "C".repeat(22), { target: "kiosk", fetchImpl: exchange({ token: "KIOSK-T", expires_in: 2592000, scope: "kiosk" }) })).toBe(true);
    expect(takeKioskToken()).toBe("KIOSK-T");
    expect(w.sessionStorage.getItem("nokker.kiosk-token")).toBe("KIOSK-T");
    expect(takeLocalToken()).toBeNull();
    expect(w.localStorage.getItem("nokker.local-token")).toBeNull();
  });
  it("/kiosk + un jeton qui n'est pas kiosk (owner, present, ou noyau sans scope) : jeté, rien gardé, raison « scope »", async () => {
    for (const body of [{ token: "T", expires_in: 1, scope: "owner" }, { token: "T", expires_in: 1, scope: "present" }, { token: "T", expires_in: 1 }]) {
      const w = fakeWindow("/kiosk");
      expect(await redeemSessionCode("http://x", "C".repeat(22), { target: "kiosk", fetchImpl: exchange(body) })).toBe(false);
      expect(takeCodeNote()).toBe("scope");
      expect(w.sessionStorage.getItem("nokker.kiosk-token")).toBeNull();
      expect(takeLocalToken()).toBeNull();
    }
  });
  it("l'échange dit la portée attendue : expect=kiosk sur /kiosk, expect=present sur /present, rien sur l'app ; 409 wrong_scope = échec « scope »", async () => {
    fakeWindow("/kiosk");
    const bodies: string[] = [];
    const spy = (status: number, payload: unknown) => vi.fn(async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response(JSON.stringify(payload), { status }))) as unknown as typeof fetch;
    expect(await redeemSessionCode("http://x", "C".repeat(22), { target: "kiosk", fetchImpl: spy(200, { token: "K", expires_in: 1, scope: "kiosk" }) })).toBe(true);
    fakeWindow("/present");
    await redeemSessionCode("http://x", "C".repeat(22), { target: "present", fetchImpl: spy(200, { token: "P", expires_in: 1, scope: "present" }) });
    fakeWindow("/");
    await redeemSessionCode("http://x", "C".repeat(22), { target: "app", fetchImpl: spy(200, { token: "O", expires_in: 1, scope: "owner" }) });
    expect(bodies.map((b) => JSON.parse(b))).toEqual([{ code: "C".repeat(22), expect: "kiosk" }, { code: "C".repeat(22), expect: "present" }, { code: "C".repeat(22) }]);
    fakeWindow("/kiosk");
    expect(await redeemSessionCode("http://x", "C".repeat(22), { target: "kiosk", fetchImpl: spy(409, { error: { code: "wrong_scope" } }) })).toBe(false);
    expect(takeCodeNote()).toBe("scope");
  });
  it("hors /kiosk, un jeton de portée kiosk ne devient jamais la clé de l'app", async () => {
    const w = fakeWindow("/");
    expect(await redeemSessionCode("http://x", "C".repeat(22), { target: "app", fetchImpl: exchange({ token: "KIOSK-T", expires_in: 1, scope: "kiosk" }) })).toBe(false);
    expect(takeCodeNote()).toBe("scope");
    expect(takeLocalToken()).toBeNull();
    expect(w.localStorage.getItem("nokker.local-token")).toBeNull();
  });
  it("/present : la clé de l'app, le temps de l'onglet SEULEMENT (sessionStorage, jamais localStorage), portée retenue", async () => {
    const w = fakeWindow("/present/bs_abc");
    expect(await redeemSessionCode("http://x", "C".repeat(22), { target: "present", persistent: true, fetchImpl: exchange({ token: "PRESENT-T", expires_in: 43200, scope: "present" }) })).toBe(true);
    expect(w.sessionStorage.getItem("nokker.local-token")).toBe("PRESENT-T");
    expect(w.localStorage.getItem("nokker.local-token")).toBeNull();
    expect(tokenScope()).toBe("present");
  });
  it("app + scope owner (ou noyau sans scope) : comme avant, localStorage sur un Lokkal", async () => {
    const w = fakeWindow("/");
    expect(await redeemSessionCode("http://x", "C".repeat(22), { fetchImpl: exchange({ token: "OWNER-T", expires_in: 2592000 }) })).toBe(true);
    expect(w.localStorage.getItem("nokker.local-token")).toBe("OWNER-T");
    expect(tokenScope()).toBe("owner");
  });
});

describe("écran de présentation : jamais de décision de carte", () => {
  it("onPresentScreen : /present, /present/<session>, ou jeton de portée present ; pas /present-x ni l'app", () => {
    fakeWindow("/present");
    expect(onPresentScreen()).toBe(true);
    fakeWindow("/present/bs_abc123");
    expect(onPresentScreen()).toBe(true);
    fakeWindow("/presentation");
    expect(onPresentScreen()).toBe(false);
    fakeWindow("/");
    expect(onPresentScreen()).toBe(false);
    const w = fakeWindow("/");
    w.sessionStorage.setItem("nokker.token-scope", "present");
    expect(onPresentScreen()).toBe(true);
  });
  it("les écritures de décision (approbations, appareils) sont reconnues ; la lecture et le reste ne le sont pas", () => {
    for (const u of ["/v1/approvals/appr_1/decision", "http://h/v1/local/approvals/appr_1/decide", "/v1/approvals", "/v1/devices", "/v1/devices/dev_1"]) expect(PRESENT_WRITE_BLOCKED.test(u)).toBe(true);
    for (const u of ["/v1/threads", "/v1/local/kiosk", "/v1/approvals-x", "/v1/browser/sessions/bs_1/narrations/2/speech/timed"]) expect(PRESENT_WRITE_BLOCKED.test(u)).toBe(false);
  });
});
