/**
 * « Envoyer la sélection » : fichier + lignes → bloc de contexte joint au prochain message. Pur (sans API VS Code).
 */

export interface SelectionContext {
  id: string;
  /** Chemin relatif au dossier de la session. */
  relPath: string;
  /** Lignes 1-indexées, incluses. */
  startLine: number;
  endLine: number;
  languageId: string;
  text: string;
}

/** Au-delà, la sélection est coupée (le modèle peut lire le fichier lui-même). */
export const MAX_SELECTION_CHARS = 20_000;

export function contextLabel(c: Pick<SelectionContext, "relPath" | "startLine" | "endLine">): string {
  return c.startLine === c.endLine ? `${c.relPath}:${c.startLine}` : `${c.relPath}:${c.startLine}-${c.endLine}`;
}

function fence(text: string): string {
  // Une sélection qui contient ``` ne doit pas fermer le bloc.
  let f = "```";
  while (text.includes(f)) f += "`";
  return f;
}

export function contextBlock(c: SelectionContext): string {
  const cut = c.text.length > MAX_SELECTION_CHARS;
  const body = cut ? c.text.slice(0, MAX_SELECTION_CHARS) : c.text;
  const lines = c.startLine === c.endLine ? `ligne ${c.startLine}` : `lignes ${c.startLine}-${c.endLine}`;
  const f = fence(body);
  return `Contexte : \`${c.relPath}\`, ${lines}${cut ? ` (coupé à ${MAX_SELECTION_CHARS} caractères)` : ""} :\n${f}${c.languageId}\n${body}\n${f}`;
}

/** Message envoyé au noyau : les blocs de contexte puis le texte de l'utilisateur. */
export function composeMessage(text: string, contexts: SelectionContext[]): string {
  if (!contexts.length) return text;
  return `${contexts.map(contextBlock).join("\n\n")}\n\n${text}`;
}

/** Chemin relatif au dossier (séparateur `/`), `null` si le fichier est hors du dossier. */
export function relativeTo(folder: string, file: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(folder);
  const p = norm(file);
  return p.startsWith(`${f}/`) ? p.slice(f.length + 1) : null;
}
