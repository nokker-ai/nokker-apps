/**
 * Diagnostics de langage du mock (lot 13, LOKKAL-LSP.md), drapeau `state.lsp` (`local.lsp.enabled` du noyau) :
 * - générateur : `publishLspDiagnostics` range le dernier état d'un fichier pour le fil et publie
 *   `lsp.diagnostics {thread_id, path, counts, items[≤20]}` (le scénario local l'appelle après un `patch` réussi) ;
 * - outil `lsp_diagnostics {paths?, severity?}` de la route d'appel d'outil : `{files, language_servers, pending?}`,
 *   50 items au plus par fichier ; un fichier jamais publié est rendu sans diagnostic (le noyau l'ouvrirait).
 */
import type { LspDiagnosticItem, LspDiagnosticsResult, LspFileDiagnostics } from "@nokker-apps/sdk";
import type { MockState } from "./state.js";

/** Deux erreurs pyright de démo (messages du serveur, anglais, tels quels). */
export const MOCK_CALC_ERRORS: LspDiagnosticItem[] = [
  { line: 12, col: 5, severity: "error", code: "reportAttributeAccessIssue", message: 'Cannot access attribute "foo" for class "int"' },
  { line: 18, col: 12, severity: "error", code: "reportUndefinedVariable", message: '"totl" is not defined' },
  { line: 3, col: 8, severity: "warning", code: "reportUnusedImport", message: 'Import "os" is not accessed' },
];

const stores = new WeakMap<MockState, Map<string, Map<string, LspFileDiagnostics>>>();

function storeFor(state: MockState, threadId: string): Map<string, LspFileDiagnostics> {
  let m = stores.get(state);
  if (!m) stores.set(state, (m = new Map()));
  let t = m.get(threadId);
  if (!t) m.set(threadId, (t = new Map()));
  return t;
}

const count = (items: LspDiagnosticItem[], sev: string): number => items.filter((i) => i.severity === sev).length;

/** Publie l'état d'un fichier après une édition (rien si le drapeau est éteint). */
export function publishLspDiagnostics(state: MockState, threadId: string, path: string, items: LspDiagnosticItem[]): void {
  if (!state.lsp) return;
  const root = threadId.split("/sa-")[0]!;
  const file: LspFileDiagnostics = { path, errors: count(items, "error"), warnings: count(items, "warning"), items: items.slice(0, 50) };
  storeFor(state, root).set(path, file);
  state.publish({ type: "lsp.diagnostics", thread_id: threadId, path, counts: { error: file.errors, warning: file.warnings }, items: items.slice(0, 20) });
}

/** `lsp_diagnostics {paths?, severity?}` : fichiers demandés (ou tous ceux connus), filtrés par sévérité si donnée. */
export function lspTool(state: MockState, threadId: string, args: Record<string, unknown>): { content: string; is_error: boolean } {
  const known = storeFor(state, threadId);
  const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : null;
  if (args.paths !== undefined && !Array.isArray(args.paths)) return { content: "paths: expected a list of strings", is_error: true };
  const severity = args.severity === "error" || args.severity === "warning" ? args.severity : null;
  const files = (paths ?? [...known.keys()]).map((p) => {
    const f = known.get(p) ?? { path: p, errors: 0, warnings: 0, items: [] };
    if (!severity) return f;
    const items = f.items.filter((i) => (severity === "error" ? i.severity === "error" : i.severity === "error" || i.severity === "warning"));
    return { ...f, items };
  });
  const out: LspDiagnosticsResult = { files, language_servers: ["pyright"] };
  return { content: JSON.stringify(out), is_error: false };
}
