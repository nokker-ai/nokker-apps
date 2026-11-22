/**
 * Screens for the wall (core docs/SCREENS.md, lot V7, Lokkal, flag `ambient.screens.enabled`). The model composes a
 * screen from a CLOSED catalog of components; the core renders static HTML (no script, own CSP `default-src 'none'`).
 * Only the person publishes, through the bubble's `publish` action, then a STRONG card `wall:publish`.
 */
import type { BubbleAction, BubbleStatus } from "./bubbles.js";

/** State of the `screen` bubble (kernel kind, one per screen; a retouch updates the same bubble). `html` is the
 * preview WITHOUT household data, shown in `<iframe sandbox="" srcdoc>` (never allow-scripts nor allow-same-origin). */
export interface ScreenState {
  screen_id: string;
  version: number;
  title: string;
  status: "draft" | "pending" | "published";
  published_version: number | null;
  html: string | null;
  html_too_large: boolean;
  bubble_status?: BubbleStatus;
  /** `publish` (strong card) while a draft; `unpublish` once something is on the wall. */
  actions: BubbleAction[];
}

/** The published screen of the wall, in `GET /v1/glance` (wall surface): rendered by the core at read time, after the
 * wall filter. Shown in `<iframe sandbox="" srcdoc>` only. */
export interface GlanceScreen {
  id: string;
  version: number;
  title: string;
  html: string;
  /** Signed URL (5 min) of the same page served by the core under its own CSP; relative to the core. Prefer it to
   * `html`: a `srcdoc` page inherits the web's CSP (`style-src 'self'` blocks its style). */
  frame_url?: string;
}
