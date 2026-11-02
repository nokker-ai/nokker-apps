/**
 * Learning → Consolidations (core CONSOLIDATION.md §6): what the nightly memory consolidation did, night by night, and
 * « undo » — one operation, or the whole night (exact state before; idempotent; an op whose note the person edited since
 * stays, shown as a conflict). Pin a note so that a consolidation never touches it. Settings: on/off, time, time zone.
 * Nothing is deleted for good: an archived note can come back. Never shown: tenant, embedding, author of a note.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, opCount, type ConsolidationNoteChange, type ConsolidationOp, type ConsolidationReport, type ConsolidationRun, type ConsolidationSettings, type NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { cronHuman } from "../ops/model.js";
import type { Lang } from "../onboarding/i18n.js";

export function opKindLabel(kind: ConsolidationOp["kind"]): string {
  switch (kind) {
    case "merge":
      return tr("merge");
    case "correct":
      return tr("correction");
    case "archive":
      return tr("archive");
    case "summarize":
      return tr("summary");
    case "lesson":
      return tr("lesson");
    default:
      return String(kind);
  }
}

/** The night in words, in the interface language (the core's `summary` is French text). */
export function nightSummary(run: Pick<ConsolidationRun, "counts">): string {
  const one: Record<string, [string, string]> = {
    merge: [tr("1 merge"), tr("{0} merges")],
    correct: [tr("1 correction"), tr("{0} corrections")],
    archive: [tr("1 archived note"), tr("{0} archived notes")],
    summarize: [tr("1 summary"), tr("{0} summaries")],
    lesson: [tr("1 lesson"), tr("{0} lessons")],
  };
  const parts = (["merge", "correct", "archive", "summarize", "lesson"] as const)
    .filter((k) => (run.counts[k] ?? 0) > 0)
    .map((k) => (run.counts[k] === 1 ? one[k]![0] : one[k]![1].replace("{0}", String(run.counts[k]))));
  return parts.length ? parts.join(", ") : tr("nothing to change");
}

const apiCode = (e: unknown): string | undefined => (e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined);
const nightLabel = (night: string, lang: Lang): string => new Date(`${night}T12:00:00Z`).toLocaleDateString(lang === "fr" ? "fr-CH" : "en-GB", { weekday: "long", day: "numeric", month: "long" });

function Change({ c, pinned, onPin }: { c: ConsolidationNoteChange; pinned: boolean; onPin?: (name: string, pin: boolean) => void }): React.ReactElement {
  const pin =
    onPin && c.action !== "archive" ? (
      <button type="button" className="lrn-link" onClick={() => onPin(c.name, !pinned)}>
        {pinned ? tr("unpin") : tr("pin (never touched again)")}
      </button>
    ) : null;
  if (c.action === "annotate") {
    return (
      <li className="cx-change">
        <span className="fine">{tr("Note annotated")}</span> <q>{c.text}</q> {pin}
      </li>
    );
  }
  const label = c.action === "update" ? tr("Changed") : c.action === "create" ? tr("Added") : tr("Archived (it can come back)");
  return (
    <li className="cx-change">
      <span className="fine">{label}</span> {pinned ? <span className="chip">{tr("pinned")}</span> : null} {pin}
      {c.before && c.action !== "create" ? (
        <p className={`cx-note ${c.action === "update" ? "before" : ""}`}>
          <strong>{c.before.title}</strong> — {c.before.text}
        </p>
      ) : null}
      {c.after ? (
        <p className="cx-note after">
          <strong>{c.after.title}</strong> — {c.after.text}
        </p>
      ) : null}
    </li>
  );
}

