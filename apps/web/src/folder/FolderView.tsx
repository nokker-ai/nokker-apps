/**
 * Folder mode view (core FOLDER-MODE §6), on the Lokkal machine only (local token; through the gateway the core says
 * `403 local_only`, the view is not offered). Ask a task on a folder → the plan to approve → progress → the report →
 * undo. The run is read again every 2 s while it moves. Approving an in-place run takes an explicit checkbox that
 * shows the path (`confirm_in_place: true`).
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, folderProgress, folderRunMoving, type FolderRun, type FolderRunSummary, type NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { POLL_MS, actionLabel, apiCodeText, cardText, runStatusLabel, runTone, stepLabel, zonePath } from "./model.js";
import "./folder.css";

function errText(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = (e.body as { error?: { code?: string; message?: string } } | undefined)?.error;
    return apiCodeText(b?.code, b?.message ?? e.message);
  }
  return e instanceof Error ? e.message : String(e);
}

function NewRun({ client, roots, onCreated }: { client: NokkerClient; roots: string[]; onCreated: (r: FolderRun) => void }): React.ReactElement {
  const [path, setPath] = useState("");
  const [task, setTask] = useState("");
  const [out, setOut] = useState("");
  const [inPlace, setInPlace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.createFolderRun({ path: path.trim(), task: task.trim(), ...(inPlace ? { in_place: true } : out.trim() ? { out: out.trim() } : {}) });
      setTask("");
      onCreated(r);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="fm-new"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="fm-path">{tr("Folder on this machine")}</label>
      <input id="fm-path" list="fm-roots" value={path} onChange={(e) => setPath(e.target.value)} placeholder={roots[0] ?? "/home/alice/Documents"} autoComplete="off" spellCheck={false} />
      <datalist id="fm-roots">
        {roots.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      {roots.length ? <p className="ob-note">{tr("Under a folder declared for Nokker: {0}", roots.join(", "))}</p> : null}
      <label htmlFor="fm-task">{tr("What should Nokker do?")}</label>
      <textarea id="fm-task" rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder={tr("Sort these files by type and write a summary")} />
      <label className="fm-check">
        <input type="checkbox" checked={inPlace} onChange={(e) => setInPlace(e.target.checked)} />
        <span>{tr("Work in place (change the folder itself)")}</span>
      </label>
      {!inPlace ? (
        <>
          <label htmlFor="fm-out">{tr("Output folder (optional)")}</label>
          <input id="fm-out" value={out} onChange={(e) => setOut(e.target.value)} placeholder={path.trim() ? `${path.trim().replace(/\/$/, "")}-nokker` : ""} autoComplete="off" spellCheck={false} />
        </>
      ) : null}
      {error ? (
        <p className="ob-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="ob-actions">
        <button type="submit" className="ob-btn primary" disabled={busy || !path.trim() || !task.trim()}>
          {tr("Ask for a plan")}
        </button>
      </div>
    </form>
  );
}

function RunDetail({ client, id, onChanged }: { client: NokkerClient; id: string; onChanged: () => void }): React.ReactElement {
  const [run, setRun] = useState<FolderRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [askUndo, setAskUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => client.getFolderRun(id).then(setRun, (e) => setError(errText(e))), [client, id]);
  useEffect(() => {
    setRun(null);
    setConfirm(false);
    setAskUndo(false);
    void read();
  }, [read]);
  // Plan and execution run in the background: read the run again every 2 s while it moves.
  useEffect(() => {
    if (!run || !folderRunMoving(run.status)) return;
    const t = setTimeout(() => void read(), POLL_MS);
    return () => clearTimeout(t);
  }, [run, read]);
  const status = run?.status;
  useEffect(() => {
    if (status && !folderRunMoving(status)) onChanged();
  }, [status, onChanged]);
  if (!run) return <div className="fm-detail">{error ? <p className="ob-error">{error}</p> : <p className="ob-note">{tr("Loading…")}</p>}</div>;

  const act = async (fn: () => Promise<FolderRun>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setRun(await fn());
      setAskUndo(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const steps = run.plan?.etapes ?? [];
  const { done, total } = folderProgress(run);
  const undoable = run.status === "done" || run.status === "failed";
  return (
    <div className="fm-detail" data-run={run.status}>
      <div className="fm-head">
        <span className={`chip ${runTone(run.status)}`}>{runStatusLabel(run.status)}</span>
        {run.in_place ? <span className="chip">{tr("in place")}</span> : null}
        {folderRunMoving(run.status) ? <span className="ob-note" aria-live="polite">{run.status === "running" && total ? tr("{0} of {1} steps", done, total) : tr("Nokker is reading the folder…")}</span> : null}
      </div>
      <p className="fm-task">{run.task}</p>
      <dl className="acc-dl">
        <dt>{tr("Folder")}</dt>
        <dd className="mono fm-path">{run.path}</dd>
        {run.out ? (
          <>
            <dt>{tr("Output")}</dt>
            <dd className="mono fm-path">{run.out}</dd>
          </>
        ) : null}
      </dl>
      {run.status === "running" && total ? (
        <div className="acc-bar" role="progressbar" aria-label={tr("Progress")} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <div className="acc-bar-fill" style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </div>
      ) : null}
      {run.plan ? (
        <section aria-labelledby={`fm-plan-${run.run_id}`}>
          <h4 id={`fm-plan-${run.run_id}`}>{tr("Plan")}</h4>
          <p className="fm-model">{run.plan.resume}</p>
          <ol className="fm-steps">
            {steps.map((s, i) => (
              <li key={i} data-step={run.steps[i] ?? "en attente"}>
                <span className="fm-action">{actionLabel(s.action)}</span>
                <span className="fm-where">
                  <span className="mono">{zonePath(s.chemin)}</span>
                  {s.vers ? (
                    <>
                      {" → "}
                      <span className="mono">{zonePath(s.vers)}</span>
                    </>
                  ) : null}
                  {s.pourquoi ? <span className="ob-note"> · {s.pourquoi}</span> : null}
                </span>
                {run.status !== "awaiting_approval" ? <span className={`chip ${run.steps[i] === "fait" ? "ok" : run.steps[i] === "non fait" ? "ko" : ""}`}>{stepLabel(run.steps[i])}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {run.status === "awaiting_approval" ? (
        <div className={`fm-card ${run.in_place ? "strong" : ""}`}>
          <p>{cardText(run.in_place)}</p>
          {run.in_place ? (
            <label className="fm-check">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>
                {tr("I confirm: Nokker will change")} <span className="mono fm-path">{run.path}</span>
              </span>
            </label>
          ) : null}
          <div className="ob-actions">
            <button type="button" className="ob-btn primary" disabled={busy || (run.in_place && !confirm)} onClick={() => void act(() => client.decideFolderRun(run.run_id, "approve", run.in_place && confirm))}>
              {tr("Approve the plan")}
            </button>
            <button type="button" className="ob-btn" disabled={busy} onClick={() => void act(() => client.decideFolderRun(run.run_id, "reject"))}>
              {tr("Refuse")}
            </button>
          </div>
        </div>
      ) : null}
      {run.error ? <p className="ob-error">{tr("Error: {0}", run.error)}</p> : null}
      {run.report ? (
        <section className="fm-report" aria-labelledby={`fm-rep-${run.run_id}`}>
          <h4 id={`fm-rep-${run.run_id}`}>{tr("Report")}</h4>
          <p className="ob-note">{tr("{0} file(s) touched", run.report.fichiers_touches.length)}</p>
          <ul className="fm-touched">
            {run.report.fichiers_touches.map((f, i) => (
              <li key={i}>
                <span className="fm-action">{actionLabel(f.action)}</span> <span className="mono">{zonePath(f.chemin)}</span>
                {f.vers ? (
                  <>
                    {" → "}
                    <span className="mono">{zonePath(f.vers)}</span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {run.report.etapes_non_faites.length ? <p className="ob-note">{tr("{0} step(s) not done", run.report.etapes_non_faites.length)}</p> : null}
          <p className="ob-note">{run.report.point_de_retour ? tr("A restore point was taken: this run can be undone.") : tr("No restore point: nothing was written in the folder.")}</p>
          {run.report.corbeille ? <p className="ob-note">{tr("Removed files are kept in {0}", zonePath(run.report.corbeille))}</p> : null}
          {run.report.resume_modele ? (
            <figure className="fm-said">
              <figcaption>{tr("What Nokker says")}</figcaption>
              <p className="fm-model">{run.report.resume_modele}</p>
            </figure>
          ) : null}
        </section>
      ) : null}
      {run.undo ? (
        <div className="fm-undo" role="status">
          {run.undo.conflicts.length ? (
            <>
              <p>{tr("{0} file(s) changed since the run were kept as they are:", run.undo.conflicts.length)}</p>
              <ul>
                {run.undo.conflicts.map((c) => (
                  <li key={c.path}>
                    <span className="mono">{zonePath(c.path)}</span> <span className="ob-note">· {c.why}</span>
                  </li>
                ))}
              </ul>
              <div className="ob-actions">
                <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void act(() => client.undoFolderRun(run.run_id, true))}>
                  {tr("Undo anyway (their current version is set aside)")}
                </button>
              </div>
            </>
          ) : (
            <p>{tr("Undone: the folder is back as it was before the run.")}</p>
          )}
        </div>
      ) : null}
      {undoable && !run.undo ? (
        askUndo ? (
          <div className="ob-actions">
            <button type="button" className="ob-btn danger" disabled={busy} onClick={() => void act(() => client.undoFolderRun(run.run_id))}>
              {tr("Yes, undo this run")}
            </button>
            <button type="button" className="ob-btn" onClick={() => setAskUndo(false)}>
              {tr("Keep it")}
            </button>
          </div>
        ) : (
          <div className="ob-actions">
            <button type="button" className="ob-btn" onClick={() => setAskUndo(true)}>
              {tr("Undo this run")}
            </button>
          </div>
        )
      ) : null}
      {error ? (
        <p className="ob-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function FolderView({ client }: { client: NokkerClient }): React.ReactElement {
  const [runs, setRuns] = useState<FolderRunSummary[] | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client.listFolderRuns().then((r) => setRuns(r.runs), (e) => setError(errText(e)));
  }, [client]);
  useEffect(load, [load]);
  useEffect(() => {
    client.listLocalSessionsAndRoots().then((r) => setRoots(r.roots), () => undefined);
  }, [client]);
  return (
    <div className="ob ob-embedded fm" data-folder-view>
      <div className="ob-card">
        <h2 className="ob-title">{tr("Folder mode")}</h2>
        <p className="ob-muted">{tr("Nokker works on a folder of this machine: it proposes a plan, you approve it, then it writes to an output folder — or in the folder itself if you ask. Nothing is deleted, and every run can be undone.")}</p>
        <section className="ob-conn" aria-labelledby="fm-new-h">
          <h3 id="fm-new-h">{tr("New run")}</h3>
          <NewRun
            client={client}
            roots={roots}
            onCreated={(r) => {
              setCurrent(r.run_id);
              load();
            }}
          />
        </section>
        {current ? (
          <section className="ob-conn" aria-label={tr("Run")}>
            <RunDetail client={client} id={current} onChanged={load} />
          </section>
        ) : null}
        {error ? <p className="ob-error">{error}</p> : null}
        {runs && runs.length ? (
          <section className="ob-conn" aria-labelledby="fm-runs-h">
            <h3 id="fm-runs-h">{tr("Runs")}</h3>
            <ul className="acc-list fm-runs">
              {runs.map((r) => (
                <li key={r.run_id} className={r.run_id === current ? "current" : ""}>
                  <button type="button" className="fm-run" onClick={() => setCurrent(r.run_id)} aria-current={r.run_id === current ? "true" : undefined}>
                    <span className="fm-run-task">{r.task}</span>
                    <span className="mono ob-note fm-path">{r.path}</span>
                  </button>
                  <span className={`chip ${runTone(r.status)}`}>{runStatusLabel(r.status)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
