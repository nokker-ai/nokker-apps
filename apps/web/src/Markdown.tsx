/**
 * Rendu markdown minimal — même doctrine que `apps/cli/src/ui/Markdown.tsx` (pas de dépendance
 * lourde type `marked`+`highlight.js`) : composants React construits directement (jamais de
 * `dangerouslySetInnerHTML`, donc pas de risque d'injection même si le texte vient du modèle).
 */
import React from "react";

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

function renderSegments(segs: Segment[]): React.ReactNode {
  return segs.map((s, i) => {
    if (s.code) return <code key={i}>{s.text}</code>;
    if (s.bold) return <strong key={i}>{s.text}</strong>;
    if (s.italic) return <em key={i}>{s.text}</em>;
    return <React.Fragment key={i}>{s.text}</React.Fragment>;
  });
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={key++}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const header = line.match(/^(#{1,6})\s+(.*)$/);
    if (header) {
      blocks.push(<p key={key++} style={{ fontWeight: 700 }}>{header[2]}</p>);
      i += 1;
      continue;
    }
    const list = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (list) {
      blocks.push(<div key={key++}>• {renderSegments(parseInline(list[2] ?? ""))}</div>);
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      blocks.push(<div key={key++} style={{ height: 6 }} />);
      i += 1;
      continue;
    }
    blocks.push(<div key={key++}>{renderSegments(parseInline(line))}</div>);
    i += 1;
  }

  return <>{blocks}</>;
}
