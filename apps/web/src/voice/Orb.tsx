/**
 * Voice orb: a disc of flowing colour (coral to ember, theme tokens) with a glyph and a short label, so the state is
 * never carried by colour or motion alone (`role="status"`, translated). WebGL layer loaded lazily (`orbGl.ts`) only
 * while an orb is visible and motion is allowed; without WebGL, or with `prefers-reduced-motion: reduce`, the CSS
 * version (static gradient, no animation) is what is shown. Visual only. Design after elevenlabs/ui `orb` (MIT, see orbGl.ts).
 */
import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { orbEnabled, type OrbState } from "./orbState.js";
import "./orb.css";

export function orbLabel(s: Exclude<OrbState, "off">): string {
  return s === "listening" ? tr("Listening") : s === "thinking" ? tr("Thinking") : s === "speaking" ? tr("Speaking") : s === "muted" ? tr("Muted") : tr("Voice ready");
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function Glyph({ state, size }: { state: Exclude<OrbState, "off">; size: number }): React.ReactElement {
  if (state === "thinking")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="orb-glyph" fill="currentColor">
        <circle cx="5" cy="12" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="19" cy="12" r="2" />
      </svg>
    );
  return <Icon name={state === "speaking" ? "soundOn" : state === "muted" ? "micOff" : "mic"} size={size} className="orb-glyph" />;
}

export function Orb({ state, size = "md", label = true }: { state: OrbState; size?: "sm" | "md" | "lg"; label?: boolean }): React.ReactElement | null {
  const wrap = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gl = useRef<{ setState(s: Exclude<OrbState, "off">): void; destroy(): void } | null>(null);
  const [live, setLive] = useState(false);
  const on = state !== "off" && orbEnabled();
  const shown: Exclude<OrbState, "off"> = state === "off" ? "idle" : state;

  useEffect(() => {
    if (!on || reducedMotion()) return;
    let dead = false;
    void import("./orbGl.js")
      .then((m) => {
        if (dead || !canvas.current || !wrap.current) return;
        const g = m.startOrbGl(canvas.current, wrap.current, () => setLive(false));
        if (!g) return;
        gl.current = g;
        g.setState(shown);
        setLive(true);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      gl.current?.destroy();
      gl.current = null;
      setLive(false);
    };
    // The renderer lives as long as the orb is on screen; state changes go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  useEffect(() => {
    gl.current?.setState(shown);
  }, [shown]);

  if (!on) return null;
  const px = size === "sm" ? 14 : size === "md" ? 20 : 44;
  return (
    <span ref={wrap} className="orb" data-orb={shown} data-orb-size={size} data-orb-gl={live ? "1" : "0"}>
      <span className="orb-body" aria-hidden="true">
        <span className="orb-css" />
        <canvas ref={canvas} className="orb-canvas" />
        <Glyph state={shown} size={px} />
      </span>
      <span className={label ? "orb-label" : "sr-only"} role="status" aria-live="polite">
        {orbLabel(shown)}
      </span>
    </span>
  );
}
