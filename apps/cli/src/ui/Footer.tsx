/**
 * Pied de tour — coût/tokens quand `turn.done` les donne (BUBBLES.md §6 : `usage`, `tier?`, `cost_chf?`).
 * Rien à afficher avant le premier tour terminé : `usage` est `null` jusque-là.
 */
import React from "react";
import { Box, Text } from "ink";
import type { TurnUsage } from "@nokker-apps/sdk";

export function Footer({
  usage,
  costChf,
}: {
  usage: TurnUsage | null;
  costChf: number | null;
}): React.ReactElement | null {
  if (!usage) return null;
  return (
    <Box>
      <Text dimColor>
        {usage.total_tokens} tokens ({usage.prompt_tokens}+{usage.completion_tokens})
        {costChf !== null && costChf !== undefined ? ` · ${costChf.toFixed(4)} CHF` : ""}
      </Text>
    </Box>
  );
}
