/**
 * Pièces de contexte jointes au prochain message, toutes tirées de l'éditeur (jamais inventées) : sélection, fichier
 * (`@chemin`), problèmes du panneau Problèmes, dernière sortie du terminal actif. Pur (sans API VS Code).
 *
 * Forme envoyée au noyau, comme le pont ACP (`apps/cli/src/acp/agent.ts`) : un fichier enregistré reste un chemin
 * `@src/app.py` (le noyau le lit dans le dossier de la session), une image part en pièce jointe par chemin
 * (LOKKAL.md §7.6) ; un texte que le noyau ne peut pas lire (sélection, fichier modifié non enregistré, problèmes,
 * sortie du terminal) part en bloc de contexte au début du message.
 */
import type { ChatAttachment } from "@nokker-apps/sdk";
import { english, type Translate } from "./i18n.js";

export interface SelectionContext {
  kind: "selection";
  id: string;
  /** Chemin relatif au dossier de la session. */
  relPath: string;
  /** Lignes 1-indexées, incluses. */
  startLine: number;
  endLine: number;
  languageId: string;
  text: string;
}

export interface FileContext {
  kind: "file";
  id: string;
  relPath: string;
  /** Image (png, jpeg, webp, gif) : pièce jointe par chemin. */
  image: boolean;
  /** Texte du document ouvert quand il a des modifications NON enregistrées (le noyau lirait l'ancien contenu). */
  unsavedText?: string;
  languageId?: string;
}

export interface DiagnosticItem {
  /** 1-indexées. */
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string;
}

export interface DiagnosticsContext {
  kind: "diagnostics";
  id: string;
  relPath: string;
  languageId: string;
  items: DiagnosticItem[];
  /** Lignes du document autour des problèmes (texte réel du document), `startLine` 1-indexée. */
  excerpt: { startLine: number; lines: string[] } | null;
}

export interface TerminalContext {
  kind: "terminal";
  id: string;
  name: string;
  commandLine: string | null;
  exitCode: number | null;
  output: string;
}

export type ContextItem = SelectionContext | FileContext | DiagnosticsContext | TerminalContext;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Pièce sans son identifiant (posé par le contrôleur). */
export type NewContextItem = DistributiveOmit<ContextItem, "id">;

/** Au-delà, une sélection ou un fichier non enregistré est coupé (le modèle peut lire le fichier lui-même). */
export const MAX_SELECTION_CHARS = 20_000;
/** Sortie du terminal gardée : les dernières lignes, au plus. */
export const MAX_TERMINAL_LINES = 200;
export const MAX_TERMINAL_CHARS = 12_000;
/** Problèmes envoyés au plus, par fichier. */
export const MAX_DIAGNOSTICS = 20;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

export const isImagePath = (p: string): boolean => IMAGE_RE.test(p);

export function contextLabel(c: ContextItem, t: Translate = english): string {
  switch (c.kind) {
    case "selection":
      return c.startLine === c.endLine ? `${c.relPath}:${c.startLine}` : `${c.relPath}:${c.startLine}-${c.endLine}`;
    case "file":
      return `@${c.relPath}`;
    case "diagnostics":
      return t("Problems: {0} ({1})", c.relPath, c.items.length);
    case "terminal":
      return c.commandLine ? t("Terminal {0}: {1}", c.name, shorten(c.commandLine, 40)) : t("Terminal {0}", c.name);
  }
}

function severityLabel(t: Translate, s: DiagnosticItem["severity"]): string {
  return s === "error" ? t("error") : s === "warning" ? t("warning") : s === "info" ? t("info") : t("hint");
}

const shorten = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fence(text: string): string {
  // Un texte qui contient ``` ne doit pas fermer le bloc.
  let f = "```";
  while (text.includes(f)) f += "`";
  return f;
}

function fenced(body: string, lang = ""): string {
  const f = fence(body);
  return `${f}${lang}\n${body}\n${f}`;
}

/** Séquences ANSI (couleurs, curseur, OSC dont celles de l'intégration du shell) retirées ; un `\r` garde ce qui suit. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .split("\n")
    .map((l) => {
      const parts = l.replace(/\r$/, "").split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

/** Les dernières lignes d'une sortie (au plus `MAX_TERMINAL_LINES` et `MAX_TERMINAL_CHARS`), et si elle a été coupée. */
export function tailOutput(text: string): { text: string; cut: boolean } {
  let lines = stripAnsi(text).replace(/\s+$/, "").split("\n");
  let cut = false;
  if (lines.length > MAX_TERMINAL_LINES) {
    lines = lines.slice(-MAX_TERMINAL_LINES);
    cut = true;
  }
  let out = lines.join("\n");
  if (out.length > MAX_TERMINAL_CHARS) {
    out = out.slice(-MAX_TERMINAL_CHARS);
    out = out.slice(out.indexOf("\n") + 1);
    cut = true;
  }
  return { text: out, cut };
}

