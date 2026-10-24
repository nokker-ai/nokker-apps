import { describe, expect, it } from "vitest";
import { BUBBLE_THEME } from "@nokker-apps/brand";
import type { Bubble } from "@nokker-apps/sdk";
import { SPINNER_FRAMES, bubbleLineModel } from "../src/ui/bubbleLineModel.js";

function monitorBubble(status: Bubble["status"]): Bubble {
  return {
    id: "bu_disk1",
    thread_id: "th_infra",
    kind: "monitor",
    title: "Disque host-1 /",
    status,
    state: { target: "host-1:/", metric: "disk_used", value: 91, unit: "%" },
    actions: [],
    origin: null,
    shared_with: { members: [], threads: [] },
    created_by: "nina",
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
    closed_at: null,
    version: 1,
  } as Bubble;
}

function notifyBubble(): Bubble {
  return {
    id: "bu_notify1",
    thread_id: null,
    kind: "notify",
    title: "Compta",
    status: "done",
    state: { from_thread: "th_compta", from_title: "Compta", text: "Facture reçue", approval_id: null, actions: [] },
    actions: [],
    origin: null,
    shared_with: { members: ["alice"], threads: [] },
    created_by: "nina",
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
    closed_at: null,
    version: 1,
    shared: true,
  } as Bubble;
}

describe("bubbleLineModel", () => {
  it("reprend couleur et libellé du thème de marque (monitor)", () => {
    const m = bubbleLineModel(monitorBubble("idle"), 0);
    expect(m.color).toBe(BUBBLE_THEME.monitor.color);
    expect(m.label).toBe(BUBBLE_THEME.monitor.label);
    expect(m.title).toBe("Disque host-1 /");
  });

  it("statut idle → glyphe neutre", () => {
    expect(bubbleLineModel(monitorBubble("idle"), 0).statusGlyph).toBe("·");
  });

  it("statut done → ✓, failed → ✗", () => {
    expect(bubbleLineModel(monitorBubble("done"), 0).statusGlyph).toBe("✓");
    expect(bubbleLineModel(monitorBubble("failed"), 0).statusGlyph).toBe("✗");
  });

  it("statut working → spinner qui tourne avec spinnerFrame", () => {
    const b = monitorBubble("working");
    expect(bubbleLineModel(b, 0).statusGlyph).toBe(SPINNER_FRAMES[0]);
    expect(bubbleLineModel(b, 1).statusGlyph).toBe(SPINNER_FRAMES[1]);
    expect(bubbleLineModel(b, SPINNER_FRAMES.length).statusGlyph).toBe(SPINNER_FRAMES[0]); // boucle
  });

  it("bulle notify porte un indice /goto <fil>", () => {
    const m = bubbleLineModel(notifyBubble(), 0);
    expect(m.hint).toBe("/goto th_compta");
  });

  it("bulle non-notify n'a pas d'indice", () => {
    expect(bubbleLineModel(monitorBubble("idle"), 0).hint).toBeNull();
  });

  it("shared: true est reporté sur le modèle", () => {
    expect(bubbleLineModel(notifyBubble(), 0).shared).toBe(true);
    expect(bubbleLineModel(monitorBubble("idle"), 0).shared).toBe(false);
  });
});
