/**
 * Folder mode (core docs/FOLDER-MODE.md §6, shapes of nokker/folder/run.py `FolderRun.view` and nokker/local/api.py
 * `_folder`; flag `local.folder_mode` off → 404). ON THE MACHINE ONLY: local token; through the gateway (so from
 * nokker.ai) every route is `403 local_only` — a web session never touches the files. Folder and output under a
 * declared root, else `403 outside_roots`.
 *
 *   POST /v1/local/folder/runs {path, task, in_place?, out?}  → 202 FolderRun (status `planning`) ; 400 bad_body | bad_folder
 *   GET  /v1/local/folder/runs                                 → {runs: FolderRunSummary[]}
 *   GET  /v1/local/folder/runs/{id}                            → FolderRun ; 404 not_found
 *   POST /v1/local/folder/runs/{id}/decide {decision, confirm_in_place?} → 202 FolderRun (approved, running) | 200 (refused)
 *        409 not_pending ; 400 confirm_in_place (an in-place run is approved only with `confirm_in_place: true`)
 *   POST /v1/local/folder/runs/{id}/undo {force?}             → 200 FolderRun (with `undo`) ; 409 busy
 *
 * Plan and execution run in the background: the client reads the run again (every 2 s) until a final status.
 * Nothing is deleted: « corbeille » moves to `dossier/.corbeille-nokker/<run>/`; a restore point is taken before the
 * first write. `report.resume_modele` is the model's text, shown as such; the lists of the report are the truth.
 */

export type FolderRunStatus = "planning" | "awaiting_approval" | "running" | "done" | "failed" | "refused" | "undone";
export type FolderAction = "ecrire" | "copier" | "deplacer" | "corbeille";
export type FolderStepStatus = "en attente" | "fait" | "non fait";

/** Paths are zone-relative (`dossier/…`, `sortie/…`): the model never sees a host path. */
export interface FolderStep {
  action: FolderAction | (string & {});
  chemin: string;
  vers?: string;
  pourquoi?: string;
}

export interface FolderPlan {
  resume: string;
  etapes: FolderStep[];
}

export interface FolderTouched {
  action: FolderAction | (string & {});
  chemin: string;
  vers?: string;
  etat?: string;
}

export interface FolderReport {
  fichiers_touches: FolderTouched[];
  etapes_non_faites: FolderStep[];
  /** A restore point was taken (the run can be undone exactly). */
  point_de_retour: boolean;
  /** Where trashed files went, or null. */
  corbeille: string | null;
  /** The model's own words — not the report. */
  resume_modele: string;
}

export interface FolderUndo {
  restored: string[];
  /** Files changed since the run: kept unless `force`. */
  conflicts: { path: string; why: string }[];
  parked: string[];
  exact: boolean;
  differences: unknown[];
}

export interface FolderCard {
  kind: "folder_run";
  strength: "standard" | "strong";
  in_place: boolean;
  /** Server text (French). */
  text: string;
}

export interface FolderRun {
  run_id: string;
  thread_id: string;
  status: FolderRunStatus;
  /** Host path of the folder (the person's own machine). */
  path: string;
  out: string | null;
  in_place: boolean;
  task: string;
  plan: FolderPlan | null;
  steps: FolderStepStatus[];
  plan_reply: string;
  /** Only while `awaiting_approval`. */
  card: FolderCard | null;
  report: FolderReport | null;
  error: string | null;
  undo: FolderUndo | null;
  /** Epoch seconds. */
  created_at: number;
}

export type FolderRunSummary = Pick<FolderRun, "run_id" | "status" | "path" | "in_place" | "task" | "created_at">;

export interface FolderRunCreate {
  path: string;
  task: string;
  in_place?: boolean;
  out?: string;
}

/** A run still moving on its own (read it again). */
export const folderRunMoving = (s: FolderRunStatus): boolean => s === "planning" || s === "running";

/** Progress of the execution: steps done (or not done) over all steps. */
export function folderProgress(run: Pick<FolderRun, "steps">): { done: number; total: number } {
  return { done: run.steps.filter((s) => s !== "en attente").length, total: run.steps.length };
}
