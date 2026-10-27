/**
 * Projet d'équipe, sections du §7.27 (onglet Équipe) : budget (deux barres jour et mois, une ligne par membre pour
 * owner et maintainer, plafond), agents de tous les membres (ceux des autres réduits ; l'owner peut seulement les
 * désarmer), journal du projet (owner, maintainer). Le noyau décide ; l'écran ne fait que griser.
 */
import React, { useCallback, useEffect, useState } from "react";
import { canRole, type BudgetWindow, type NokkerClient, type Project, type ProjectAgentEntry, type ProjectAuditEvent, type ProjectBudgetCap, type ProjectBudgetView } from "@nokker-apps/sdk";
import { fmtWhen, teamError } from "../team/model.js";
import { shellLang, tr } from "../i18n/index.js";
import "./project.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

export function money(v: number, currency: string): string {
  return `${v.toFixed(2)} ${currency}`;
}

/** État d'une fenêtre écrit en clair (§7.27.4). */
export function windowState(w: BudgetWindow): string {
  return w.state === "over" ? tr("reached: the project's turns are refused") : w.state === "warning" ? tr("over 80%") : w.state === "ok" ? tr("ok") : tr("no cap");
}

/** Heure de remise à zéro, en heure suisse. */
export function resetsLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(shellLang() === "fr" ? "fr-CH" : "en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d);
}

