/**
 * Un bloc de texte dont la hauteur GLISSE vers celle que Pretext prédit (V5, drapeau `pretextEnabled`). Éteint ou texte non
 * éligible (plusieurs paragraphes, Markdown) : rend ses enfants tels quels. À chaque changement de texte, une animation du
 * navigateur (WAAPI) fait passer la hauteur de la prédiction d'avant à la nouvelle prédiction, sans attendre ni lire le
 * DOM : rien n'est posé en style, l'animation disparaît d'elle-même et le bloc retrouve sa vraie hauteur (`auto`). Une
 * prédiction fausse ne peut donc jamais couper le texte, seulement raccourcir ou rallonger le glissement.
 */
import React, { useLayoutEffect, useRef } from "react";
import { canvasFont, flowEligible, lineHeightPx, measureHeightNow, pretextEnabled } from "./pretext.js";

const GLIDE_MS = 220;

export function FlowBox({ text, className, as: Tag = "div", children }: { text: string; className?: string; as?: "div" | "span" | "p"; children: React.ReactNode }): React.ReactElement {
  const ref = useRef<HTMLElement | null>(null);
  const last = useRef<number | null>(null); // hauteur (boîte complète) prédite au passage d'avant
  const anim = useRef<Animation | null>(null);
  const on = pretextEnabled() && flowEligible(text);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    anim.current?.cancel();
    anim.current = null;
    if (!on || typeof el.animate !== "function") {
      el.removeAttribute("data-pretext");
      last.current = null;
      return;
    }
    const cs = getComputedStyle(el);
    const padH = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const hh = measureHeightNow(text, canvasFont(cs), el.clientWidth - padH, lineHeightPx(cs));
    if (hh === null) {
      el.setAttribute("data-pretext", "off"); // pas encore chargé : ce tour-ci sans glissement
      last.current = null;
      return;
    }
    const to = Math.ceil(hh + padV);
    const from = last.current;
    last.current = to;
    el.setAttribute("data-pretext", "on");
    if (from === null || Math.abs(from - to) < 1) return;
    const inner = cs.boxSizing === "border-box" ? 0 : padV; // `height` hors padding en content-box
    anim.current = el.animate(
      [
        { height: `${from - inner}px`, overflow: "hidden" },
        { height: `${to - inner}px`, overflow: "hidden" },
      ],
      { duration: GLIDE_MS, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)" },
    );
  }, [text, on]);

  useLayoutEffect(() => () => anim.current?.cancel(), []);

  return (
    <Tag ref={ref as React.Ref<never>} className={className}>
      {children}
    </Tag>
  );
}
