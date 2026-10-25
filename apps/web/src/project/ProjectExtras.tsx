/**
 * Projet d'équipe, sections du §7.27 (onglet Équipe) : budget (deux barres jour et mois, une ligne par membre pour
 * owner et maintainer, plafond), agents de tous les membres (ceux des autres réduits ; l'owner peut seulement les
 * désarmer), journal du projet (owner, maintainer). Le noyau décide ; l'écran ne fait que griser.
 */
import React, { useCallback, useEffect, useState } from "react";
import { canRole, type BudgetWindow, type NokkerClient, type Project, type ProjectAgentEntry, type ProjectAuditEvent, type ProjectBudgetCap, type ProjectBudgetView } from "@nokker-apps/sdk";
import { fmtWhen, teamError } from "../team/model.js";
import "./project.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

export function money(v: number, currency: string): string {
  return `${v.toFixed(2)} ${currency}`;
}

/** État d'une fenêtre écrit en clair (§7.27.4). */
export function windowState(w: BudgetWindow): string {
  return w.state === "over" ? "atteint : les tours du projet sont refusés" : w.state === "warning" ? "80 % passé" : w.state === "ok" ? "ok" : "pas de plafond";
}

/** Heure de remise à zéro, en heure suisse. */
export function resetsLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("fr-CH", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d);
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
        <div className="budget-track" role="progressbar" aria-label={`${label} : ${pct} %`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <span className="fine">repart le {resetsLabel(w.resets_at)}</span>
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
      toast("Budget du projet enregistré.", "ok");
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
      <h3>Budget</h3>
      {!v.counted ? (
        <p className="fine">Plafond rangé, pas encore décompté sur cette instance.</p>
      ) : (
        <>
          {v.unconverted?.length ? (
            <p className="budget-warn" role="alert">
              Dépenses dans une devise sans taux ({v.unconverted.join(", ")}) : le budget refuse les tours par prudence.
            </p>
          ) : null}
          {v.today ? <Bar label="Aujourd'hui" w={v.today} currency={currency} /> : null}
          {v.month ? <Bar label="Ce mois" w={v.month} currency={currency} /> : null}
          {v.members?.length ? (
            <table className="budget-members">
              <thead>
                <tr>
                  <th scope="col">Membre</th>
                  <th scope="col">Aujourd'hui</th>
                  <th scope="col">Ce mois</th>
                </tr>
              </thead>
              <tbody>
                {v.members.map((m) => (
                  <tr key={m.account_id}>
                    <td>{m.former ? "ancien membre" : m.you ? `${m.email ?? m.account_id} (toi)` : (m.email ?? m.account_id)}</td>
                    <td>{money(m.today, currency)}</td>
                    <td>{money(m.month, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {v.unpriced_models?.length ? <p className="fine">Modèles sans prix (comptés 0) : {v.unpriced_models.join(", ")}.</p> : null}
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
              Par jour <input inputMode="decimal" value={edit.daily} onChange={(e) => setEdit({ ...edit, daily: e.target.value })} placeholder="aucun" aria-label="Plafond par jour" />
            </label>
            <label>
              Par mois <input inputMode="decimal" value={edit.monthly} onChange={(e) => setEdit({ ...edit, monthly: e.target.value })} placeholder="aucun" aria-label="Plafond par mois" />
            </label>
            <select aria-label="Devise" value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value as ProjectBudgetCap["currency"] })}>
              {(["EUR", "CHF", "USD"] as const).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-brass" disabled={busy}>
              Enregistrer
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEdit(null)}>
              Annuler
            </button>
            <p className="fine budget-form-note">Laisse les deux vides pour retirer le plafond. Un tour commencé sous le plafond va à son terme.</p>
          </form>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setEdit({ daily: v.budget?.daily?.toString() ?? "", monthly: v.budget?.monthly?.toString() ?? "", currency })}>
            {v.budget ? "Modifier le plafond" : "Poser un plafond"}
          </button>
        )
      ) : null}
    </section>
  );
}

/** Déclencheur d'un agent en clair (pour un événement, la famille seulement). */
export function triggerText(t: Record<string, unknown> | null | undefined): string {
  if (!t) return "manuel";
  if (t.kind === "schedule") return `planifié (${String(t.cron ?? "")}${t.tz ? `, ${String(t.tz)}` : ""})`;
  if (t.kind === "once") return `une fois${t.at ? ` (${String(t.at)})` : ""}`;
  if (t.kind === "event") return `sur événement ${String(t.event ?? t.family ?? "")}`;
  return String(t.kind ?? "manuel");
}

const STATUS: Record<string, string> = { armed: "armé", paused: "au repos", running: "en marche", failed: "en échec" };
const RUN: Record<string, string> = { done: "réussi", failed: "en échec", running: "en cours", queued: "en attente", cancelled: "annulé", skipped: "écarté" };

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
      toast(a.mine ? `« ${a.name} » désarmé.` : `« ${a.name} » désarmé ; ${a.owner.email} est prévenu et pourra le réarmer.`, "ok");
      await load();
    } catch (e) {
      toast(teamError(e), "error");
    }
  };
  return (
    <section className="machine-section">
      <h3>Agents du projet</h3>
      {err ? <p className="error">{err}</p> : null}
      {items?.length ? (
        <ul className="secret-list project-agents">
          {items.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.name}</strong> <span className="chip">{STATUS[a.status] ?? a.status}</span>
                <p className="fine">
                  {a.mine ? "à toi (dans Crew)" : `à ${a.owner.email}`} · {triggerText(a.trigger as Record<string, unknown> | null)}
                  {a.last_run ? ` · dernier passage ${RUN[a.last_run.status] ?? a.last_run.status}${a.last_run.ended_at ? ` le ${fmtWhen(a.last_run.ended_at)}` : ""}` : ""}
                </p>
              </div>
              {a.can_disarm ? (
                confirm === a.id ? (
                  <span className="team-row-actions">
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void disarm(a)}>
                      Oui, désarmer
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                      Annuler
                    </button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(a.id)}>
                    Désarmer
                  </button>
                )
              ) : null}
              {confirm === a.id && !a.mine ? <p className="fine project-agent-note">{a.owner.email} sera prévenu et pourra le réarmer.</p> : null}
            </li>
          ))}
        </ul>
      ) : items ? (
        <p className="fine">Aucun agent n'est rattaché à ce projet.</p>
      ) : null}
    </section>
  );
}

