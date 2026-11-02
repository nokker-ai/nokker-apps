/**
 * Permission mode of an open session, and its plan — mock of the core contract:
 *   GET|PUT /v1/local/sessions/{thread}/mode {mode} → {mode, modes, effective}   (local session)
 *   PATCH   /v1/code/sessions/{cs} {mode}           → {mode, modes, effective}   (code.ts)
 * 400 `bad_mode` outside `modes`, 400 `mode_above_project` when more permissive than the project rules; event
 * `session.mode {thread_id, mode, effective}`. Project rules of the demo: `MOCK_PROJECT_MODE=plan|default|accept_edits` (none by default).
 * Plan: `POST /v1/dev/todo {thread_id, todos}` replaces a thread's plan and publishes `todo.updated {thread_id, items}`.
 */
import { MODE_STRICTNESS, type PermissionMode, type SessionModeState, type TodoItem } from "@nokker-apps/sdk";
import { setTodos } from "./localtools.js";
import type { MockState } from "./state.js";

type Send = (status: number, payload: unknown) => void;

/** Order of the core (`nokker/qa/permissions.py::MODES`). */
export const LOCAL_MODES: PermissionMode[] = ["default", "accept_edits", "auto", "plan"];
const LOCAL_DEFAULT: PermissionMode = "accept_edits";
const STATUSES = ["pending", "in_progress", "completed", "cancelled"];

function projectMode(): PermissionMode | null {
  const m = process.env.MOCK_PROJECT_MODE as PermissionMode | undefined;
  return m && MODE_STRICTNESS.includes(m) ? m : null;
}

const rank = (m: PermissionMode): number => MODE_STRICTNESS.indexOf(m);

/** The mode actually applied: the stricter of the session's and the project's. */
export function effectiveMode(mode: PermissionMode): PermissionMode {
  const p = projectMode();
  return p && rank(p) < rank(mode) ? p : mode;
}

/** Validates and records a session's mode; throws `[status, code, message]` on refusal. */
export function setSessionMode(state: MockState, threadId: string, raw: unknown, modes: PermissionMode[]): SessionModeState {
  const mode = String(raw ?? "") as PermissionMode;
  if (!modes.includes(mode)) throw [400, "bad_mode", `mode refusé : '${mode}' (parmi ${modes.join(", ")})`] as const;
  const p = projectMode();
  if (p && rank(mode) > rank(p)) throw [400, "mode_above_project", `le projet limite cette session au mode ${p}`] as const;
  state.sessionModes.set(threadId, mode);
  const effective = effectiveMode(mode);
  state.publish({ type: "session.mode", thread_id: threadId, mode, effective });
  return { mode, modes, effective };
}

export function sessionModeState(state: MockState, threadId: string, modes: PermissionMode[], fallback: PermissionMode): SessionModeState {
  const mode = state.sessionModes.get(threadId) ?? state.readSettings().mode ?? fallback;
  return { mode, modes, effective: effectiveMode(mode) };
}

export async function handleSessionMode(
  state: MockState,
  user: string | null,
  method: string,
  path: string,
  readBody: () => Promise<Record<string, unknown>>,
  send: Send,
): Promise<boolean> {
  if (path === "/v1/dev/todo" && method === "POST") {
    const b = await readBody();
    const threadId = String(b.thread_id ?? "");
    const todos = Array.isArray(b.todos) ? b.todos : null;
    if (!threadId || !todos || todos.some((t) => !t || typeof t !== "object" || !STATUSES.includes(String((t as TodoItem).status)))) {
      return send(400, { error: { code: "bad_request", message: "thread_id et todos [{id, content, status}] requis" } }), true;
    }
    setTodos(state, threadId, todos as TodoItem[]);
    state.publish({ type: "todo.updated", thread_id: threadId, items: todos as TodoItem[] });
    return send(200, { thread_id: threadId, todos }), true;
  }
  const m = /^\/v1\/local\/sessions\/([^/]+)\/mode$/.exec(path);
  if (!m) return false;
  if (!user) return send(401, { error: { code: "unauthorized", message: "unauthorized" } }), true;
  const threadId = decodeURIComponent(m[1]!);
  if (!state.localSessions.has(threadId)) return send(404, { error: { code: "not_found", message: "pas une session locale" } }), true;
  if (method === "GET") return send(200, sessionModeState(state, threadId, LOCAL_MODES, LOCAL_DEFAULT)), true;
  if (method !== "PUT") return false;
  try {
    return send(200, setSessionMode(state, threadId, (await readBody()).mode, LOCAL_MODES)), true;
  } catch (e) {
    if (Array.isArray(e)) return send(e[0] as number, { error: { code: e[1], message: e[2] } }), true;
    throw e;
  }
}
