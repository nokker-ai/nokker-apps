/**
 * Permission mode of the current session (local or code session), above the chat: change it, see when the project
 * restricts it, read the plan (`todo`) and carry it out. Follows `session.mode` (another client changed it),
 * `todo.updated` and `turn.done` (the plan may have moved), and `tool.result` refused by plan mode.
 */
import React, { useCallback, useEffect, useState } from "react";
import { applyPlanMode, refusalReason, type NokkerClient, type NokkerEvent, type PermissionMode, type SessionModeState, type TodoItem, type TodoResult } from "@nokker-apps/sdk";
import { modeLabel } from "../code/model.js";
import { shellLang, tr } from "../i18n/index.js";
import { Icon } from "../icons.js";

export type ModeTarget = { kind: "local"; threadId: string } | { kind: "code"; threadId: string; sessionId: string };

/** The current thread as a session whose mode can be changed, or `null` (plain chat thread). */
export function modeTarget(threadId: string | null | undefined, localCwd: string | undefined, local: boolean): ModeTarget | null {
  if (!threadId) return null;
  if (local && localCwd) return { kind: "local", threadId };
  const id = threadId.slice(threadId.lastIndexOf(":") + 1);
  return id.startsWith("cs_") ? { kind: "code", threadId, sessionId: id } : null;
}

const STATUS_ICON: Record<TodoItem["status"], string> = { completed: "✓", in_progress: "→", pending: "○", cancelled: "×" };

/** What a refused action means, by the core's stable code; an unknown code gets the generic sentence. */
export function refusalText(reason: string): string {
  switch (reason) {
    case "plan_mode":
      return tr("Plan mode: nothing was written. Apply the plan to make the changes.");
    case "deny_rule":
      return tr("An action was refused by a deny rule (yours, the repository's or the team's).");
    case "hardline":
      return tr("A command that never runs was refused.");
    case "no_code_session":
      return tr("This action needs a code session: open one from the Code tab.");
    default:
      return tr("An action was refused ({0}).", reason);
  }
}

function sameThread(e: { thread_id?: string }, threadId: string): boolean {
  return !!e.thread_id && e.thread_id.split("/sa-")[0] === threadId;
}

