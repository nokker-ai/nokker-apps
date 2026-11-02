/**
 * Folder mode (core FOLDER-MODE §6): pure helpers of the Lokkal view. The core's words (actions, step states, card
 * text) are French; the interface says them in its own language. Texts: English source, French by `i18n/fr-folder.ts`.
 */
import type { FolderRunStatus, FolderStep, FolderStepStatus } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

export const POLL_MS = 2000;

export function runStatusLabel(s: FolderRunStatus | string): string {
  switch (s) {
    case "planning":
      return tr("planning");
    case "awaiting_approval":
      return tr("plan to approve");
    case "running":
      return tr("working");
    case "done":
      return tr("done");
    case "failed":
      return tr("failed");
    case "refused":
      return tr("refused");
    case "undone":
      return tr("rolled back");
    default:
      return s;
  }
}

/** Tone of a status chip (always with its word, never colour alone). */
export const runTone = (s: FolderRunStatus | string): "" | "ok" | "ko" => (s === "done" ? "ok" : s === "failed" || s === "refused" ? "ko" : "");

export function actionLabel(a: FolderStep["action"]): string {
  switch (a) {
    case "ecrire":
      return tr("write");
    case "copier":
      return tr("copy");
    case "deplacer":
      return tr("move");
    case "corbeille":
      return tr("to the trash");
    default:
      return a;
  }
}

export function stepLabel(s: FolderStepStatus | string | undefined): string {
  return s === "fait" ? tr("done") : s === "non fait" ? tr("not done") : tr("waiting");
}

/** Zone paths of the core (`dossier/…`, `sortie/…`) said with the person's words. */
export function zonePath(p: string): string {
  if (p.startsWith("dossier/")) return tr("folder") + " › " + p.slice("dossier/".length);
  if (p.startsWith("sortie/")) return tr("output") + " › " + p.slice("sortie/".length);
  return p;
}

/** What approving does, in the interface's language (the server's `card.text` is French). */
export const cardText = (inPlace: boolean): string =>
  inPlace
    ? tr("Approving this plan changes the folder itself. A restore point is taken before the first write: everything can be undone.")
    : tr("Approving this plan writes only to the output folder; the folder stays untouched.");

export function apiCodeText(code: string | undefined, fallback: string): string {
  switch (code) {
    case "outside_roots":
      return tr("This folder is not under a folder declared for Nokker on this machine.");
    case "local_only":
      return tr("Folder mode works only on the machine itself.");
    case "confirm_in_place":
      return tr("Tick the confirmation to change the folder itself.");
    case "not_pending":
      return tr("This plan was already decided.");
    case "busy":
      return tr("Wait for the run to finish before undoing it.");
    default:
      return fallback;
  }
}
