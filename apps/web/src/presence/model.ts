/** « Who does what » — pure view model (core docs/WHO-DOES-WHAT.md): grouping, badge, what a row may open. */
import type { PresenceActivity, PresenceEntry, PresenceStatus, PresenceView } from "@nokker-apps/sdk";
import { shellLang, tr } from "../i18n/index.js";

export const GROUPS: Array<{ id: string; statuses: PresenceStatus[] }> = [
  { id: "needs", statuses: ["awaiting_approval", "blocked"] },
  { id: "working", statuses: ["working"] },
  { id: "paused", statuses: ["paused"] },
  { id: "idle", statuses: ["idle"] },
];

export function statusText(s: PresenceStatus): string {
  switch (s) {
    case "working":
      return tr("working");
    case "awaiting_approval":
      return tr("waiting for your approval");
    case "blocked":
      return tr("blocked");
    case "paused":
      return tr("paused");
    default:
      return tr("at rest");
  }
}

export function groupTitle(id: string, n: number): string {
  switch (id) {
    case "needs":
      return tr("Needs you · {0}", n);
    case "working":
      return tr("Working · {0}", n);
    case "paused":
      return tr("Paused · {0}", n);
    default:
      return tr("At rest · {0}", n);
  }
}

export function grouped(entries: readonly PresenceEntry[]): Array<{ id: string; entries: PresenceEntry[] }> {
  return GROUPS.map((g) => ({ id: g.id, entries: entries.filter((e) => g.statuses.includes(e.status)) })).filter((g) => g.entries.length > 0);
}

/** The badge of the top-bar button: what waits for a human (cards, blocked). */
export function attentionCount(v: PresenceView | null): number {
  return v ? v.counts.awaiting_approval + v.counts.blocked : 0;
}

/** A read-only viewer (household member who is not the payer) cannot open an agent's page; threads and the house stay. */
export function canOpen(v: PresenceView, e: PresenceEntry): boolean {
  return !(v.viewer.read_only && e.target.type === "agent");
}

export type Destination = { view: "chat"; thread: string } | { view: "crew" } | { view: "house" };

export function destination(e: PresenceEntry): Destination {
  if (e.target.type === "house") return { view: "house" };
  if (e.target.type === "agent") return { view: "crew" };
  return { view: "chat", thread: e.target.id };
}

/** Applies a `presence.changed` event to a view without a round trip: the row's status moves, the counts follow. */
export function applyChange(v: PresenceView, id: string, status: PresenceStatus): PresenceView {
  const hit = v.entries.find((e) => e.id === id);
  if (!hit || hit.status === status) return v;
  const entries = v.entries.map((e) => (e.id === id ? { ...e, status } : e));
  const counts = { ...v.counts, [hit.status]: v.counts[hit.status] - 1, [status]: v.counts[status] + 1 };
  return { ...v, entries, counts };
}

/** The activity line, worded in the interface language from the core's code and raw values (null: show the status). */
export function activityText(a: PresenceActivity | null): string | null {
  if (!a) return null;
  switch (a.code) {
    case "snippet":
    case "run_summary":
      return a.text ?? null;
    case "thinking":
      return tr("thinking…");
    case "tool":
      return tr("uses the {0} tool", a.tool ?? "?");
    case "turn_paused":
      return tr("turn paused");
    case "approval":
      return a.tool ? tr("waiting for your approval: {0}", a.tool) : tr("waiting for your approval");
    case "goal_blocked":
      return tr("goal blocked: {0}", a.text ?? "");
    case "goal_draft":
      return tr("waiting for your go on the criteria: {0}", a.text ?? "");
    case "goal_active":
      return tr("pursuing its goal: {0}", a.text ?? "");
    case "run_queued":
      return tr("run queued");
    case "run_running":
      return tr("run in progress");
    case "run_failed":
      return tr("the last run failed");
    case "agent_paused":
      return tr("agent paused");
    case "next_run":
      return a.at ? tr("next run {0}", new Date(a.at).toLocaleString(shellLang() === "fr" ? "fr-CH" : "en-GB", { dateStyle: "short", timeStyle: "short" })) : null;
    case "house_working":
      return tr("answering in the house room");
    case "unavailable":
      return tr("not available");
    default:
      return null;
  }
}

/** Entry name with a default for untitled threads and code sessions. */
export function entryName(e: PresenceEntry): string {
  return e.name || (e.kind === "code" ? tr("Code session") : tr("Session"));
}
