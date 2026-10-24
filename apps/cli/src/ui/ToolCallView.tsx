import React from "react";
import { Box, Text } from "ink";
import { EFFECT_COLOR, formatToolLine, previewLines, type ToolLine } from "../toolview.js";

/** Une ligne par appel (`⟳ patch src/app.py (écriture)` → `✓ patch src/app.py 120 ms`). L'aperçu du résultat
 * (3 lignes) est replié par défaut ; `expanded` le déplie (touche `o` sur la dernière ligne, `/out`, `/tools`
 * pour tout déplier). */
export function ToolCallView({ call, expanded }: { call: ToolLine; expanded: boolean }): React.ReactElement {
  const color = call.ok === false ? "red" : call.effect ? EFFECT_COLOR[call.effect] : "gray";
  const lines = previewLines(call.preview);
  return (
    <Box flexDirection="column" paddingLeft={2 + call.depth * 2}>
      <Text color={color}>
        {formatToolLine(call)}
        {lines.length > 0 && !expanded ? <Text dimColor> [o]</Text> : null}
      </Text>
      {expanded
        ? lines.map((l, i) => (
            <Text key={i} dimColor>
              {"    "}
              {l}
            </Text>
          ))
        : null}
    </Box>
  );
}
