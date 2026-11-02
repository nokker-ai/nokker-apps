import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Bubble } from "@nokker-apps/sdk";
import { bubbleLabel } from "../src/bubbles/kinds.js";
import { setShellLang } from "../src/i18n/index.js";
import { anchor, anchorVia, displayTitle, findAnchor, pct, setShowMeForTests, showMeEnabled, signSide, stepLabel, uiPointer } from "../src/showme/model.js";

afterEach(() => {
  setShellLang(null);
  setShowMeForTests(false);
});

function pointer(id: string, target: object, extra: Partial<Bubble> = {}): Bubble {
  return {
    id,
    thread_id: "th_1",
    kind: "pointer",
    title: "Étape 1 sur 2",
    status: "idle",
    state: { target, caption: "Clique ici", step: 1, steps: 2, waiting: false, answer: null },
    actions: [],
    origin: null,
    shared_with: { members: [], threads: [] },
    created_by: "nina",
    created_at: "2026-11-02T08:00:00Z",
    updated_at: "2026-11-02T08:00:00Z",
    closed_at: null,
    version: 1,
    ...extra,
  } as Bubble;
}

describe("show me — flag", () => {
  it("off by default: no anchor written, a pointer bubble is an unknown kind (the app is unchanged)", () => {
    expect(showMeEnabled()).toBe(false);
    expect(anchor("attach")).toEqual({});
    expect(anchorVia(["sessions"])).toEqual({});
    setShellLang("en");
    expect(bubbleLabel("pointer")).toBe(bubbleLabel("no-such-kind"));
  });
  it("on: anchors and label", () => {
    setShowMeForTests(true);
    expect(anchor("attach")).toEqual({ "data-show-me": "attach" });
    expect(anchorVia(["sessions", "new_session"])).toEqual({ "data-show-me-via": "sessions new_session" });
    setShellLang("fr");
    expect(bubbleLabel("pointer")).toBe("Montre-moi");
  });
});

describe("show me — model", () => {
  it("step label in the interface language", () => {
    setShellLang("en");
    expect(stepLabel({ step: 1, steps: 2 })).toBe("Step 1 of 2");
    expect(stepLabel({ step: 3, steps: null })).toBe("Step 3");
    expect(stepLabel({ step: null, steps: null })).toBe("");
    setShellLang("fr");
    expect(stepLabel({ step: 1, steps: 2 })).toBe("Étape 1 sur 2");
  });
  it("the sign goes to the roomier side, the point is clamped to the picture", () => {
    expect(signSide(10, 10)).toBe("se");
    expect(signSide(90, 10)).toBe("sw");
    expect(signSide(10, 90)).toBe("ne");
    expect(signSide(90, 90)).toBe("nw");
    expect([pct(-5), pct(120), pct(42.2), pct("x"), pct(Number.NaN)]).toEqual([0, 100, 42.2, 50, 50]);
  });
  it("anchor: the visible element, else the one that leads to it, else nothing", () => {
    const el = (attrs: Record<string, string>, visible: boolean) => ({ visible, getAttribute: (n: string) => attrs[n] ?? null });
    const hiddenNew = el({ "data-show-me": "new_session" }, false);
    const fab = el({ "data-show-me-via": "sessions new_session" }, true);
    const send = el({ "data-show-me": "send" }, true);
    expect(findAnchor([hiddenNew, fab, send], "send")).toEqual({ el: send, via: false });
    expect(findAnchor([hiddenNew, fab, send], "new_session")).toEqual({ el: fab, via: true });
    expect(findAnchor([hiddenNew, send], "new_session")).toBeNull();
    expect(findAnchor([el({ "data-show-me-via": "sessions_x" }, true)], "sessions")).toBeNull();
  });
  it("the overlay follows the latest OPEN pointer aimed at the interface only", () => {
    const ui = pointer("bu_ui", { kind: "ui", ui: "attach" });
    const img = pointer("bu_img", { kind: "image", sha256: "a".repeat(64), media_type: "image/png", name: "", x: 1, y: 1 });
    const closed = pointer("bu_old", { kind: "ui", ui: "send" }, { closed_at: "2026-11-02T08:01:00Z" });
    expect(uiPointer([ui, img])?.id).toBe("bu_ui");
    expect(uiPointer([img])).toBeNull();
    expect(uiPointer([ui, closed])?.id).toBe("bu_ui");
  });
  it("untrusted text is never rendered as HTML", () => {
    for (const f of ["PointerBody.tsx", "ShowMeOverlay.tsx"]) {
      const src = readFileSync(fileURLToPath(new URL(`../src/showme/${f}`, import.meta.url)), "utf8");
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|Markdown/);
    }
  });
  it("the title is written by the web in the interface language; off, the bubble keeps its own", () => {
    const b = pointer("bu_t", { kind: "ui", ui: "send" });
    expect(displayTitle(b)).toBe("Étape 1 sur 2"); // off: the core's title, unchanged
    setShowMeForTests(true);
    setShellLang("en");
    expect(displayTitle(b)).toBe("Step 1 of 2");
    expect(displayTitle(pointer("bu_n", { kind: "ui", ui: "send" }, { state: { target: { kind: "ui", ui: "send" }, caption: "x", step: null, steps: null, waiting: false, answer: null } } as Partial<Bubble>))).toBe("Show me");
    setShellLang("fr");
    expect(displayTitle(b)).toBe("Étape 1 sur 2");
    expect(displayTitle({ ...b, kind: "media", title: "Aperçu" } as unknown as Bubble)).toBe("Aperçu");
  });
});
