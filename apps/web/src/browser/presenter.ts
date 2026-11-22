/**
 * Présentatrice (V3 +, « Nina façon miss météo ») : drapeau `browser_live_presenter`, éteint par défaut. Le reste de
 * V3 n'en dépend pas. Allumé par la capacité du noyau, ou pour une recette par `VITE_NOKKER_PRESENTER=1` /
 * localStorage `nokker.web.presenter` = "1".
 */
import type { BrowserAction, BrowserLive, BrowserPoint, CapabilityName } from "@nokker-apps/sdk";
import { capability } from "../capabilities.js";
import { tr } from "../i18n/index.js";

export function presenterEnabled(): boolean {
  if (capability("browser_live_presenter" as CapabilityName) === true) return true;
  if (import.meta.env?.VITE_NOKKER_PRESENTER === "1") return true;
  try {
    return localStorage.getItem("nokker.web.presenter") === "1";
  } catch {
    return false;
  }
}

/** Nina en direct (Runway, <NinaLive>) sur le grand écran : drapeau noyau `nina_live`, ou `VITE_NOKKER_NINA_LIVE=1`.
 * Jamais dans la bulle (une salle vidéo par bulle) : le rig 2D y suffit. */
export function ninaLiveEnabled(): boolean {
  return capability("nina_live" as CapabilityName) === true || import.meta.env?.VITE_NOKKER_NINA_LIVE === "1";
}

/** Mode démo de /present : Nina LIVE (Runway) en vignette dans un coin libre, à côté du halo et du faisceau — plus de
 * Nina en pied ni de rig 2D. Drapeau `VITE_NOKKER_PRESENT_LIVE=1` ou localStorage `nokker.web.present.live` = "1" ; sans
 * lui, /present reste celle de V3 + (rig 2D, ou <NinaLive> dans son cadre). */
export function presentLiveEnabled(): boolean {
  if (import.meta.env?.VITE_NOKKER_PRESENT_LIVE === "1") return true;
  try {
    return localStorage.getItem("nokker.web.present.live") === "1";
  } catch {
    return false;
  }
}

type Box = { x: number; y: number; w: number; h: number };

/** Vignette de Nina sur la scène 16:9 (0–1) : 19 % de large, cadre CARRÉ (framing « head ») + indicateur et contrôles dessous. */
export const VIGNETTE = { w: 0.19, h: 0.5 } as const;

/** Centre du cadre carré de la vignette (0–1 de la scène) : d'où part le faisceau. */
export function vignetteOrigin(spot: Box): { x: number; y: number } {
  return { x: spot.x + spot.w / 2, y: spot.y + (spot.w * (16 / 9)) / 2 };
}
/** Zone sûre TV (5 %) : la vignette n'en sort jamais. */
const SAFE = 0.05;

const hit = (a: Box, b: Box, m = 0.02): boolean => a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;

/** Le coin où se pose la vignette : bas droite par défaut, puis haut droite, puis bas gauche, puis haut gauche ; le
 * premier qui ne recouvre ni la cible ni la page montrée (`avoid`, 0–1 de la scène). Jamais sur la cible. */
export function vignetteSpot(avoid: (Box | null)[]): Box {
  const w = VIGNETTE.w, h = VIGNETTE.h;
  const cands: Box[] = [
    { x: 1 - SAFE - w, y: 1 - SAFE - h, w, h },
    { x: 1 - SAFE - w, y: SAFE, w, h },
    { x: SAFE, y: 1 - SAFE - h, w, h },
    { x: SAFE, y: SAFE, w, h },
  ];
  const real = avoid.filter((b): b is Box => !!b);
  return cands.find((c) => !real.some((b) => hit(c, b))) ?? cands[0]!;
}

export type LiveState = "connecting" | "live" | "unavailable";

/** Ce que /present montre. Hors mode démo : le rig 2D et les bulles, comme avant. En mode démo : jamais le rig ; la
 * vignette tant que Nina live n'a pas dit « indisponible » (sinon halo + faisceau + sous-titres + bulles seuls). Les
 * bulles des cibles restent TOUJOURS (Nina ne narre pas les cibles : elles sont dites par les bulles et les sous-titres). */
export function presentLayout(p: { demo: boolean; liveOn: boolean; live: LiveState }): { vignette: boolean; rig: boolean; bubbles: boolean } {
  if (!p.demo) return { vignette: false, rig: true, bubbles: true };
  const vignette = p.liveOn && p.live !== "unavailable";
  return { vignette, rig: false, bubbles: true };
}

/** Ce que Nina dit d'une action (première ligne de sa bulle), d'après `target_label` — jamais une valeur saisie. */
export function sayAction(a: BrowserAction): string {
  // Jamais une action prétendue : un geste manqué le dit (relecture des textes, 07.11). Un geste refusé n'arrive pas ici : c'est la
  // carte qui le porte (presenterView).
  if (a.ok === false) return tr("That did not work: {0}", a.target_label);
  switch (a.kind) {
    case "navigate":
      return tr("I open {0}", a.url_host);
    case "click":
      return tr("I click on {0}", a.target_label);
    case "type":
      return tr("I fill in a field: {0}", a.target_label);
    case "scroll":
      return tr("I scroll down the page");
    case "read":
      return tr("I read: {0}", a.target_label);
    default:
      return tr("I wait for the page");
  }
}

