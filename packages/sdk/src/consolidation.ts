/**
 * Nightly memory consolidation (core docs/CONSOLIDATION.md §6, shapes from nokker/memory/consolidation/engine.py,
 * p2/cx-consolidate 4df283b; flag `memory_consolidation` off → 404 on every route). Account session.
 *
 *   GET  /v1/memory/consolidation/runs[?limit≤100]   → {runs: ConsolidationRun[]}
 *   GET  /v1/memory/consolidation/runs/{id}          → ConsolidationReport
 *   POST /v1/memory/consolidation/runs/{id}/undo     → ConsolidationRunUndo   (idempotent; a conflicting op stays, listed)
 *   POST /v1/memory/consolidation/ops/{id}/undo      → {op, undone, already}  ; 409 conflict (the note changed since)
 *   POST /v1/memory/consolidation/run {dry_run?}     → ConsolidationReport | {status: "already", night} ; 409 busy
 *   GET|PUT /v1/memory/consolidation/settings {enabled?, tz?, cron?} → {enabled, tz, cron, max_ops} ; 400 bad_schedule
 *   GET  /v1/memory/consolidation/pins               → {pins: string[]}
 *   PUT  /v1/memory/consolidation/pins/{name} {pinned} → {name, pinned, pins}
 * Never the tenant, an embedding or the author of a note; every text re-redacted. Nothing is deleted for good: an
 * archive can come back, an undo gives back the EXACT state before.
 */

export const CONSOLIDATION_OP_KINDS = ["merge", "correct", "archive", "summarize", "lesson"] as const;
export type ConsolidationOpKind = (typeof CONSOLIDATION_OP_KINDS)[number];

export interface ConsolidationRun {
  id: string;
  /** Local day of the night, `YYYY-MM-DD`. */
  night: string;
  tz: string;
  trigger: "schedule" | "manual" | (string & {});
  status: "running" | "done" | "failed";
  dry_run: boolean;
  model: string | null;
  started_at: number;
  finished_at: number | null;
  counts: Partial<Record<ConsolidationOpKind, number>>;
  /** Operations not applied because the night's cap (`max_ops`) was reached. */
  skipped: number;
  undone_at: number | null;
  /** Server text in French (« 2 fusions, 1 correction » or « rien à changer »). */
  summary: string;
}

export interface ConsolidationNoteView {
  title: string;
  text: string;
  kind: string;
  origin: "user" | "agent";
  audience: string;
}

export type ConsolidationNoteChange =
  | { name: string; action: "annotate"; text: string }
  | { name: string; action: "update" | "create" | "archive"; before: ConsolidationNoteView | null; after: ConsolidationNoteView | null };

export interface ConsolidationOp {
  id: string;
  seq: number;
  kind: ConsolidationOpKind;
  scope: string;
  reason: string;
  evidence: Record<string, unknown>;
  at: number;
  undone_at: number | null;
  notes: ConsolidationNoteChange[];
}

export interface ConsolidationReport {
  run: ConsolidationRun;
  ops: ConsolidationOp[];
}

export interface ConsolidationRunUndo {
  /** The run's id. */
  run: string;
  undone: string[];
  already: string[];
  conflicts: { op: string; message: string }[];
  complete: boolean;
}

export interface ConsolidationOpUndo {
  op: string;
  undone: boolean;
  already: boolean;
}

export interface ConsolidationSettings {
  enabled: boolean;
  tz: string;
  /** Five-field cron, default `30 3 * * *`. */
  cron: string;
  max_ops: number;
}

/** Total number of operations of a run. */
export function opCount(run: Pick<ConsolidationRun, "counts">): number {
  return Object.values(run.counts).reduce((n, v) => n + (v ?? 0), 0);
}