export function SessionModeBar({
  client,
  target,
  onEvent,
  onSend,
  toast,
  compact = false,
}: {
  client: NokkerClient;
  target: ModeTarget;
  onEvent: (fn: (e: NokkerEvent) => void) => () => void;
  onSend: (text: string) => void;
  toast: (text: string, tone?: "ok" | "error") => void;
  /** Phone: the plan starts folded so that the chat keeps the height. */
  compact?: boolean;
}): React.ReactElement | null {
  const lang = shellLang();
  // `target` is a new object at each render of the shell: depend on its fields, not on it.
  const { kind, threadId } = target;
  const sessionId = target.kind === "code" ? target.sessionId : "";
  const [state, setState] = useState<SessionModeState | null>(null);
  const [todos, setTodos] = useState<TodoItem[] | null>(null);
  const [open, setOpen] = useState(!compact);
  /** Last refusal reason seen on this thread (`plan_mode`, `deny_rule`, `hardline`, `no_code_session`, or another code). */
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadMode = useCallback(async (): Promise<void> => {
    if (kind === "local") return setState(await client.getLocalSessionMode(threadId));
    const [s, list] = await Promise.all([client.getCodeSession(sessionId), client.listCodeSessions()]);
    const mode = s.mode as PermissionMode;
    setState((cur) => cur ?? { mode, modes: list.modes as PermissionMode[], effective: mode });
  }, [client, kind, threadId, sessionId]);

  const loadPlan = useCallback(async (): Promise<void> => {
    const out = kind === "local" ? await client.callLocalTool(threadId, "todo") : await client.callCodeSessionTool(sessionId, "todo");
    if (!("content" in out) || out.is_error) return setTodos(null);
    try {
      setTodos((JSON.parse(out.content) as TodoResult).todos ?? []);
    } catch {
      setTodos(null);
    }
  }, [client, kind, threadId, sessionId]);

  useEffect(() => {
    setState(null);
    setTodos(null);
    setRefused(null);
    void loadMode().catch(() => setState(null));
    void loadPlan().catch(() => setTodos(null));
  }, [loadMode, loadPlan]);

  useEffect(
    () =>
      onEvent((e) => {
        if (!sameThread(e as { thread_id?: string }, threadId)) return;
        if (e.type === "session.mode") setState((cur) => (cur ? { ...cur, mode: e.mode, effective: e.effective ?? e.mode } : cur));
        else if (e.type === "todo.updated" && Array.isArray(e.items)) setTodos(e.items);
        else if (e.type === "todo.updated" || e.type === "turn.done") void loadPlan().catch(() => undefined);
        else if (e.type === "tool.result") {
          const why = refusalReason(e);
          if (why) setRefused(why);
        }
      }),
    [onEvent, threadId, loadPlan],
  );

  const change = async (mode: PermissionMode): Promise<SessionModeState | null> => {
    setBusy(true);
    try {
      const out = kind === "local" ? await client.setLocalSessionMode(threadId, mode) : await client.setCodeSessionMode(sessionId, mode);
      setState(out);
      if (mode !== "plan") setRefused((r) => (r === "plan_mode" ? null : r));
      return out;
    } catch (e) {
      const code = (e as { body?: { error?: { code?: string } } }).body?.error?.code;
      toast(code === "mode_above_project" ? tr("The project rules do not allow this mode here.") : tr("The mode could not be changed."), "error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const applyPlan = async (): Promise<void> => {
    if (!state) return;
    const next = applyPlanMode(state.modes);
    if (!next) return;
    if (await change(next)) onSend(tr("Go ahead with the plan."));
  };

  if (!state) return null;
  const restricted = state.effective !== state.mode;
  const live = todos?.filter((t) => t.status !== "cancelled") ?? [];
  const done = live.filter((t) => t.status === "completed").length;
  const canApply = state.mode === "plan" && applyPlanMode(state.modes) !== null;

  return (
    <section className={`mode-bar ${state.mode === "plan" ? "is-plan" : ""}`} aria-label={tr("Session mode")}>
      <div className="mode-row">
        <label htmlFor="nk-session-mode" className="fine">
          {tr("Mode")}
        </label>
        <select id="nk-session-mode" value={state.mode} disabled={busy} onChange={(e) => void change(e.target.value as PermissionMode)}>
          {state.modes.map((m) => (
            <option key={m} value={m}>
              {modeLabel(lang, m)}
            </option>
          ))}
        </select>
        {restricted ? <span className="fine mode-limited">{tr("Limited by the project to: {0}", modeLabel(lang, state.effective))}</span> : null}
        {live.length ? (
          <button type="button" className="mode-plan-toggle" aria-expanded={open} aria-controls="nk-plan" onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
            {tr("Plan {0}/{1}", done, live.length)}
          </button>
        ) : null}
        {canApply ? (
          <button type="button" className="btn btn-brass mode-apply" disabled={busy} onClick={() => void applyPlan()}>
            {tr("Apply the plan")}
          </button>
        ) : null}
      </div>
      {refused && (refused !== "plan_mode" || state.mode === "plan") ? (
        <p className="fine mode-refused" role="status">
          {refusalText(refused)}
        </p>
      ) : null}
      {open && live.length ? (
        <ol id="nk-plan" className="mode-plan">
          {live.map((t) => (
            <li key={t.id} className={`todo-${t.status}`}>
              <span className="todo-mark" aria-hidden="true">
                {STATUS_ICON[t.status]}
              </span>
              <span>{t.content}</span>
              <span className="sr-only">{t.status === "completed" ? tr("done") : t.status === "in_progress" ? tr("in progress") : tr("to do")}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
