/**
 * Rendu réel (ink-testing-library) de la ligne d'outil avec l'écriture en direct (X22) : les dernières lignes écrites
 * défilent sous la ligne, « … » si le direct s'est arrêté, et le bloc disparaît quand le résultat arrive.
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { NokkerEvent } from "@nokker-apps/sdk";
import { applyToolEvent, type ToolLine } from "../src/toolview.js";
import { ToolCallView } from "../src/ui/ToolCallView.js";

const delta = (seq: number, text: string, extra: Record<string, unknown> = {}): NokkerEvent =>
  ({ type: "tool.input.delta", thread_id: "th_1", turn_id: "th_1:0", call_id: "c1", name: "write_file", path: "page.html", field: "content", seq, text, ...extra }) as NokkerEvent;

describe("ToolCallView (écriture en direct)", () => {
  it("montre les 6 dernières lignes sous la ligne de l'outil, puis replie au résultat", () => {
    let lines: ToolLine[] = applyToolEvent([], delta(0, ""));
    lines = applyToolEvent(lines, delta(1, Array.from({ length: 9 }, (_, i) => `<p>ligne ${i + 1}</p>\n`).join("")));
    const r = render(<ToolCallView call={lines[0]!} expanded={false} />);
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("⟳ write_file page.html");
    expect(frame).toContain("│ <p>ligne 9</p>");
    expect(frame).toContain("│ <p>ligne 4</p>");
    expect(frame).not.toContain("ligne 3<");
    lines = applyToolEvent(lines, delta(2, "", { truncated: true }));
    r.rerender(<ToolCallView call={lines[0]!} expanded={false} />);
    expect(r.lastFrame()).toContain("│ …");
    lines = applyToolEvent(lines, { type: "tool.result", thread_id: "th_1", call_id: "c1", name: "write_file", is_error: false, ms: 8 } as NokkerEvent);
    r.rerender(<ToolCallView call={lines[0]!} expanded={false} />);
    expect(r.lastFrame()).toContain("✓ write_file page.html 8 ms");
    expect(r.lastFrame()).not.toContain("│");
  });
});
