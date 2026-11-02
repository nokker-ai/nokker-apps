/**
 * « Who does what » — presence of the agents, contact-list style (core docs/WHO-DOES-WHAT.md, flag `who_does_what`;
 * off → 404). Read only: approvals stay in the cards. Account session.
 *
 *   GET /v1/presence → PresenceView
 *   SSE presence.changed {id (thread), status, activity_tool}
 */

export type PresenceStatus = "working" | "awaiting_approval" | "blocked" | "paused" | "idle";
export type PresenceKind = "thread" | "code" | "subagent" | "agent" | "house";

export type PresenceActivityCode =
  | "snippet" | "thinking" | "tool" | "turn_paused" | "approval" | "goal_blocked" | "goal_draft" | "goal_active"
  | "run_summary" | "run_queued" | "run_running" | "run_failed" | "agent_paused" | "next_run" | "house_working" | "unavailable";

/** `tool`: tool name; `text`: thread excerpt, goal or run summary (user's own words); `at`: ISO date. */
export interface PresenceActivity {
  code: PresenceActivityCode | (string & {});
  tool?: string;
  text?: string;
  at?: string;
}

export interface PresenceTarget {
  type: "thread" | "agent" | "house";
  id: string;
  /** Agent only: the thread of the pass in progress, if any. */
  thread_id?: string | null;
}

export interface PresenceEntry {
  id: string;
  kind: PresenceKind;
  name: string;
  role?: string | null;
  status: PresenceStatus;
  /** A code plus raw values: the core writes no sentence, the client words it in its own language. */
  activity: PresenceActivity | null;
  since: string | null;
  goal?: { text: string | null; status: string } | null;
  /** Sub-agent only: the parent thread. */
  parent?: string;
  target: PresenceTarget;
}

export interface PresenceView {
  viewer: { household: boolean; payer: boolean; read_only: boolean };
  entries: PresenceEntry[];
  counts: Record<PresenceStatus, number>;
  /** Id of the first entry waiting for the human, `null` if none. */
  next_waiting: string | null;
}

export interface PresenceChangedEvent {
  type: "presence.changed";
  id: string;
  status: PresenceStatus;
  activity_tool?: string | null;
}
