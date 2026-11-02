/**
 * Permission mode of a session that is already open (local session or code session), and its plan (`todo`).
 *
 *   GET|PUT /v1/local/sessions/{thread}/mode {mode}   (local token)          → SessionModeState
 *   PATCH   /v1/code/sessions/{cs} {mode}             (account)              → SessionModeState
 *   400 when the mode is not in `modes` or is more permissive than the project rules allow.
 *   Event `session.mode {thread_id, mode, effective}` so that every client of the thread (web, terminal, editor) follows.
 *   Event `todo.updated {thread_id, items}` when the model writes the plan: the whole list, as `todo` reads it.
 *   An action refused outright: `tool.result` (and a direct tools/call answer) with `is_error: true` and `reason`:
 *   `plan_mode` (read only), `deny_rule` (a deny rule of the user, the repository or a team), `hardline` (a command that
 *   never runs), `no_code_session` (a code tool on a thread without a session).
 */
import type { PermissionMode } from "./permissions.js";
import type { TodoItem } from "./types.js";

export type RefusalReason = "plan_mode" | "deny_rule" | "hardline" | "no_code_session";

export interface SessionModeState {
  /** The mode asked for this session. */
  mode: PermissionMode;
  /** Modes this session may take (instance configuration), in the order to show them. */
  modes: PermissionMode[];
  /** Mode actually applied once the project rules have restricted it (never more permissive than `mode`). */
  effective: PermissionMode;
}

export interface SessionModeEvent {
  type: "session.mode";
  thread_id: string;
  mode: PermissionMode;
  /** Applied mode after the project rules (absent from older cores: then equal to `mode`). */
  effective?: PermissionMode;
}

export interface TodoUpdatedEvent {
  type: "todo.updated";
  thread_id: string;
  /** The whole plan after the write (absent: read it again with `todo`). */
  items?: TodoItem[];
}

/** Order from the strictest to the most permissive (what a project may only restrict). */
export const MODE_STRICTNESS: readonly PermissionMode[] = ["plan", "default", "accept_edits", "auto"];

/** Leaving plan mode to carry the plan out: the first allowed mode that may write files, `null` if none. */
export function applyPlanMode(modes: readonly PermissionMode[]): PermissionMode | null {
  for (const m of ["accept_edits", "default", "auto"] as const) if (modes.includes(m)) return m;
  return null;
}

/** Refusal reason carried by a `tool.result`, `null` for anything else (an unknown code is kept for a generic text). */
export function refusalReason(e: { is_error?: boolean; reason?: string }): string | null {
  return e.is_error === true && typeof e.reason === "string" && e.reason ? e.reason : null;
}

/** `tool.result` refused because the session is in plan mode. */
export function isPlanModeRefusal(e: { is_error?: boolean; reason?: string }): boolean {
  return e.is_error === true && e.reason === "plan_mode";
}
