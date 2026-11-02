/**
 * « Coup d'œil » for display glasses (a web app loaded by URL, small see-through screen): what matters now, one page at
 * a time, read only. Pages: the summary (counts), the morning brief, then one page per card that waits.
 * Pure functions: the page component only fetches and renders.
 */
import type { AgentRun, Approval, GlanceView, Incident } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";

export interface GlanceData {
  /** Latest run of the morning brief; `null`: no brief agent, or it never ran. */
  brief: Pick<AgentRun, "summary" | "ended_at" | "status"> | null;
  cards: Pick<Approval, "id" | "tool_name" | "reason" | "strength" | "created_at">[];
  /** `null`: incidents are not served here (flag off). */
  liveIncidents: Pick<Incident, "id" | "title">[] | null;
}

export type GlancePage =
  | { kind: "summary" }
  | { kind: "brief" }
  | { kind: "card"; index: number };

export function pagesOf(d: GlanceData): GlancePage[] {
  const pages: GlancePage[] = [{ kind: "summary" }];
  if (d.brief?.summary) pages.push({ kind: "brief" });
  d.cards.forEach((_, index) => pages.push({ kind: "card", index }));
  return pages;
}

/** Next / previous page, wrapping: a glance is a loop, not a document. */
export function step(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + delta + total) % total;
}

/** The demo prefix of mock texts is noise on a 600 px screen. */
export function cleanSummary(text: string): string {
  return text.replace(/^\(demo\)\s*/i, "").trim();
}

export function summaryLines(d: GlanceData): string[] {
  const lines: string[] = [];
  const n = d.cards.length;
  lines.push(n === 0 ? tr("Nothing waits for you.") : n === 1 ? tr("1 card waits for you.") : tr("{0} cards wait for you.", n));
  const live = d.liveIncidents?.length ?? 0;
  if (live === 1) lines.push(tr("1 live incident."));
  else if (live > 1) lines.push(tr("{0} live incidents.", live));
  if (!d.brief?.summary) lines.push(tr("No brief yet today."));
  return lines;
}

export function strengthHint(strength: Approval["strength"]): string {
  return strength === "strong" ? tr("Strong card: sign it on your phone.") : tr("Decide it on your phone or computer.");
}

/** Short tool name for the big type: `ssh_run` → « ssh run ». */
export function toolLabel(name: string): string {
  return name.replace(/[_.]+/g, " ").trim();
}

/** `GET /v1/glance` (glance token) → what the pages show; same shapes as the separate reads of a browser session. */
export function fromView(v: GlanceView): GlanceData {
  return { brief: v.brief?.agent ? v.brief_last_run : null, cards: v.approvals, liveIncidents: v.unavailable.includes("incidents") ? null : v.incidents };
}
