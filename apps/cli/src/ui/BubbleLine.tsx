/**
 * Ligne de bulle compacte, repliée par défaut (BUBBLES.md §7) — une bulle au-dessus de la saisie,
 * couleur + icône + libellé par type, spinner à la place du statut pendant `working` (le terminal
 * n'a pas de glow réel). Le modèle (`bubbleLineModel.ts`) est pur et testé séparément ; ce composant
 * ne fait que le disposer avec `ink`.
 */
import React from "react";
import { Box, Text } from "ink";
import type { Bubble } from "@nokker-apps/sdk";
import { bubbleLineModel } from "./bubbleLineModel.js";

export function BubbleLine({ bubble, spinnerFrame }: { bubble: Bubble; spinnerFrame: number }): React.ReactElement {
  const m = bubbleLineModel(bubble, spinnerFrame);
  return (
    <Box>
      <Text color={m.color}>{m.glyph} </Text>
      <Text bold>{m.title}</Text>
      <Text dimColor>
        {" "}
        [{m.label}] {m.statusGlyph}
      </Text>
      {m.shared ? <Text dimColor> (partagée)</Text> : null}
      {m.hint ? <Text dimColor> — {m.hint}</Text> : null}
    </Box>
  );
}
