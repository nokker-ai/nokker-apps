import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIGNETTE, lookAngle, presentLayout, presentLiveEnabled, presenterView, stageFrameBox, toStage, vignetteOrigin, vignetteSpot } from "../src/browser/presenter.js";

const A = (seq: number, ms: number) => ({ session_id: "bs_1", seq, ts: new Date(ms).toISOString(), kind: "read" as const, target_label: "Liste", url_host: "x" });
const P = (seq: number, ms: number) => ({ session_id: "bs_1", seq, ts: new Date(ms).toISOString(), box: { x: 0.5, y: 0.2, w: 0.2, h: 0.5 }, label: "Appartement", why: "4 voyageurs, balcon" });
const F = (seq: number) => ({ session_id: "bs_1", seq, ts: "", url_host: "x", title: "t", w: 1280, h: 800, sensitive: false, frame_url: "/f" });

describe("presenter (V3 +)", () => {
  it("the latest « why » is the last bubble and the target", () => {
    const v = presenterView({ frames: [F(1)], actions: [A(2, 1000)], points: [P(1, 2000)] });
    expect(v.bubbles[v.bubbles.length - 1]!.text).toBe("4 voyageurs, balcon");
    expect(v.target).toEqual({ x: 0.5, y: 0.2, w: 0.2, h: 0.5 });
    // Sous-titres = ce qu'elle dit (son geste), pas la raison courte de sa bulle.
    expect(v.caption).toBe("I read: Liste");
  });
  it("the halo compares timestamps, not the action counter with the frame counter (bs_5d9a12f4: action 15 < point 6 in time)", () => {
    const v = presenterView({ frames: [F(6)], actions: [A(15, 1000)], points: [P(6, 4000)] });
    expect(v.target).toEqual({ x: 0.5, y: 0.2, w: 0.2, h: 0.5 });
    // Une action vraiment plus récente que la désignation reprend la main (pas de curseur pour un « read » : aucun halo).
    expect(presenterView({ frames: [F(6)], actions: [A(15, 5000)], points: [P(6, 4000)] }).target).toBeNull();
    // Sans horodatage lisible : repli sur seq, comme avant.
    const noTs = { ...P(6, 0), ts: "" };
    expect(presenterView({ frames: [F(6)], actions: [{ ...A(15, 1000), ts: "" }], points: [noTs] }).target).toBeNull();
  });
  it("a pending card: Nina says she is waiting, never that she clicked; a failed gesture says so", () => {
    const v = presenterView({ frames: [F(1)], actions: [A(2, 1000)], points: [] }, [{ id: "appr_1", seq: 2, reason: "Send the request", pending: true, at: new Date(3000).toISOString() }]);
    expect(v.caption).toBe("I'm waiting for your approval: Send the request");
    const w = presenterView({ frames: [F(1)], actions: [{ ...A(2, 1000), kind: "click" as const, target_label: "Pay", ok: false } as never], points: [] });
    expect(w.caption).toBe("That did not work: Pay");
  });
  it("no target on a sensitive frame", () => {
    const v = presenterView({ frames: [{ ...F(3), sensitive: true, frame_url: null }], actions: [], points: [P(1, 1)] });
    expect(v.target).toBeNull();
  });
  it("stage mapping keeps the frame ratio and the look angle is bounded", () => {
    const fb = stageFrameBox(1.6);
    expect(fb.w / fb.h).toBeCloseTo((1.6 * 9) / 16, 3);
    expect(toStage(fb, { x: 0, y: 0, w: 1, h: 1 })).toEqual(fb);
    expect(Math.abs(lookAngle({ x: 0.9, y: 0.5 }, { x: 0, y: 0, w: 0.01, h: 0.01 }))).toBeLessThanOrEqual(14);
  });
});

describe("/present en mode démo : Nina live en vignette", () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const hits = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it("drapeau : éteint par défaut ; VITE_NOKKER_PRESENT_LIVE=1 ou localStorage l'allument", () => {
    expect(presentLiveEnabled()).toBe(false);
    mem.set("nokker.web.present.live", "1");
    expect(presentLiveEnabled()).toBe(true);
    mem.clear();
    vi.stubEnv("VITE_NOKKER_PRESENT_LIVE", "1");
    expect(presentLiveEnabled()).toBe(true);
  });

  it("la vignette se pose en bas à droite, dans la zone sûre, loin de la page", () => {
    const fb = stageFrameBox(1.6);
    const s = vignetteSpot([{ x: 0.2, y: 0.3, w: 0.1, h: 0.1 }, fb]);
    expect(s).toEqual({ x: 1 - 0.05 - VIGNETTE.w, y: 1 - 0.05 - VIGNETTE.h, w: VIGNETTE.w, h: VIGNETTE.h });
    expect(s.x + s.w).toBeLessThanOrEqual(0.95 + 1e-9);
    expect(s.y + s.h).toBeLessThanOrEqual(0.95 + 1e-9);
    expect(hits(s, fb)).toBe(false);
  });

  it("jamais sur la cible : une cible dans le coin bas droite la fait passer en haut à droite, puis à gauche", () => {
    const br = { x: 0.8, y: 0.7, w: 0.1, h: 0.1 };
    const a = vignetteSpot([br]);
    expect(hits(a, br)).toBe(false);
    expect(a.y).toBeCloseTo(0.05);
    const both = vignetteSpot([br, { x: 0.8, y: 0.1, w: 0.1, h: 0.1 }]);
    expect(both.x).toBeCloseTo(0.05); // les deux coins droits sont pris : bas gauche
    expect(vignetteSpot([null, null]).x).toBeGreaterThan(0.7); // rien à éviter : bas droite
  });

  it("le faisceau part du centre du cadre carré de la vignette", () => {
    const s = vignetteSpot([]);
    const o = vignetteOrigin(s);
    expect(o.x).toBeCloseTo(s.x + s.w / 2);
    expect(o.y).toBeCloseTo(s.y + (s.w * 16) / 9 / 2); // cadre carré : sa hauteur = sa largeur en pixels
    expect(o.y).toBeLessThan(s.y + s.h);
  });

  it("mise en page : hors démo = comme avant (rig, bulles) ; en démo jamais le rig, la vignette tant que le live n'est pas indisponible", () => {
    expect(presentLayout({ demo: false, liveOn: true, live: "connecting" })).toEqual({ vignette: false, rig: true, bubbles: true });
    expect(presentLayout({ demo: true, liveOn: true, live: "connecting" })).toEqual({ vignette: true, rig: false, bubbles: true });
    expect(presentLayout({ demo: true, liveOn: true, live: "live" }).vignette).toBe(true);
    // Indisponible (ou capacité éteinte) : halo + faisceau + sous-titres + bulles seuls, jamais le rig 2D.
    expect(presentLayout({ demo: true, liveOn: true, live: "unavailable" })).toEqual({ vignette: false, rig: false, bubbles: true });
    expect(presentLayout({ demo: true, liveOn: false, live: "connecting" })).toEqual({ vignette: false, rig: false, bubbles: true });
  });
});
