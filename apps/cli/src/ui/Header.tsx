/**
 * En-tête de marque — emblème ASCII discret (pas un bandeau multi-lignes), nom du fil, modèle/palier
 * si connu (posé par `turn.done.tier`, APPROVALS.md/BUBBLES.md n'imposent rien de plus en P1).
 */
import React from "react";
import { Box, Text } from "ink";
import { BRAND } from "@nokker-apps/brand";
import { t } from "../i18n/index.js";

/** Heurtoir discret (identité « Knocks for you », packages/brand/src/signature.ts) — un seul glyphe,
 * pas un ASCII art multi-lignes : ce bandeau doit tenir sur ≥ 60 colonnes. */
const EMBLEM = "◉";

export function Header({
  threadLabel,
  folder,
  status,
  goal = null,
  loops = null,
  permMode = null,
}: {
  threadLabel: string;
  /** Nom du dossier de la session locale (`null` = fil ordinaire). */
  folder: string | null;
  status: string;
  /** Objectif de session (`/goal`), ligne déjà formatée. */
  goal?: string | null;
  /** Boucles `/loop` en cours, ligne déjà formatée. */
  loops?: string | null;
  /** Mode de permission de la session (`modeStatus`), mis à jour par `session.mode`. */
  permMode?: string | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="#E3B06A">{EMBLEM} </Text>
        <Text bold color="cyanBright">
          {BRAND.productName}
        </Text>
        {folder ? <Text bold> {folder}</Text> : null}
        <Text dimColor> — {t("thread {0} · model: auto routing", shortLabel(threadLabel))}</Text>
      </Box>
      <Text dimColor>
        {t("status: {0}", status)}
        {permMode ? ` · ${permMode}` : ""}
      </Text>
      {goal ? <Text color="cyan">◎ {goal}</Text> : null}
      {loops ? <Text color="cyan">⟳ {loops}</Text> : null}
    </Box>
  );
}

/** Le titre d'un fil peut être la première phrase de la demande : 32 caractères au plus (ou l'id court tant qu'il n'y en a pas). */
export function shortLabel(label: string, max = 32): string {
  const one = label.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