export function contextBlock(c: ContextItem, t: Translate = english): string | null {
  switch (c.kind) {
    case "selection": {
      const cut = c.text.length > MAX_SELECTION_CHARS;
      const body = cut ? c.text.slice(0, MAX_SELECTION_CHARS) : c.text;
      const lines = c.startLine === c.endLine ? t("line {0}", c.startLine) : t("lines {0}-{1}", c.startLine, c.endLine);
      const note = cut ? ` ${t("(cut at {0} characters)", MAX_SELECTION_CHARS)}` : "";
      return `${t("Context: `{0}`, {1}{2}:", c.relPath, lines, note)}\n${fenced(body, c.languageId)}`;
    }
    case "file": {
      if (c.image || c.unsavedText === undefined) return null; // un chemin, lu par le noyau
      const cut = c.unsavedText.length > MAX_SELECTION_CHARS;
      const body = cut ? c.unsavedText.slice(0, MAX_SELECTION_CHARS) : c.unsavedText;
      const note = cut ? ` ${t("(cut at {0} characters)", MAX_SELECTION_CHARS)}` : "";
      return `${t("File `{0}` with changes not saved yet in the editor{1}:", c.relPath, note)}\n${fenced(body, c.languageId ?? "")}`;
    }
    case "diagnostics": {
      const items = c.items.slice(0, MAX_DIAGNOSTICS);
      const rows = items.map((d) => {
        const origin = [d.source, d.code].filter(Boolean).join(" ");
        return `- ${t("line {0}, column {1}", d.line, d.column)} [${severityLabel(t, d.severity)}] ${d.message.replace(/\s+/g, " ").trim()}${origin ? ` (${origin})` : ""}`;
      });
      if (c.items.length > items.length) rows.push(`- ${t("… and {0} more", c.items.length - items.length)}`);
      let out = `${t("Problems reported by the editor in `{0}`:", c.relPath)}\n${rows.join("\n")}`;
      if (c.excerpt && c.excerpt.lines.length) {
        const width = String(c.excerpt.startLine + c.excerpt.lines.length - 1).length;
        const numbered = c.excerpt.lines.map((l, i) => `${String(c.excerpt!.startLine + i).padStart(width)} | ${l}`).join("\n");
        out += `\n${fenced(numbered, c.languageId)}`;
      }
      return out;
    }
    case "terminal": {
      const { text, cut } = tailOutput(c.output);
      const head = c.commandLine
        ? t("Last output of the terminal `{0}` (command `{1}`{2}):", c.name, c.commandLine, c.exitCode === null ? "" : t(", exit code {0}", c.exitCode))
        : t("Last output of the terminal `{0}`:", c.name);
      return `${head}${cut ? ` ${t("(last lines only)")}` : ""}\n${fenced(text)}`;
    }
  }
}

/** Images citées dans le texte (`@capture.png`) : le noyau les lit dans le dossier de la session (LOKKAL.md §7.6). */
export function imageMentions(text: string): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([\w./-]+\.(?:png|jpe?g|webp|gif))(?=\s|$|[,;:!?)])/gi)) {
    if (!m[1]!.split("/").includes("..")) out.push({ path: m[1]! });
  }
  return out;
}

/** Au plus 4 images par message (LOKKAL.md §7.6). */
export const MAX_IMAGES = 4;

/** Message envoyé au noyau : les blocs de contexte, puis le texte de l'utilisateur suivi des fichiers cités
 * (`@chemin`) ; les images (pièces + `@image` du texte) en pièces jointes, sans doublon. */
export function composeMessage(text: string, items: ContextItem[], t: Translate = english): { text: string; attachments: ChatAttachment[] } {
  const blocks = items.map((c) => contextBlock(c, t)).filter((b): b is string => b !== null);
  const mentioned = new Set([...text.matchAll(/(?:^|\s)@([\w./-]+)/g)].map((m) => m[1]!));
  const refs = items
    .filter((c): c is FileContext => c.kind === "file" && c.unsavedText === undefined && !mentioned.has(c.relPath))
    .map((c) => `@${c.relPath}`);
  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();
  const paths = [...items.filter((c): c is FileContext => c.kind === "file" && c.image).map((c) => c.relPath), ...imageMentions(text).map((a) => ("path" in a ? a.path : ""))];
  for (const path of paths) {
    if (path && !seen.has(path)) {
      seen.add(path);
      attachments.push({ path });
    }
  }
  const body = refs.length ? `${text}\n\n${refs.join(" ")}` : text;
  return { text: blocks.length ? `${blocks.join("\n\n")}\n\n${body}` : body, attachments: attachments.slice(0, MAX_IMAGES) };
}

/** Chemin relatif au dossier (séparateur `/`), `null` si le fichier est hors du dossier. */
export function relativeTo(folder: string, file: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(folder);
  const p = norm(file);
  return p.startsWith(`${f}/`) ? p.slice(f.length + 1) : null;
}

/** Lignes du document autour des problèmes (2 avant, 2 après), au plus 40 lignes. */
export function excerptAround(lines: string[], items: Pick<DiagnosticItem, "line">[]): { startLine: number; lines: string[] } | null {
  if (!items.length || !lines.length) return null;
  const min = Math.max(1, Math.min(...items.map((d) => d.line)) - 2);
  const max = Math.min(lines.length, Math.max(...items.map((d) => d.line)) + 2, min + 39);
  return { startLine: min, lines: lines.slice(min - 1, max) };
}

/**
 * Dernière commande d'un terminal, lue par l'intégration du shell de VS Code (`onDidStartTerminalShellExecution`,
 * `execution.read()`) : rien n'est lu sans elle. Borné (le terminal peut sortir des mégaoctets).
 */
export class TerminalLog {
  private chunks: string[] = [];
  private size = 0;
  commandLine: string | null = null;
  exitCode: number | null = null;
  done = false;

  constructor(commandLine: string | null) {
    this.commandLine = commandLine;
  }

  append(data: string): void {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > MAX_TERMINAL_CHARS * 4 && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }

  finish(exitCode: number | undefined): void {
    this.exitCode = exitCode ?? null;
    this.done = true;
  }

  get output(): string {
    return this.chunks.join("");
  }
}
