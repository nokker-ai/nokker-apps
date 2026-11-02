/**
 * Arrow + sign drawn OVER the app itself when the open `pointer` of the thread aims at an interface element (core
 * docs/SHOW-ME.md §4): the element marked `data-show-me="<ui>"`, or, if it is hidden (closed drawer on a phone), the one
 * marked `data-show-me-via` that leads to it. Clicks go through (pointer-events: none), except the sign's « Hide ».
 * Mounted only when the flag is on.
 */
import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "../context.js";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { findAnchor, signSide, stepLabel, uiName, uiPointer, type AnchorEl, type Side } from "./model.js";
import { Arrow } from "./Arrow.js";
import { clearLocalPoint, getLocalPoint, subscribeLocalPoint } from "./local.js";
import "./showme.css";

// « Show me where » in the bubble: a counter that re-opens a hidden overlay.
let replays = 0;
const listeners = new Set<() => void>();
export function replayOverlay(): void {
  replays += 1;
  listeners.forEach((l) => l());
}
function useReplays(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => replays,
  );
}

function useLocalPoint(): ReturnType<typeof getLocalPoint> {
  return useSyncExternalStore(subscribeLocalPoint, getLocalPoint);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  side: Side;
  via: boolean;
}

const ARROW = 64;
// Phone (the app's narrow layout, ≤ 760 px): compact arrow and pill.
const COMPACT_MAX = 760;
const SMALL = 40;
const PILL_W = 170;
const BIG = 56;
const PILL_W_DESKTOP = 420;

function visible(el: Element): boolean {
  if (el.closest("[inert]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

function locate(ui: string): Box | null {
  const els: Array<AnchorEl & { el: Element }> = [...document.querySelectorAll("[data-show-me],[data-show-me-via]")].map((el) => ({
    el,
    visible: visible(el),
    getAttribute: (n: string) => el.getAttribute(n),
  }));
  const hit = findAnchor(els, ui);
  if (!hit) return null;
  const r = hit.el.el.getBoundingClientRect();
  const cx = ((r.left + r.width / 2) / window.innerWidth) * 100;
  const cy = ((r.top + r.height / 2) / window.innerHeight) * 100;
  return { x: r.left, y: r.top, w: r.width, h: r.height, side: signSide(cx, cy), via: hit.via };
}

export function ShowMeOverlay(): React.ReactElement | null {
  const store = useStore();
  const p = uiPointer(store.bubbles);
  const replay = useReplays();
  // A local point (the Guide's « Show me ») wins over a bubble's pointer: the person just asked for it.
  const local = useLocalPoint();
  const key = local ? `local:${local.n}` : p ? `${p.id}:${p.version}:${replay}` : "";
  const [hidden, setHidden] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const ui = local ? local.ui : p && p.state.target.kind === "ui" ? p.state.target.ui : null;
  const waiting = !local && !!p?.state.waiting;

  const measure = useCallback(() => setBox(ui ? locate(ui) : null), [ui]);
  useEffect(() => {
    if (!ui || waiting || hidden === key) return;
    measure();
    // The layout moves (drawer, keyboard, bubbles): measure again, cheaply, while the arrow is shown.
    const t = window.setInterval(measure, 400);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [ui, waiting, hidden, key, measure]);

  if ((!p && !local) || !ui || waiting || hidden === key || !box) return null;
  const pad = 6;
  const ring = { left: box.x - pad, top: box.y - pad, width: box.w + 2 * pad, height: box.h + 2 * pad };
  const step = local || !p ? "" : stepLabel(p.state);
  const caption = local || !p ? tr("Look where the arrow points.") : p.state.caption;
  // A big arrow and a sign BESIDE the target, on its own row (left or right, towards the roomier side): the
  // conversation is never covered. Phone: smaller arrow, the sign says the step only (the caption is in the bubble).
  const vw = window.innerWidth;
  const phone = vw <= COMPACT_MAX;
  const size = phone ? SMALL : BIG;
  const east = ring.left + ring.width / 2 < vw / 2;
  const cy = ring.top + ring.height / 2;
  const ax = east ? ring.left + ring.width + 2 : ring.left - 2 - size;
  const room = east ? vw - (ax + size) - 8 : ax - 8;
  const pillW = Math.max(0, Math.min(phone ? PILL_W : PILL_W_DESKTOP, room));
  const pillLeft = east ? ax + size : ax - pillW;
  const head = box.via ? tr("Open this first") : step || tr("Here");
  return (
    <div className="showme-overlay" aria-live="polite">
      <span className="showme-ring" style={ring} />
      <span className={`showme-float compact ${east ? "dir-e" : "dir-w"}`} style={{ left: ax, top: cy - size / 2, width: size, height: size }}>
        <Arrow />
      </span>
      {pillW >= 64 ? (
        <span className="showme-pill" role="note" style={{ left: pillLeft, top: cy - 16, maxWidth: pillW }} title={caption}>
          <span className="showme-pill-text">
            <strong>{head}</strong>
            {!phone ? ` · ${box.via ? tr("{0} is inside.", uiName(ui)) : caption}` : null}
          </span>
          <button type="button" className="showme-x" aria-label={tr("Hide")} onClick={() => (local ? clearLocalPoint() : setHidden(key))}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ) : null}
      <span className="sr-only">{caption}</span>
    </div>
  );
}
