/**
 * Fond ambiant du mur (lot V1) : une lueur corail → braise qui dérive très lentement, à peine visible, plus sombre la
 * nuit. Pièce commune, écran allumé jour et nuit : faible contraste, aucune forme fixe (rien ne marque l'écran).
 * Toujours un fond CSS (repli, mouvement réduit, WebKit d'Apple) ; par-dessus, en fondu, le shader WebGL quand il est
 * permis (`glowMode` = "webgl"). Décoratif : aria-hidden, aucun clic.
 */
import React, { useEffect, useRef, useState } from "react";
import { currentGlowMode, mixHex, type GlowMode } from "./glow.js";
import type { WallShader } from "./wallShader.js";

const DAY_BG = "#f5f2ec";
const NIGHT_BG = "#000000";

/** Couleurs des taches, tirées des jetons de la marque, fondues dans le fond du mur. */
export function wallGlowColors(night: boolean, coral: string, ember: string): string[] {
  if (night) {
    // Nuit : presque noir, juste une braise sourde (l'écran baisse aussi sa luminosité côté natif).
    return [NIGHT_BG, mixHex(NIGHT_BG, ember, 0.07), NIGHT_BG, mixHex(NIGHT_BG, coral, 0.06)];
  }
  return [DAY_BG, mixHex(DAY_BG, coral, 0.12), mixHex(DAY_BG, ember, 0.1), DAY_BG];
}

function token(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-f]{3,6}$/i.test(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function WallGlow({ night }: { night: boolean }): React.ReactElement | null {
  const [mode, setMode] = useState<GlowMode>(() => currentGlowMode());
  const [glReady, setGlReady] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const shader = useRef<WallShader | null>(null);
  const colors = wallGlowColors(night, token("--brand-coral", "#e2474f"), token("--hot", "#a85400"));
  const key = colors.join(",");

  // Mouvement réduit changé à chaud : on suit.
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const on = (): void => setMode(currentGlowMode());
    mq.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, []);

  useEffect(() => {
    if (mode !== "webgl" || !host.current) return;
    let live = true;
    const el = host.current;
    void import("./wallShader.js")
      .then((m) => {
        if (!live) return;
        try {
          shader.current = m.mountWallShader(el, key.split(","), () => {
            // Contexte perdu (GPU réinitialisé, onglet évincé) : le fond CSS reste.
            setGlReady(false);
            setMode("css");
          });
          setGlReady(true);
        } catch {
          setMode("css");
        }
      })
      .catch(() => live && setMode("css"));
    return () => {
      live = false;
      shader.current?.dispose();
      shader.current = null;
      setGlReady(false);
    };
    // Les couleurs suivent via setColors (effet suivant) ; on ne remonte pas le shader pour elles.
  }, [mode]);

  useEffect(() => {
    shader.current?.setColors(key.split(","));
  }, [key]);

  if (mode === "off") return null;
  const [c0, c1, c2, c3] = colors;
  const style = { "--wg-bg": c0, "--wg-a": c1, "--wg-b": c2 === c0 ? c3 : c2, "--wg-c": c3 === c0 ? c1 : c3 } as React.CSSProperties;
  return (
    <div className={`nk-wall-glow${night ? " night" : ""}${mode === "static" ? " still" : ""}`} style={style} aria-hidden="true" data-wall-glow={mode}>
      <div className="nk-wall-glow-css" />
      {mode === "webgl" ? <div ref={host} className={`nk-wall-gl${glReady ? " ready" : ""}`} /> : null}
    </div>
  );
}