function Report({ client, run, lang, pins, onPin, onChanged }: { client: NokkerClient; run: ConsolidationRun; lang: Lang; pins: Set<string>; onPin: (name: string, pin: boolean) => void; onChanged: () => void }): React.ReactElement {
  const [rep, setRep] = useState<ConsolidationReport | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    client.getConsolidationRun(run.id).then(setRep, () => setNote(tr("This night cannot be read right now.")));
  }, [client, run.id]);
  useEffect(load, [load]);

  const undoOp = async (op: ConsolidationOp): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await client.undoConsolidationOp(op.id);
    } catch (e) {
      setNote(apiCode(e) === "conflict" ? tr("Not undone: you changed this note since. Your version stays.") : tr("This operation could not be undone."));
    } finally {
      setConfirm(null);
      setBusy(false);
      load();
      onChanged();
    }
  };
  const undoNight = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const out = await client.undoConsolidationRun(run.id);
      setNote(
        out.complete
          ? tr("The whole night is undone.")
          : out.conflicts.length === 1
            ? tr("Undone, except 1 operation on a note you changed since: your version stays.")
            : tr("Undone, except {0} operations on notes you changed since: your versions stay.", out.conflicts.length),
      );
    } catch {
      setNote(tr("This night could not be undone."));
    } finally {
      setConfirm(null);
      setBusy(false);
      load();
      onChanged();
    }
  };

  if (!rep) return <p className="fine">{note ?? tr("Loading…")}</p>;
  const live = rep.ops.filter((o) => o.undone_at === null);
  return (
    <div className="cx-report">
      {note ? (
        <p className="ob-note" role="status">
          {note}
        </p>
      ) : null}
      <ol className="lrn-cards">
        {rep.ops.map((op) => (
          <li key={op.id} className={`lrn-card cx-op ${op.undone_at !== null ? "undone" : ""}`}>
            <div className="lrn-card-head">
              <strong>{opKindLabel(op.kind)}</strong>
              {op.undone_at !== null ? <span className="chip">{tr("undone")}</span> : null}
            </div>
            <p className="lrn-text">{op.reason}</p>
            <ul className="cx-changes">
              {op.notes.map((c, i) => (
                <Change key={i} c={c} pinned={pins.has(c.name)} onPin={op.undone_at === null ? onPin : undefined} />
              ))}
            </ul>
            {op.undone_at === null ? (
              <div className="lrn-actions">
                {confirm === op.id ? (
                  <>
                    <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void undoOp(op)}>
                      {tr("Yes, undo it")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>
                      {tr("Keep it")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(op.id)}>
                    {tr("Undo")}
                  </button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {live.length > 1 ? (
        <div className="lrn-actions">
          {confirm === "night" ? (
            <>
              <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void undoNight()}>
                {tr("Yes, undo the whole night")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>
                {tr("Keep it")}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm("night")}>
              {tr("Undo the night of {0}", nightLabel(run.night, lang))}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Settings({ client, s, onSaved }: { client: NokkerClient; s: ConsolidationSettings; onSaved: (s: ConsolidationSettings) => void }): React.ReactElement {
  const [cron, setCron] = useState(s.cron);
  const [tz, setTz] = useState(s.tz);
  const [err, setErr] = useState<string | null>(null);
  const save = (body: { enabled?: boolean; cron?: string; tz?: string }): void => {
    setErr(null);
    client.putConsolidationSettings(body).then(onSaved, (e) => setErr(apiCode(e) === "bad_schedule" ? tr("Unknown time zone, or a schedule that is not five cron fields.") : tr("The settings could not be saved.")));
  };
  return (
    <div className="cx-settings">
      <label className="plan-brief-toggle">
        <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        <span>{tr("Tidy my memory every night")}</span>
      </label>
      {s.enabled ? (
        <p className="fine">
          {tr("{0} ({1}), at most {2} operations a night. Everything can be undone.", cronHuman(s.cron), s.tz, s.max_ops)}
        </p>
      ) : null}
      <details>
        <summary className="fine">{tr("Change the time")}</summary>
        <div className="team-inline-form">
          <input aria-label={tr("Schedule (cron)")} value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} />
          <input aria-label={tr("Time zone")} value={tz} onChange={(e) => setTz(e.target.value)} spellCheck={false} />
          <button type="button" className="btn btn-ghost" onClick={() => save({ cron: cron.trim(), tz: tz.trim() })}>
            {tr("Save")}
          </button>
        </div>
      </details>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}

export function Consolidations({ client, lang }: { client: NokkerClient; lang: Lang }): React.ReactElement {
  const [runs, setRuns] = useState<ConsolidationRun[] | null | "off">(null);
  const [settings, setSettings] = useState<ConsolidationSettings | null>(null);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(() => {
    client.listConsolidationRuns().then(
      (r) => {
        setRuns(r.runs);
        setOpen((o) => o ?? r.runs[0]?.id ?? null);
      },
      () => setRuns("off"),
    );
  }, [client]);
  useEffect(() => {
    load();
    client.getConsolidationSettings().then(setSettings, () => undefined);
    client.listConsolidationPins().then((p) => setPins(new Set(p.pins)), () => undefined);
  }, [client, load]);

  const pin = (name: string, on: boolean): void => {
    client.pinConsolidationNote(name, on).then((r) => setPins(new Set(r.pins)), () => undefined);
  };
  const runPreview = (): void => {
    setPreview(null);
    client.runConsolidation(true).then(
      (r) => setPreview("run" in r ? (opCount(r.run) ? tr("Tonight it would do: {0}.", nightSummary(r.run)) : tr("Nothing to tidy right now.")) : tr("Tonight is already done.")),
      (e) => setPreview(apiCode(e) === "busy" ? tr("A consolidation is running: try again in a moment.") : tr("The preview could not be made.")),
    );
  };

  if (runs === null) return <p className="fine">{tr("Loading…")}</p>;
  if (runs === "off") return <p className="fine lrn-empty">{tr("Memory consolidation is not available here.")}</p>;
  return (
    <div className="lrn-pane cx">
      {settings ? <Settings client={client} s={settings} onSaved={setSettings} /> : null}
      <div className="lrn-actions">
        <button type="button" className="btn btn-ghost" onClick={runPreview}>
          {tr("Preview tonight")}
        </button>
        {preview ? (
          <span className="fine" role="status">
            {preview}
          </span>
        ) : null}
      </div>
      {runs.length === 0 ? <p className="fine lrn-empty">{tr("No consolidation yet.")}</p> : null}
      <ul className="lrn-skills">
        {runs.map((r) => (
          <li key={r.id} className="lrn-skill">
            <button type="button" className="lrn-skill-row" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <strong>{nightLabel(r.night, lang)}</strong>
              <span className="fine">
                {r.status === "failed" ? tr("failed") : r.status === "running" ? tr("running") : nightSummary(r)}
                {r.undone_at !== null ? ` · ${tr("undone")}` : ""}
                {r.skipped ? ` · ${tr("{0} left for another night", r.skipped)}` : ""}
              </span>
            </button>
            {open === r.id ? <Report client={client} run={r} lang={lang} pins={pins} onPin={pin} onChanged={load} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
