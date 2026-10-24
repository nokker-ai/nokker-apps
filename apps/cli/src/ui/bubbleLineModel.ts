/**
 * Modèle pur d'une ligne de bulle compacte (BUBBLES.md §7 : « couleur + icône + libellé par type,
 * glow quand `working` »). Séparé de `BubbleLine.tsx` pour rester testable sans Ink : le terminal
 * n'a pas de `backdrop-filter`/glow réel, on simule par un spinner tournant pendant que la bulle
 * travaille (seul signal dynamique disponible en texte).
 */
import { BUBBLE_THEME, type BubbleKindTheme } from "@nokker-apps/brand";
import type { Bubble } from "@nokker-apps/sdk";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Un glyphe discret par icône sémantique de `packages/brand` — jamais d'emoji (cohérence avec le
 * reste de la marque, lisible même sans police couleur emoji). */
const ICON_GLYPH: Record<BubbleKindTheme["icon"], string> = {
  disk: "▤",
  search: "○",
  bell: "◆",
  timer: "◷",
  terminal: "▶",
  play: "►",
  bot: "✦",
  shield: "◈",
};

export interface BubbleLineModel {
  id: string;
  glyph: string;
  color: string;
  label: string;
  title: string;
  statusGlyph: string;
  /** `/goto <fil>` pour une bulle `notify` (BUBBLES.md §7) ; sinon `null`. */
  hint: string | null;
  shared: boolean;
}

function statusGlyphFor(status: Bubble["status"], spinnerFrame: number): string {
  switch (status) {
    case "working":
      return SPINNER_FRAMES[((spinnerFrame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length]!;
    case "done":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "·";
  }
}

/** `spinnerFrame` : compteur qui avance tant qu'au moins une bulle `working` existe (voir `App.tsx`). */
export function bubbleLineModel(bubble: Bubble, spinnerFrame: number): BubbleLineModel {
  const theme = BUBBLE_THEME[bubble.kind];
  return {
    id: bubble.id,
    glyph: ICON_GLYPH[theme.icon],
    color: theme.color,
    label: theme.label,
    title: bubble.title,
    statusGlyph: statusGlyphFor(bubble.status, spinnerFrame),
    hint: bubble.kind === "notify" ? `/goto ${bubble.state.from_thread}` : null,
    shared: bubble.shared === true,
  };
}
