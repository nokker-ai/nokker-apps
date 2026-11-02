/**
 * Import d'un autre agent (lot 30, noyau `nokker/importers`) : routes locales `/v1/local/import/*`, jeton local
 * seulement (403 par la passerelle). Le noyau ne lit que ce qui lui est visible ; le chemin principal est la commande
 * lancée sur l'hôte, dont l'écran relit le dernier rapport (`GET /v1/local/import/report`).
 */
export type ImportSource = "claude-code" | "codex" | "cursor" | "hermes" | "openclaw";
export type ImportStatus = "planned" | "imported" | "native" | "skipped" | "unsupported" | "conflict" | "error";

export interface ImportItem {
  kind: string;
  source: string;
  target: string | null;
  status: ImportStatus;
  /** Texte français du noyau, repli si `code` n'est pas traduit. */
  reason: string;
  /** Code stable de la raison (noyau `nokker/importers/base.py` REASON_CODES), traduit par le web ; "" sans raison. */
  code?: string;
  detail: Record<string, unknown>;
}

export interface ImportReport {
  origin: string;
  counts: Record<ImportStatus, number>;
  items: ImportItem[];
  /** Dossier du rapport (lecture du dernier rapport seulement). */
  dir?: string;
}
