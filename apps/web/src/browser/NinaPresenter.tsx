/**
 * `<NinaPresenter>` — Nina présentatrice dans la bulle navigateur et sur /present (drapeau `browser_live_presenter`).
 * Entrées : `gaze`, `point` (boîte 0–1 de la scène), `talking`, `emotion`, `state`. Le moteur est le rig 2D de Nina
 * (TalkingAvatar) en attendant `<NinaLive>` (Runway : tête et buste, sans geste ni regard pilotable) : le POINTAGE est
 * un faisceau corail de l'encadré vers la cible, avec un halo sur la cible ; l'encadré pivote vers la cible pour le
 * sens du regard ; les bulles d'explication s'empilent derrière elle. Avec prefers-reduced-motion : rien n'anime.
 */
import React, { Suspense, lazy } from "react";
import { tr } from "../i18n/index.js";
import { lookAngle } from "./presenter.js";
import "./presenter.css";

const TalkingAvatar = lazy(() => import("../avatar/TalkingAvatar.js").then((m) => ({ default: m.TalkingAvatar })));

export type PresenterState = "idle" | "listening" | "thinking" | "speaking";
type Box = { x: number; y: number; w: number; h: number };

export interface NinaPresenterProps {
  /** Là où elle regarde (0–1 de la scène) ; par défaut la cible désignée. */
  gaze?: { x: number; y: number } | null;
  /** La zone qu'elle désigne (0–1 de la scène). */
  point?: Box | null;
  talking?: boolean;
  emotion?: "neutral" | "happy" | "concerned";
  state?: PresenterState;
  /** Ses bulles d'explication, la plus récente en dernier. */
  bubbles?: { key: string; text: string; why?: boolean }[];
  /** « bubble » : encadré en bas à gauche de la capture ; « stage » : grand écran 16:9, Nina en plan taille à droite. */
  variant?: "bubble" | "stage";
  lang?: string;
  /** Emplacement de `<NinaLive>` quand il existe (sinon le rig 2D). */
  live?: React.ReactNode;
  /** Origine du faisceau (0–1 de la scène) : le centre de la vignette de Nina ; défaut : celle du rig. */
  origin?: { x: number; y: number } | null;
  /** Pas de cadre ni d'avatar ici (Nina est une vignette posée par la page) : faisceau, halo et bulles restent. */
  bare?: boolean;
}

export function NinaPresenter(p: NinaPresenterProps): React.ReactElement {
  const variant = p.variant ?? "bubble";
  // Origine du faisceau (main de Nina / haut de l'encadré), en 0–1 de la scène.
  const origin = p.origin ?? (variant === "stage" ? { x: 0.66, y: 0.5 } : { x: 0.16, y: 0.66 });
  const target = p.point ?? null;
  const look = p.gaze ? { x: p.gaze.x, y: p.gaze.y, w: 0, h: 0 } : target;
  // Grand écran : pas de pivot (un grand cadre penché paraît déformé) ; le sens du regard passe par un léger
  // glissement vers la cible et une ombre portée de ce côté. Dans la bulle, le petit pivot reste lisible.
  const toward = look ? Math.sign(look.x + look.w / 2 - origin.x) : 0;
  const angle = variant === "stage" ? 0 : lookAngle(origin, look);
  const frameStyle: React.CSSProperties =
    variant === "stage"
      ? { transform: `translateX(${toward * 1.2}%)`, boxShadow: `${toward * 28}px 18px 48px rgba(0, 0, 0, 0.45), 0 0 0 3px rgba(226, 87, 76, 0.7)` }
      : { transform: `perspective(600px) rotateY(${angle}deg) translateX(${angle * 0.4}px)` };
  const bubbles = variant === "stage" ? p.bubbles : p.bubbles?.slice(-2);
  const tx = target ? target.x + target.w / 2 : 0;
  const ty = target ? target.y + target.h / 2 : 0;
  return (
    <div className={`np np-${variant}${p.bare ? " np-bare" : ""}`} data-np={p.state ?? "idle"} aria-hidden={variant === "bubble" ? true : undefined}>
      {target ? (
        <>
          {/* Coordonnées en % de la scène, SANS viewBox étiré : l'épaisseur et le tracé restent en pixels. */}
          <svg className="np-beam" aria-hidden="true" data-np-beam>
            <defs>
              <linearGradient id={`np-g-${variant}`} x1={`${origin.x * 100}%`} y1={`${origin.y * 100}%`} x2={`${tx * 100}%`} y2={`${ty * 100}%`} gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#e2574c" stopOpacity="0.55" />
                <stop offset="1" stopColor="#ff8a5c" stopOpacity="0.95" />
              </linearGradient>
            </defs>
            {/* Le trait apparaît de Nina vers la cible (impulsion), puis une lueur le parcourt. */}
            <line key={`${tx}-${ty}`} x1={`${origin.x * 100}%`} y1={`${origin.y * 100}%`} x2={`${tx * 100}%`} y2={`${ty * 100}%`} stroke={`url(#np-g-${variant})`} strokeWidth={variant === "stage" ? 9 : 3} strokeLinecap="round" pathLength={100} className="np-beam-line" />
            <line key={`p${tx}-${ty}`} x1={`${origin.x * 100}%`} y1={`${origin.y * 100}%`} x2={`${tx * 100}%`} y2={`${ty * 100}%`} stroke="#fff3ec" strokeOpacity="0.9" strokeWidth={variant === "stage" ? 4 : 1.6} strokeLinecap="round" pathLength={100} className="np-beam-pulse" />
          </svg>
          <span className="np-halo" style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%`, width: `${target.w * 100}%`, height: `${target.h * 100}%` }} data-np-halo />
          <span className="np-lion" style={{ left: `${tx * 100}%`, top: `${ty * 100}%` }} aria-hidden="true">
            <img src="/brand/nokker-emblem-small-light.svg" alt="" width="18" height="18" />
          </span>
        </>
      ) : null}
      <div className="np-host">
        {bubbles?.length ? (
          <ol className="np-bubbles" aria-live={variant === "stage" ? "polite" : undefined} data-np-bubbles>
            {bubbles.map((b, i) => (
              <li key={b.key} className={`${b.why ? "why" : ""} ${i === bubbles.length - 1 ? "last" : ""}`}>
                {b.text}
              </li>
            ))}
          </ol>
        ) : null}
        {p.bare ? null : <div className="np-frame" style={frameStyle} data-np-frame>
          {p.live ?? (
            <Suspense fallback={<span className="np-placeholder" />}>
              <TalkingAvatar avatarUrl="/avatars/nina-v1/" lang={p.lang ?? "fr"} framing={variant === "stage" ? "upper" : "head"} className="np-avatar" />
            </Suspense>
          )}
          <span className="np-name">{tr("Nina")}</span>
        </div>}
      </div>
    </div>
  );
}
