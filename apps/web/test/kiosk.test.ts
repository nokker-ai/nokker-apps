// Kiosque HDMI : la clé du kiosque ne devient jamais celle de l'app ; garde d'inactivité de 10 min du mode perso.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asHousehold, isDemoHousehold, kioskNight } from "../src/kiosk/model.js";
import { enterPersonal, installPersonalIdleGuard, PERSONAL_IDLE_MS, takeKioskToken } from "../src/kiosk/mode.js";

const APP = "nokker.local-token";

function storage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

/** Un `window` minimal : pas de jsdom dans ce paquet. */
function fakeWindow(pathname: string, hash = "") {
  const listeners = new Map<string, Set<() => void>>();
  const w = {
    location: { hash, pathname, search: "", hostname: "127.0.0.1", assign: vi.fn(), replace: vi.fn() },
    history: { replaceState: vi.fn((_s: unknown, _t: string, url: string) => void (w.location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : "")) },
    localStorage: storage(),
    sessionStorage: storage(),
    addEventListener: (e: string, f: () => void) => void (listeners.get(e) ?? listeners.set(e, new Set()).get(e)!).add(f),
    removeEventListener: (e: string, f: () => void) => void listeners.get(e)?.delete(f),
    setInterval: (f: () => void, ms: number) => setInterval(f, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    fire: (e: string) => listeners.get(e)?.forEach((f) => f()),
  };
  vi.stubGlobal("window", w);
  return w;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.useRealTimers());

describe("kiosk", () => {
  it("prend la clé du fragment pour le kiosque seulement et l'efface de la barre d'adresse", () => {
    const w = fakeWindow("/kiosk", "#token=kiosque-123");
    expect(takeKioskToken()).toBe("kiosque-123");
    expect(w.location.hash).toBe("");
    expect(w.localStorage.getItem(APP)).toBeNull();
    expect(w.sessionStorage.getItem(APP)).toBeNull();
    expect(takeKioskToken()).toBe("kiosque-123"); // rechargement : relue dans la session du Chrome du kiosque
  });

  it("mode perso : la clé de l'app est oubliée après 10 min sans usage, gardée avant", () => {
    const w = fakeWindow("/kiosk", "#token=k");
    takeKioskToken();
    w.localStorage.setItem(APP, "cle-app");
    let t = 1_000_000;
    enterPersonal(() => t); // jamais servi : oubliée
    expect(w.localStorage.getItem(APP)).toBeNull();
    w.localStorage.setItem(APP, "cle-app");
    t += PERSONAL_IDLE_MS - 1000;
    enterPersonal(() => t); // moins de 10 min : gardée
    expect(w.localStorage.getItem(APP)).toBe("cle-app");
    t += PERSONAL_IDLE_MS;
    enterPersonal(() => t);
    expect(w.localStorage.getItem(APP)).toBeNull();
    expect(w.location.assign).toHaveBeenCalledWith("/");
  });

  it("garde d'inactivité : retour au kiosque après 10 min sans geste, pas avant", () => {
    const w = fakeWindow("/kiosk", "#token=k");
    takeKioskToken();
    w.location.pathname = "/";
    vi.useFakeTimers();
    let t = 0;
    const onIdle = vi.fn();
    const stop = installPersonalIdleGuard({ now: () => t, every: 1000, onIdle });
    t = PERSONAL_IDLE_MS - 5000;
    w.fire("keydown");
    t = PERSONAL_IDLE_MS + 1000;
    vi.advanceTimersByTime(1000);
    expect(onIdle).not.toHaveBeenCalled();
    t = 2 * PERSONAL_IDLE_MS;
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    stop();
  });

  it("le retour par inactivité oublie la clé de l'app", () => {
    const w = fakeWindow("/kiosk", "#token=k");
    takeKioskToken();
    w.location.pathname = "/";
    w.localStorage.setItem(APP, "cle-app");
    vi.useFakeTimers();
    let t = 0;
    installPersonalIdleGuard({ now: () => t, every: 1000 });
    t = PERSONAL_IDLE_MS + 1;
    vi.advanceTimersByTime(1000);
    expect(w.localStorage.getItem(APP)).toBeNull();
    expect(w.location.replace).toHaveBeenCalledWith("/kiosk");
  });

  it("hors d'un Chrome de kiosque, aucune garde", () => {
    fakeWindow("/");
    const onIdle = vi.fn();
    vi.useFakeTimers();
    installPersonalIdleGuard({ now: () => 10 * PERSONAL_IDLE_MS, every: 10, onIdle });
    vi.advanceTimersByTime(100);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("la vue du kiosque ne remplit que les tuiles locales", () => {
    const h = asHousehold({ now: "2026-11-11T09:00:00+01:00", tz: "Europe/Zurich", weather: null, departures: [],
      ha: [{ entity_id: "input_boolean.nokker_test_lampe", name: "Lampe", state: "on", domain: "input_boolean" }], presenter: { slot: true } });
    expect([h.members, h.agenda, h.tasks, h.shopping, h.projects]).toEqual([[], [], [], [], []]);
    expect(h.ha).toHaveLength(1);
  });

  it("mode nuit : seulement si le noyau ne l'a pas coupé", () => {
    expect(kioskNight({ night: true }, true)).toBe(true);
    expect(kioskNight({}, true)).toBe(true); // noyau d'avant : nuit comme avant
    expect(kioskNight(null, true)).toBe(true);
    expect(kioskNight({ night: false }, true)).toBe(false); // kiosk.night: false
    expect(kioskNight({ night: true }, false)).toBe(false); // le jour
  });
});

describe("tuile « écran publié » (V7)", () => {
  const resolve = (u: string): string | null => `http://m${u}`;
  it("absente quand le noyau n'annonce pas d'écran (null, absent, adresse vide ou illisible)", async () => {
    const { kioskScreen } = await import("../src/kiosk/model.js");
    expect(kioskScreen(null, resolve)).toBeNull();
    expect(kioskScreen({}, resolve)).toBeNull();
    expect(kioskScreen({ screen: null }, resolve)).toBeNull();
    expect(kioskScreen({ screen: { id: "s", version: 1, title: "T", frame_url: "" } }, resolve)).toBeNull();
    expect(kioskScreen({ screen: { id: "s", version: 1, title: "T", frame_url: "/x" } }, () => null)).toBeNull();
  });
  it("donne l'adresse résolue, le titre (ou « titre » en repli) et une clé par version", async () => {
    const { kioskScreen } = await import("../src/kiosk/model.js");
    expect(kioskScreen({ screen: { id: "s1", version: 2, title: "Cuisine", frame_url: "/v1/screens/frame/k" } }, resolve)).toEqual({ key: "s1@2", title: "Cuisine", url: "http://m/v1/screens/frame/k" });
    expect(kioskScreen({ screen: { id: "s1", version: 3, titre: "Salon", frame_url: "/f" } }, resolve)?.title).toBe("Salon");
  });
});

describe("rafraîchissement de la tuile", () => {
  it("même écran : l'adresse n'est reprise qu'une fois par minute ; autre version : tout de suite ; plus d'écran : retirée", async () => {
    const { nextTile, TILE_REFRESH_MS } = await import("../src/kiosk/model.js");
    const t = (url: string, key = "s@1") => ({ key, title: "T", url });
    const a = nextTile(null, t("u1"), 1000)!;
    expect(a.url).toBe("u1");
    expect(nextTile(a, t("u2"), 1000 + TILE_REFRESH_MS - 1)).toBe(a);
    expect(nextTile(a, t("u2"), 1000 + TILE_REFRESH_MS)?.url).toBe("u2");
    expect(nextTile(a, t("u3", "s@2"), 1500)?.url).toBe("u3");
    expect(nextTile(a, null, 1500)).toBeNull();
  });
});

describe("mise à l'échelle de la tuile", () => {
  it("l'écran 1920×1080 tient en entier dans sa cellule, sans jamais être agrandi", async () => {
    const { fitScale } = await import("../src/kiosk/model.js");
    expect(fitScale(960, 800)).toBeCloseTo(0.5); // limité par la largeur
    expect(fitScale(1920, 540)).toBeCloseTo(0.5); // limité par la hauteur
    expect(fitScale(3840, 2160)).toBe(1);
    expect(fitScale(0, 800)).toBe(0);
    expect(fitScale(NaN, 800)).toBe(0);
  });
});

describe("kiosque — foyer démo", () => {
  const base = { now: "2026-11-11T09:00:00+01:00", tz: "Europe/Zurich", weather: { now_c: null, code: "sun", hi_c: 9, lo_c: 2, summary: "Soleil" }, departures: [], ha: [], presenter: { slot: false } } as never;
  it("fusionne le foyer démo avec la météo, les départs et la domotique du kiosque", () => {
    const v = { ...(base as object), household: { demo: true, guest: false, members: [{ id: "m1", name: "Léa", color: "#fff", initials: "L" }], agenda: [], tasks: [{ id: "t", member_id: null, title: "x", done: false }], meals: [], shopping: [], projects: [] } } as never;
    const h = asHousehold(v);
    expect(h.members).toHaveLength(1);
    expect(h.tasks).toHaveLength(1);
    expect(h.weather?.summary).toBe("Soleil");
    expect(h.at).toBe("2026-11-11T09:00:00+01:00");
    expect(isDemoHousehold(v)).toBe(true);
  });
  it("sans foyer : listes vides, pas de démo ; un foyer mal formé ne casse rien", () => {
    expect(asHousehold(base).tasks).toEqual([]);
    expect(isDemoHousehold(base)).toBe(false);
    expect(isDemoHousehold(null)).toBe(false);
    expect(asHousehold({ ...(base as object), household: { demo: true, tasks: "oups" } } as never).tasks).toEqual([]);
  });
});