const AUDIT_LABEL: Record<string, string> = {
  budget_set: "plafond posé",
  budget_removed: "plafond retiré",
  note_restored: "version de note remise en place",
  agent_disarmed: "agent d'un membre désarmé",
};

export function auditLine(e: ProjectAuditEvent): string {
  const d = e.detail ?? {};
  const bits: string[] = [AUDIT_LABEL[e.event] ?? e.event];
  if (e.event === "budget_set") bits.push([d.daily !== undefined ? `${d.daily}/jour` : "", d.monthly !== undefined ? `${d.monthly}/mois` : "", String(d.currency ?? "")].filter(Boolean).join(" "));
  if (typeof d.name === "string") bits.push(`« ${d.name} »`);
  if (typeof d.owner_account === "string") bits.push(`de ${d.owner_account}`);
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
          <strong>Journal du projet</strong>
        </summary>
        {err ? <p className="error">{err}</p> : null}
        {events?.length === 0 ? <p className="fine">Rien pour l'instant.</p> : null}
        {events?.length ? (
          <ul className="secret-list">
            {events.map((e) => (
              <li key={e.id}>
                <span className="fine">{e.at ? new Date(e.at).toLocaleString("fr-CH") : "—"}</span> <span>{auditLine(e)}</span> <span className="fine">par {e.actor_account}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </section>
  );
}
