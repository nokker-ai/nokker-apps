/**
 * Diagnostics de langage (lot 13, noyau `p2/features-lsp`, docs/LOKKAL-LSP.md) : un serveur de langage (pyright,
 * typescript-language-server) tourne dans le bac à sable du fil ; après chaque `patch`/`write_file`, le noyau publie
 * l'état du fichier touché, et l'outil `lsp_diagnostics` (liste blanche de `POST /v1/local/tools/call`, drapeau
 * `local.lsp.enabled`, sinon 403) rend l'état courant des fichiers demandés.
 */

export type LspSeverity = "error" | "warning" | "information" | "hint" | (string & {});

/** Un diagnostic : ligne et colonne en base 1, message du serveur tel quel (anglais, sur une ligne). */
export interface LspDiagnosticItem {
  line: number;
  col: number;
  severity: LspSeverity;
  code?: string | null;
  message: string;
}

/** `lsp.diagnostics` : état d'UN fichier après une édition (20 items au plus, caviardés comme un `tool.result`). Un
 * fichier réparé publie `counts.error = 0`. `call_id` : pas encore porté par le noyau (01.11). */
export interface LspDiagnosticsEvent {
  type: "lsp.diagnostics";
  thread_id: string;
  call_id?: string;
  path: string;
  counts: { error: number; warning: number };
  items: LspDiagnosticItem[];
}

/** Un fichier dans la réponse de l'outil `lsp_diagnostics` (50 items au plus). */
export interface LspFileDiagnostics {
  path: string;
  errors: number;
  warnings: number;
  items: LspDiagnosticItem[];
}

/** `content` JSON de l'outil `lsp_diagnostics {paths?, severity?}`. `pending` : fichiers dont le serveur n'a pas encore
 * publié l'état (absent quand vide). */
export interface LspDiagnosticsResult {
  files: LspFileDiagnostics[];
  language_servers: string[];
  pending?: string[];
}