export interface PresenterView {
  /** Zone désignée (0–1 de la frame affichée) : faisceau, halo, regard. */
  target: BrowserPoint["box"] | null;
  /** Les 3 dernières bulles, la plus récente en dernier. */
  bubbles: { key: string; text: string; why?: boolean }[];
  /** La phrase en cours (sous-titres de /present quand Nina live ne les donne pas). */
  caption: string | null;
}

/** Bulles et cible, d'après les actions et désignations de la session (la désignation l'emporte sur le curseur). */
export function presenterView(live: Pick<BrowserLive, "actions" | "points" | "frames">, cards: { id: string; seq: number; reason?: string; pending?: boolean; at?: string }[] = []): PresenterView {
  // Dans l'ordre où Nina les a dits (horodatage), la désignation après l'action qui l'a précédée.
  const t = (ts: string, seq: number): number => (Date.parse(ts) || 0) * 1000 + seq;
  const items: { seq: number; key: string; text: string; why?: boolean }[] = [
    ...live.actions.map((a) => ({ seq: t(a.ts, a.seq), key: `a${a.seq}`, text: sayAction(a) })),
    ...(live.points ?? []).map((p) => ({ seq: t(p.ts, p.seq + 0.5), key: `p${p.seq}`, text: p.why || p.label, why: true })),
    // Une carte en attente : Nina dit qu'elle attend l'accord, jamais qu'elle a fait le geste.
    ...cards.filter((c) => c.pending).map((c) => ({ seq: t(c.at ?? "", c.seq + 0.7), key: `c${c.id}`, text: tr("I'm waiting for your approval: {0}", c.reason ?? "") })),
  ].sort((x, y) => x.seq - y.seq);
  const frame = live.frames[live.frames.length - 1];
  const lastPoint = [...(live.points ?? [])].reverse().find((p) => !frame || p.seq <= frame.seq + 2) ?? null;
  const lastAction = live.actions[live.actions.length - 1];
  // `seq` de l'action = compteur de la session ; celui d'une désignation = `frame_seq` (autre compteur) : on ne les compare
  // pas entre eux. L'horodatage tranche (la plus récente l'emporte) ; sans horodatage lisible, repli sur `seq`.
  const aMs = lastAction ? Date.parse(lastAction.ts) : NaN;
  const pMs = lastPoint ? Date.parse(lastPoint.ts) : NaN;
  const newer = lastAction && lastPoint ? (Number.isNaN(aMs) || Number.isNaN(pMs) ? lastAction.seq > lastPoint.seq + 1 : aMs > pMs) : !!lastAction && !lastPoint;
  const cursor = newer && lastAction?.cursor ? { x: lastAction.cursor.x - 0.03, y: lastAction.cursor.y - 0.03, w: 0.06, h: 0.06 } : null;
  const target = frame?.sensitive ? null : newer ? cursor : (lastPoint?.box ?? cursor);
  const bubbles = items.slice(-3).map(({ key, text, why }) => ({ key, text, why }));
  // Sous-titres = ce que Nina DIT (ses gestes), jamais la raison courte de sa bulle (pas de doublon) ; <NinaLive>
  // fournira le vrai texte parlé.
  const said = [...items].reverse().find((x) => !x.why);
  return { target, bubbles, caption: said?.text ?? null };
}

/** Angle de l'encadré vers la cible (regard simulé : Runway ne pilote pas le regard), borné à ±14°. */
export function lookAngle(origin: { x: number; y: number }, target: { x: number; y: number; w: number; h: number } | null): number {
  if (!target) return 0;
  const dx = target.x + target.w / 2 - origin.x;
  return Math.max(-14, Math.min(14, dx * 30));
}

/** Cadre de la frame sur la scène 16:9 de /present (zone à gauche, sans bande noire) et passage d'une boîte de la
 * frame (0–1) à la scène (0–1). */
export function stageFrameBox(frameRatio: number, area = { x: 0.05, y: 0.1, w: 0.56, h: 0.68 }, stageRatio = 16 / 9): { x: number; y: number; w: number; h: number } {
  const areaRatio = (area.w * stageRatio) / area.h;
  if (frameRatio >= areaRatio) {
    const h = (area.w * stageRatio) / frameRatio;
    return { x: area.x, y: area.y + (area.h - h) / 2, w: area.w, h };
  }
  const w = (area.h * frameRatio) / stageRatio;
  return { x: area.x + (area.w - w) / 2, y: area.y, w, h: area.h };
}

export const toStage = (f: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number } | null): { x: number; y: number; w: number; h: number } | null =>
  b ? { x: f.x + b.x * f.w, y: f.y + b.y * f.h, w: b.w * f.w, h: b.h * f.h } : null;
