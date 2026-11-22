/**
 * The wall's « Screen » view (lot V7, core docs/SCREENS.md §1): the screen the person PUBLISHED, as rendered by the core
 * at read time (static HTML, no script, own CSP `default-src 'none'`). Full frame, `<iframe sandbox="">`: no scripts, an
 * opaque origin, no link out. The view selector (Home / Screen / fallback) belongs to WallPage, which passes the
 * client's `resolveUrl` (the frame URL is relative to the core).
 */
import React, { useRef } from "react";
import type { GlanceScreen } from "@nokker-apps/sdk";
import { tr } from "../../i18n/index.js";
import "../../screen/screen.css";

export function WallScreenView({ screen, resolveUrl }: { screen: GlanceScreen; resolveUrl: (path: string) => string | null }): React.ReactElement {
  const title = tr("Wall screen: {0}", screen.title);
  // Each glance read signs a new URL: keep the FIRST one of this version, so the frame does not reload every minute
  // (the page is already loaded; a new version or screen gets a new URL and a new frame).
  const kept = useRef<{ key: string; src: string | null } | null>(null);
  const key = `${screen.id}-${screen.version}`;
  if (kept.current?.key !== key) kept.current = { key, src: screen.frame_url ? resolveUrl(screen.frame_url) : null };
  const src = kept.current.src;
  // The core's signed frame (own CSP) when it gives one; `srcdoc` only for an older core (no `frame_url`).
  return src ? (
    <iframe key={key} className="wall-screen-frame" data-testid="wall-screen" title={title} sandbox="" src={src} referrerPolicy="no-referrer" />
  ) : (
    <iframe key={key} className="wall-screen-frame" data-testid="wall-screen" title={title} sandbox="" srcDoc={screen.html} referrerPolicy="no-referrer" />
  );
}
