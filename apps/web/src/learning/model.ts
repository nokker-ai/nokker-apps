/**
 * Apprentissage (lots 16, 18, 19, 25) : logique sans rendu — libellés du journal, découpage du diff, erreurs du noyau.
 * Textes : anglais source, français par le catalogue (`i18n/fr-learning.ts`).
 */
import { NokkerApiError, type JournalEntry } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

/** Une ligne de « Ce que Nokker a appris » : ce qui s'est passé, sur quoi, et d'où ça vient. */
export function journalLine(e: JournalEntry): { what: string; subject: string; origin: string } {
  const d = e.detail as { title?: string; reverted_to?: number };
  const subject = e.kind.startsWith("memory.") ? (d.title ?? e.subject) : e.subject;
  const what =
    e.kind === "skill.created" ? tr("New skill")
    : e.kind === "skill.updated" ? tr("Skill updated (v{0})", e.version ?? "?")
    : e.kind === "skill.reverted" ? tr("Skill back to v{0}", d.reverted_to ?? "?")
    : e.kind === "skill.disabled" ? tr("Skill disabled")
    : e.kind === "memory.pending" ? tr("Note waiting for your approval")
    : e.kind === "memory.approved" ? tr("Note approved")
    : tr("Note rejected");
  const who = e.actor === "owner" ? tr("by you") : e.kind === "memory.pending" ? tr("proposed by Nina") : tr("by Nina, card approved");
  return { what, subject, origin: who };
}

export type DiffRow = { type: "hunk" | "add" | "del" | "ctx" | "head"; text: string };

/** Diff unifié du noyau → lignes typées (les en-têtes `---`/`+++` à part). */
export function diffRows(diff: string): DiffRow[] {
  return diff
    .split("\n")
    .filter((l, i, a) => !(i === a.length - 1 && l === ""))
    .map((l) =>
      l.startsWith("--- ") || l.startsWith("+++ ") ? { type: "head", text: l }
      : l.startsWith("@@") ? { type: "hunk", text: l }
      : l.startsWith("+") ? { type: "add", text: l.slice(1) }
      : l.startsWith("-") ? { type: "del", text: l.slice(1) }
      : { type: "ctx", text: l.slice(1) },
    );
}

/** Code d'erreur du noyau (`{error:{code}}`), sinon le statut. */
export function errorCode(e: unknown): string {
  if (!(e instanceof NokkerApiError)) return "network";
  const b = e.body as { error?: { code?: string } } | undefined;
  return b?.error?.code ?? String(e.status);
}

/** Message clair pour une erreur des routes d'apprentissage. */
export function learningError(e: unknown): string {
  const c = errorCode(e);
  if (c === "machine_only") return tr("This decision is made on the machine itself (not through the gateway).");
  if (c === "no_rule_store") return tr("Rules are stored on your Lokkal machine: accept this suggestion there.");
  if (c === "already_decided") return tr("Already decided elsewhere: the list is refreshed.");
  if (c === "no_memory") return tr("Memory is unavailable right now: the note stays waiting.");
  if (c === "unchanged") return tr("Nothing to change: this version is already the active one.");
  if (c === "scan_refused") return tr("The security scanner refused this version.");
  if (c === "no_scanner" || c === "scan_failed") return tr("The security scanner is not available: try again later.");
  if (c === "network") return tr("the server is not responding");
  return tr("server refused ({0})", c);
}

/** Date courte lisible (locale de l'interface). */
export function when(iso: string, lang: "fr" | "en"): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang === "fr" ? "fr-CH" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
