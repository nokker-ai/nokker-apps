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

/** Cellules d'une ligne de tableau GFM (`| a | b |`, barres de bord facultatives). */
function tableCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isTableRow = (line: string): boolean => line.includes("|") && line.trim() !== "";

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
    // Tableau GFM : en-tête, ligne de tirets, puis les lignes qui contiennent une barre. Il défile dans sa boîte au
    // lieu d'élargir le message (téléphone).
    if (isTableRow(line) && TABLE_RULE.test(lines[i + 1] ?? "")) {
      const head = tableCells(line);
      const align = tableCells(lines[i + 1] ?? "").map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        rows.push(tableCells(lines[i] ?? ""));
        i += 1;
      }
      blocks.push(
        <div key={key++} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={align[j] ? { textAlign: align[j] } : undefined}>
                    {renderSegments(parseInline(c))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {head.map((_, j) => (
                    <td key={j} style={align[j] ? { textAlign: align[j] } : undefined}>
                      {renderSegments(parseInline(r[j] ?? ""))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
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
