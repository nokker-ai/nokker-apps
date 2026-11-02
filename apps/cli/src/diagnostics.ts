/**
 * Diagnostics de langage (lot 13, docs/LOKKAL-LSP.md du noyau) — pur, sans Ink : dernier état connu par fichier
 * (événements `lsp.diagnostics`), ligne discrète à afficher sous l'appel d'outil, textes de `/diagnostics`.
 * Les messages du serveur de langage restent tels quels (anglais) : seuls nos libellés passent par le catalogue.
 */
import type { LspDiagnosticItem, LspDiagnosticsEvent, LspDiagnosticsResult } from "@nokker-apps/sdk";
import { t } from "./i18n/index.js";

export interface FileDiagnostics {
  errors: number;
  warnings: number;
  items: LspDiagnosticItem[];
}

/** Chemin → dernier état publié (ordre d'arrivée). */
export type DiagnosticsState = ReadonlyMap<string, FileDiagnostics>;

/** Applique un événement : nouvel état, et la ligne à afficher (`null` : rien à dire). Une ligne quand le fichier a des
 * erreurs ; « plus d'erreurs » seulement pour un fichier qui en avait (un fichier propre dès le départ ne dit rien). */
export function applyDiagnostics(state: DiagnosticsState, event: Pick<LspDiagnosticsEvent, "path" | "counts" | "items">): { state: DiagnosticsState; line: string | null } {
  const before = state.get(event.path);
  const next = new Map(state);
  next.set(event.path, { errors: event.counts.error, warnings: event.counts.warning, items: event.items });
  let line: string | null = null;
  if (event.counts.error > 0) line = errorsLine(event.counts.error, event.path);
  else if (before && before.errors > 0) line = t("✓ {0}: no errors", event.path);
  return { state: next, line };
}

export function errorsLine(n: number, path: string): string {
  return n === 1 ? t("⚠ 1 error in {0}", path) : t("⚠ {0} errors in {1}", n, path);
}

function itemLine(i: LspDiagnosticItem): string {
  return `    ${i.line}:${i.col} ${i.severity}${i.code ? ` ${i.code}` : ""}: ${i.message}`;
}

function countsText(errors: number, warnings: number): string {
  return t("{0} error(s), {1} warning(s)", errors, warnings);
}

/** `/diagnostics` sans argument : l'état reçu par les événements de ce fil. */
export function formatDiagnosticsState(state: DiagnosticsState, maxItems = 10): string {
  if (state.size === 0) return t("No language diagnostics received in this session yet. /diagnostics <path> asks the core.");
  const lines = [t("Language diagnostics (last state per file):")];
  for (const [path, f] of state) {
    lines.push(`  ${f.errors > 0 ? "⚠" : "✓"} ${path} — ${countsText(f.errors, f.warnings)}`);
    for (const i of f.items.slice(0, maxItems)) lines.push(itemLine(i));
    if (f.items.length > maxItems) lines.push(`    ${t("… {0} more", f.items.length - maxItems)}`);
  }
  return lines.join("\n");
}

/** `/diagnostics <chemin>` : réponse de l'outil `lsp_diagnostics`. */
export function formatDiagnosticsResult(r: LspDiagnosticsResult, maxItems = 20): string {
  const lines: string[] = [];
  for (const f of r.files) {
    lines.push(`${f.errors > 0 ? "⚠" : "✓"} ${f.path} — ${countsText(f.errors, f.warnings)}`);
    for (const i of f.items.slice(0, maxItems)) lines.push(itemLine(i));
    if (f.items.length > maxItems) lines.push(`    ${t("… {0} more", f.items.length - maxItems)}`);
  }
  if (r.files.length === 0) lines.push(t("No file analysed."));
  if (r.pending?.length) lines.push(t("Still analysing: {0} (try again in a few seconds)", r.pending.join(", ")));
  lines.push(r.language_servers.length ? t("Language servers: {0}", r.language_servers.join(", ")) : t("No language server running for these files."));
  return lines.join("\n");
}

/** Met à jour l'état depuis une réponse de l'outil (les fichiers demandés sont désormais connus). */
export function stateFromResult(state: DiagnosticsState, r: LspDiagnosticsResult): DiagnosticsState {
  const next = new Map(state);
  for (const f of r.files) next.set(f.path, { errors: f.errors, warnings: f.warnings, items: f.items });
  return next;
}
