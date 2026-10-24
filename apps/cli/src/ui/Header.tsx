/**
 * En-tête de marque — emblème ASCII discret (pas un bandeau multi-lignes), nom du fil, modèle/palier
 * si connu (posé par `turn.done.tier`, APPROVALS.md/BUBBLES.md n'imposent rien de plus en P1).
 */
import React from "react";
import { Box, Text } from "ink";
import { BRAND } from "@nokker-apps/brand";

/** Heurtoir discret (identité « Knocks for you », packages/brand/src/signature.ts) — un seul glyphe,
 * pas un ASCII art multi-lignes : ce bandeau doit tenir sur ≥ 60 colonnes. */
const EMBLEM = "◉";

export function Header({
  threadLabel,
  folder,
  status,
}: {
  threadLabel: string;
  /** Nom du dossier de la session locale (`null` = fil ordinaire). */
  folder: string | null;
  status: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="#E3B06A">{EMBLEM} </Text>
        <Text bold color="cyanBright">
          {BRAND.productName}
        </Text>
        {folder ? <Text bold> {folder}</Text> : null}
        <Text dimColor> — fil {shortLabel(threadLabel)} · modèle : routage auto</Text>
      </Box>
      <Text dimColor>statut : {status}</Text>
    </Box>
  );
}

/** Le titre d'un fil peut être la première phrase de la demande : 32 caractères au plus (ou l'id court tant qu'il n'y en a pas). */
export function shortLabel(label: string, max = 32): string {
  const one = label.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
