/**
 * Rendu markdown → Ink, volontairement minimal (pas de dépendance coloration syntaxique lourde
 * type highlight.js) : titres, listes, **gras**, *italique*, `code` en ligne, blocs ```code```.
 * Suffisant pour les réponses de l'agente (texte + extraits de code courts) ; un besoin de
 * coloration syntaxique réelle serait un ajout ciblé (ex. `shiki`), pas une réécriture.
 */
import React from "react";
import { Box, Text } from "ink";

interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function parseInline(line: string): Segment[] {
  const segments: Segment[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(line))) {
    if (match.index > lastIndex) segments.push({ text: line.slice(lastIndex, match.index) });
    if (match[2] !== undefined) segments.push({ text: match[2], bold: true });
    else if (match[3] !== undefined) segments.push({ text: match[3], italic: true });
    else if (match[4] !== undefined) segments.push({ text: match[4], code: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) segments.push({ text: line.slice(lastIndex) });
  return segments;
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  const blocks: React.ReactElement[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1];
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // saute la fermeture ```
      blocks.push(
        <Box key={key++} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={0}>
          {lang ? (
            <Text dimColor>{lang}</Text>
          ) : null}
          {codeLines.map((cl, idx) => (
            <Text key={idx} color="cyanBright">
              {cl.length ? cl : " "}
            </Text>
          ))}
        </Box>,
      );
      continue;
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      blocks.push(
        <Text key={key++} bold color="magentaBright">
          {headerMatch[2]}
        </Text>,
      );
      i += 1;
      continue;
    }

    const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (listMatch) {
      const segs = parseInline(listMatch[2] ?? "");
      blocks.push(
        <Text key={key++}>
          {"  • "}
          {segs.map((s, idx) => (
            <Text key={idx} bold={s.bold} italic={s.italic} color={s.code ? "yellowBright" : undefined}>
              {s.text}
            </Text>
          ))}
        </Text>,
      );
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      blocks.push(<Text key={key++}> </Text>);
      i += 1;
      continue;
    }

    const segs = parseInline(line);
    blocks.push(
      <Text key={key++}>
        {segs.map((s, idx) => (
          <Text key={idx} bold={s.bold} italic={s.italic} color={s.code ? "yellowBright" : undefined}>
            {s.text}
          </Text>
        ))}
      </Text>,
    );
    i += 1;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}
