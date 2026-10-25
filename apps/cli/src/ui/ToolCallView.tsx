import React from "react";
import { Box, Text, useStdout } from "ink";
import { EFFECT_COLOR, formatToolLine, liveLines, previewLines, type ToolLine } from "../toolview.js";

/** Une ligne par appel (`⟳ patch src/app.py (écriture)` → `✓ patch src/app.py 120 ms`). L'aperçu du résultat
 * (3 lignes) est replié par défaut ; `expanded` le déplie (touche `o` sur la dernière ligne, `/out`, `/tools`
 * pour tout déplier). Pendant que le modèle écrit (`tool.input.delta`), les dernières lignes écrites défilent sous la
 * ligne, en gris ; le bloc se replie quand le résultat arrive. */
export function ToolCallView({ call, expanded }: { call: ToolLine; expanded: boolean }): React.ReactElement {
  const color = call.ok === false ? "red" : call.effect ? EFFECT_COLOR[call.effect] : "gray";
  const lines = previewLines(call.preview);
  const { stdout } = useStdout();
  const indent = 2 + call.depth * 2;
  const live = liveLines(call, undefined, Math.max(20, ((stdout as { columns?: number } | undefined)?.columns ?? 80) - indent - 6));
  return (
    <Box flexDirection="column" paddingLeft={indent}>
      <Text color={color}>
        {formatToolLine(call)}
        {lines.length > 0 && !expanded ? <Text dimColor> [o]</Text> : null}
      </Text>
      {live.map((l, i) => (
        <Text key={`live${i}`} color="gray" dimColor wrap="truncate">
          {"  │ "}
          {l}
        </Text>
      ))}
      {call.live != null && call.truncated ? <Text color="gray" dimColor>{"  │ "}…</Text> : null}
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