function Bar({ label, w, currency }: { label: string; w: BudgetWindow; currency: string }): React.ReactElement {
  const pct = w.cap ? Math.min(100, Math.round((w.spent / w.cap) * 100)) : 0;
  return (
    <div className={`budget-bar st-${w.state}`}>
      <div className="budget-bar-head">
        <strong>{label}</strong>
        <span className="fine">
          {money(w.spent, currency)}
          {w.cap !== null ? ` / ${money(w.cap, currency)}` : ""} · {windowState(w)}
        </span>
      </div>
      {w.cap !== null ? (
        <div className="budget-track" role="progressbar" aria-label={tr("{0}: {1}%", label, pct)} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <span className="fine">{tr("resets on {0}", resetsLabel(w.resets_at))}</span>
    </div>
  );
}

export function ProjectBudget({ client, p, toast, onSaved }: { client: NokkerClient; p: Project; toast: Toast; onSaved: () => void }): React.ReactElement | null {
  const [v, setV] = useState<ProjectBudgetView | null>(null);
  const [edit, setEdit] = useState<{ daily: string; monthly: string; currency: ProjectBudgetCap["currency"] } | null>(null);
  const [busy, setBusy] = useState(false);
  const can = canRole(p.role, "maintainer");
  const load = useCallback(async () => {
    try {
      setV(await client.getProjectBudget(p.id));
    } catch {
      setV(null);
    }
  }, [client, p.id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!v) return null;
  const currency = (v.budget?.currency ?? v.currency ?? "EUR") as ProjectBudgetCap["currency"];
  const save = async (): Promise<void> => {
    if (!edit) return;
    const num = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s.replace(",", ".")));
    const body = { daily: num(edit.daily), monthly: num(edit.monthly), currency: edit.currency };
    setBusy(true);
    try {
      if (body.daily === undefined && body.monthly === undefined) await client.deleteProjectBudget(p.id);
      else await client.putProjectBudget(p.id, body);
      toast(tr("Project budget saved."), "ok");
      setEdit(null);
      onSaved();
      await load();
    } catch (e) {
      toast(teamError(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="machine-section project-budget">
      <h3>{tr("Budget")}</h3>
      {!v.counted ? (
        <p className="fine">{tr("Cap stored, not yet counted on this instance.")}</p>
      ) : (
        <>
          {v.unconverted?.length ? (
            <p className="budget-warn" role="alert">
              {tr("Spending in a currency without a rate ({0}): the budget refuses turns as a precaution.", v.unconverted.join(", "))}
            </p>
          ) : null}
          {v.today ? <Bar label={tr("Today")} w={v.today} currency={currency} /> : null}
          {v.month ? <Bar label={tr("This month")} w={v.month} currency={currency} /> : null}
          {v.members?.length ? (
            <table className="budget-members">
              <thead>
                <tr>
                  <th scope="col">{tr("Member")}</th>
                  <th scope="col">{tr("Today")}</th>
                  <th scope="col">{tr("This month")}</th>
                </tr>
              </thead>
              <tbody>
                {v.members.map((m) => (
                  <tr key={m.account_id}>
                    <td>{m.former ? tr("former member") : m.you ? tr("{0} (you)", m.email ?? m.account_id) : (m.email ?? m.account_id)}</td>
                    <td>{money(m.today, currency)}</td>
                    <td>{money(m.month, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {v.unpriced_models?.length ? <p className="fine">{tr("Models without a price (counted as 0): {0}.", v.unpriced_models.join(", "))}</p> : null}
        </>
      )}
      {can ? (
        edit ? (
          <form
            className="team-inline-form budget-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              {tr("Per day")} <input inputMode="decimal" value={edit.daily} onChange={(e) => setEdit({ ...edit, daily: e.target.value })} placeholder={tr("none")} aria-label={tr("Daily cap")} />
            </label>
            <label>
              {tr("Per month")} <input inputMode="decimal" value={edit.monthly} onChange={(e) => setEdit({ ...edit, monthly: e.target.value })} placeholder={tr("none")} aria-label={tr("Monthly cap")} />
            </label>
            <select aria-label={tr("Currency")} value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value as ProjectBudgetCap["currency"] })}>
              {(["EUR", "CHF", "USD"] as const).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-brass" disabled={busy}>
              {tr("Save")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
              {tr("Cancel")}
            </button>
            <p className="fine budget-form-note">{tr("Leave both empty to remove the cap. A turn started under the cap runs to completion.")}</p>
          </form>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setEdit({ daily: v.budget?.daily?.toString() ?? "", monthly: v.budget?.monthly?.toString() ?? "", currency })}>
            {v.budget ? tr("Edit the cap") : tr("Set a cap")}
          </button>
        )
      ) : null}
    </section>
  );
}

/** Déclencheur d'un agent en clair (pour un événement, la famille seulement). */
export function triggerText(t: Record<string, unknown> | null | undefined): string {
  if (!t) return tr("manual");
  if (t.kind === "schedule") return tr("scheduled ({0})", `${String(t.cron ?? "")}${t.tz ? `, ${String(t.tz)}` : ""}`);
  if (t.kind === "once") return t.at ? tr("once ({0})", String(t.at)) : tr("once");
  if (t.kind === "event") return tr("on event {0}", String(t.event ?? t.family ?? ""));
  return String(t.kind ?? tr("manual"));
}

function statusText(s: string): string {
  switch (s) {
    case "armed":
      return tr("armed");
    case "paused":
      return tr("idle");
    case "running":
      return tr("running");
    case "failed":
      return tr("failed");
    default:
      return s;
  }
}
function runText(s: string): string {
  switch (s) {
    case "done":
      return tr("succeeded");
    case "failed":
      return tr("failed");
    case "running":
      return tr("in progress");
    case "queued":
      return tr("queued");
    case "cancelled":
      return tr("cancelled");
    case "skipped":
      return tr("skipped");
    default:
      return s;
  }
}

export function ProjectAgents({ client, p, toast }: { client: NokkerClient; p: Project; toast: Toast }): React.ReactElement {
  const [items, setItems] = useState<ProjectAgentEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await client.listProjectAgents(p.id)).agents);
      setErr(null);
    } catch (e) {
      setErr(teamError(e));
      setItems((cur) => cur ?? []);
    }
  }, [client, p.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const disarm = async (a: ProjectAgentEntry): Promise<void> => {
    setConfirm(null);
    try {
      await client.disarmProjectAgent(p.id, a.id);
      toast(a.mine ? tr("“{0}” disarmed.", a.name) : tr("“{0}” disarmed; {1} has been notified and can re-arm it.", a.name, a.owner.email), "ok");
      await load();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  return (
    <section className="machine-section">
      <h3>{tr("Project agents")}</h3>
      {err ? <p className="error">{err}</p> : null}
      {items?.length ? (
        <ul className="secret-list project-agents">
          {items.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.name}</strong> <span className="chip">{statusText(a.status)}</span>
                <p className="fine">
                  {a.mine ? tr("yours (in Crew)") : tr("belongs to {0}", a.owner.email)} · {triggerText(a.trigger as Record<string, unknown> | null)}
                  {a.last_run ? ` · ${a.last_run.ended_at ? tr("last run {0} on {1}", runText(a.last_run.status), fmtWhen(a.last_run.ended_at)) : tr("last run {0}", runText(a.last_run.status))}` : ""}
                </p>
              </div>
              {a.can_disarm ? (
                confirm === a.id ? (
                  <span className="team-row-actions">
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void disarm(a)}>
                      {tr("Yes, disarm")}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                      {tr("Cancel")}
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(a.id)}>
                    {tr("Disarm")}
                  </button>
                )
              ) : null}
              {confirm === a.id && !a.mine ? <p className="fine project-agent-note">{tr("{0} will be notified and can re-arm it.", a.owner.email)}</p> : null}
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">{tr("No agent is attached to this project.")}</p>
      ) : null}
    </section>
  );
}

function auditLabel(event: string): string {
  switch (event) {
    case "budget_set":
      return tr("cap set");
    case "budget_removed":
      return tr("cap removed");
    case "note_restored":
      return tr("note version restored");
    case "agent_disarmed":
      return tr("member's agent disarmed");
    default:
      return event;
  }
}

export function auditLine(e: ProjectAuditEvent): string {
  const d = e.detail ?? {};
  const bits: string[] = [auditLabel(e.event)];
  if (e.event === "budget_set") bits.push([d.daily !== undefined ? tr("{0}/day", String(d.daily)) : "", d.monthly !== undefined ? tr("{0}/month", String(d.monthly)) : "", String(d.currency ?? "")].filter(Boolean).join(" "));
  if (typeof d.name === "string") bits.push(tr("“{0}”", d.name));
  if (typeof d.owner_account === "string") bits.push(tr("from {0}", d.owner_account));
  return bits.join(" · ");
}

export function ProjectAudit({ client, p }: { client: NokkerClient; p: Project }): React.ReactElement | null {
  const [events, setEvents] = useState<ProjectAuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!canRole(p.role, "maintainer")) return null;
  return (
    <section className="machine-section">
      <details
        onToggle={(e) => {
          if (!(e.currentTarget as HTMLDetailsElement).open || events) return;
          client.getProjectAudit(p.id, 100).then(
            (r) => setEvents(r.events),
            (er: unknown) => setErr(teamError(er)),
          );
        }}
      >
        <summary>
          <strong>{tr("Project log")}</strong>
        </summary>
        {err ? <p className="error">{err}</p> : null}
        {events?.length === 0 ? <p className="fine">{tr("Nothing yet.")}</p> : null}
        {events?.length ? (
          <ul className="secret-list">
            {events.map((e) => (
              <li key={e.id}>
                <span className="fine">{e.at ? new Date(e.at).toLocaleString(shellLang() === "fr" ? "fr-CH" : "en-GB") : "—"}</span> <span>{auditLine(e)}</span> <span className="fine">{tr("by {0}", e.actor_account)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </section>
  );
}
