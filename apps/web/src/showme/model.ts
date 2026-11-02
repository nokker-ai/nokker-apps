/**
 * « Show me » mode (core docs/SHOW-ME.md): Nina points instead of clicking. Build flag `VITE_NOKKER_SHOW_ME=1`, OFF by
 * default: off, no `data-show-me` anchor is written, no overlay is mounted and a `pointer` bubble renders as an unknown
 * kind — the app is the same as before.
 */
import type { Bubble, PointerState } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

let flag: boolean = import.meta.env?.VITE_NOKKER_SHOW_ME === "1";

export function showMeEnabled(): boolean {
  return flag;
}

/** Tests only. */
export function setShowMeForTests(on: boolean): void {
  flag = on;
}

/** Marks an element of the interface a pointer can aim at (`ui` of the core's closed list). Off: no attribute. */
export function anchor(id: string): Record<string, string> {
  return flag ? { "data-show-me": id } : {};
}

/** Marks the element that LEADS to hidden targets (the drawer button on a phone). Off: no attribute. */
export function anchorVia(ids: string[]): Record<string, string> {
  return flag ? { "data-show-me-via": ids.join(" ") } : {};
}

/** « Step 1 of 2 », « Step 2 », or nothing outside a guide. */
export function stepLabel(st: Pick<PointerState, "step" | "steps">): string {
  if (!st.step) return "";
  return st.steps ? tr("Step {0} of {1}", st.step, st.steps) : tr("Step {0}", st.step);
}

/** Name of an interface element, for the sign and screen readers. */
export function uiName(ui: string): string {
  switch (ui) {
    case "composer":
      return tr("the message box");
    case "attach":
      return tr("the paperclip (attach)");
    case "send":
      return tr("the Send button");
    case "new_session":
      return tr("the “+” new session button");
    case "sessions":
      return tr("the list of sessions");
    case "account":
      return tr("the account menu");
    case "bubbles":
      return tr("the bubbles");
    default:
      return ui;
  }
}

/** Where the sign sits around the point, so that both stay inside the picture: the arrow comes from the roomier side. */
export type Side = "nw" | "ne" | "sw" | "se";
export function signSide(x: number, y: number): Side {
  return `${y > 50 ? "n" : "s"}${x > 50 ? "w" : "e"}` as Side;
}

/** Clamps a percentage (the core sends 0–100; anything else is drawn on the edge, never outside). */
export function pct(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 50;
  return Math.min(100, Math.max(0, n));
}

/** Open pointer of the thread whose target is an interface element (the overlay draws it over the app itself). */
export function uiPointer(bubbles: Bubble[]): (Bubble & { kind: "pointer" }) | null {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]!;
    if (b.kind === "pointer" && !b.closed_at && b.state?.target?.kind === "ui") return b as Bubble & { kind: "pointer" };
  }
  return null;
}

/** Minimal element shape for `findAnchor` (a DOM `Element`, or a test double). */
export interface AnchorEl {
  getAttribute(name: string): string | null;
  /** false: hidden (`display: none`, closed drawer with `inert`, off screen). */
  visible: boolean;
}

/** The visible element marked `data-show-me="<ui>"`, else a visible element that leads to it (`data-show-me-via`). */
export function findAnchor<T extends AnchorEl>(els: T[], ui: string): { el: T; via: boolean } | null {
  const direct = els.find((e) => e.visible && e.getAttribute("data-show-me") === ui);
  if (direct) return { el: direct, via: false };
  const via = els.find((e) => e.visible && (e.getAttribute("data-show-me-via") ?? "").split(" ").includes(ui));
  return via ? { el: via, via: true } : null;
}

/** Title of a bubble as shown: a `pointer` gets its title here, in the interface language, from its step (the core's
 * title is French data for the model's turn); any other bubble keeps its own. Off: every bubble keeps its own. */
export function displayTitle(b: Bubble): string {
  if (b.kind !== "pointer" || !flag) return b.title;
  return stepLabel(b.state ?? { step: null, steps: null }) || tr("Show me");
}
