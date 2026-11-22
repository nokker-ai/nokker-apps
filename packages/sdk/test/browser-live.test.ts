import { describe, expect, it } from "vitest";
import { applyBrowserEvent, blockedByText, browserLiveFromView, BROWSER_KEEP, emptyBrowserLive, type BrowserEvent } from "../src/index.js";

const S = "brs_1";
const frame = (seq: number, sensitive = false): BrowserEvent => ({ type: "browser.frame", session_id: S, seq, ts: new Date(seq).toISOString(), url_host: "shop.example", title: "Shop", w: 1280, h: 800, sensitive, frame_url: sensitive ? null : `/v1/browser/frames/f${seq}.webp?sig=x` });

describe("browser live (BROWSER-LIVE v3)", () => {
  it("keeps the last 20 frames and actions, ignores duplicates and other sessions", () => {
    let s = emptyBrowserLive(S);
    for (let i = 1; i <= 25; i++) s = applyBrowserEvent(s, frame(i));
    s = applyBrowserEvent(s, frame(25));
    s = applyBrowserEvent(s, { ...(frame(30) as object), session_id: "other" } as BrowserEvent);
    expect(s.frames).toHaveLength(BROWSER_KEEP);
    expect(s.frames[0]!.seq).toBe(6);
    expect(s.seq).toBe(25);
  });

  it("handoff → resumed → ended; a late handoff after the end is ignored", () => {
    let s = emptyBrowserLive(S);
    s = applyBrowserEvent(s, { type: "browser.handoff", session_id: S, seq: 3, reason: "2fa", url_host: "bank.example", takeover_url: "/t/abc", expires_at: "2026-11-08T10:00:00Z" });
    expect(s.status).toBe("handoff");
    s = applyBrowserEvent(s, { type: "browser.resumed", session_id: S, seq: 4 });
    expect(s).toMatchObject({ status: "running", handoff: null });
    s = applyBrowserEvent(s, { type: "browser.ended", session_id: S, seq: 9, reason: "done" });
    s = applyBrowserEvent(s, { type: "browser.handoff", session_id: S, seq: 10, reason: "captcha", url_host: "x", takeover_url: "/t/z", expires_at: "x" });
    expect(s).toMatchObject({ status: "ended", handoff: null, ended: { reason: "done" } });
  });

  it("a sensitive frame has no image", () => {
    const s = applyBrowserEvent(emptyBrowserLive(S), frame(2, true));
    expect(s.frames[0]!.frame_url).toBeNull();
  });

  it("the session view is the truth (fresh frame, state)", () => {
    const prev = applyBrowserEvent(emptyBrowserLive(S), frame(1));
    const v = browserLiveFromView(S, { state: "handoff", last_frame: { session_id: S, seq: 5, ts: "2026-11-07T10:00:00.000Z", url_host: "a", title: "A", w: 1, h: 1, sensitive: false, frame_url: "/new" }, actions: [], handoff: { session_id: S, seq: 6, reason: "login", url_host: "a", takeover_url: "/t", expires_at: "x" } }, prev);
    expect(v.status).toBe("handoff");
    expect(v.frames.map((f) => f.seq)).toEqual([1, 5]);
    expect(v.seq).toBe(6);
  });

  it("blocked by: household name, then label, then rule; nothing without label or source", () => {
    expect(blockedByText({ rule: "effect:send_external:allowlist" })).toBeNull();
    expect(blockedByText({ rule: "effect:spend", rule_label: "Dépenses" })).toBe("Dépenses");
    expect(blockedByText({ rule: "r", rule_label: "L", rule_source: { kind: "household", name: "Sites du foyer" } })).toBe("Sites du foyer");
    expect(blockedByText({ rule: "r", rule_source: { kind: "system" } })).toBe("r");
  });
});
