/**
 * Markdown minimal du panneau, en ARBRE (jamais en HTML) : le texte du modèle est posé par `textContent`, aucune balise ne
 * peut s'injecter. Blocs de code, paragraphes, listes à puces, citations ; en ligne : `code`, **gras**, _italique_.
 */

export type Inline = { kind: "text" | "code" | "strong" | "em"; text: string };
export type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "p"; inlines: Inline[] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "list"; items: Inline[][] };

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|(?<![\w])_[^_\n]+_(?![\w]))/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ kind: "text", text: s.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ kind: "code", text: tok.slice(1, -1) });
    else if (tok.startsWith("**")) out.push({ kind: "strong", text: tok.slice(2, -2) });
    else out.push({ kind: "em", text: tok.slice(1, -1) });
    last = m.index! + tok.length;
  }
  if (last < s.length) out.push({ kind: "text", text: s.slice(last) });
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (para.length) blocks.push({ kind: "p", inlines: parseInline(para.join("\n")) });
    if (list.length) blocks.push({ kind: "list", items: list.map(parseInline) });
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^(`{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const close = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith(close); i++) body.push(lines[i]!);
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (para.length) {
        blocks.push({ kind: "p", inlines: parseInline(para.join("\n")) });
        para = [];
      }
      list.push(li[1]!);
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flush();
      blocks.push({ kind: "quote", inlines: parseInline(q[1]!) });
      continue;
    }
    if (list.length) {
      blocks.push({ kind: "list", items: list.map(parseInline) });
      list = [];
    }
    para.push(line);
  }
  flush();
  return blocks;
}
