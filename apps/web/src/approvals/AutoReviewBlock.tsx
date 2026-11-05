/**
 * Automatic review on an approval card (APPROVALS.md §8).
 *
 * - Decision standing (`decided_via: "auto-review"`, not revoked): the card is COMPACT — « Approved automatically ·
 *   reason · Revoke » — so it never reads as a card waiting for a decision (`isAutoDecided`).
 * - Approval revoked: the restore point (from the revoke answer, or from `GET /v1/approvals/{id}` after a reload): the
 *   files it would put back and « Restore files ». Nothing is restored at revocation; restoring is an explicit second
 *   click, and a file modified since the write is never overwritten (listed as a conflict).
 * - Point already applied (`rollback.applied`, or a 409): « Already restored », with what was and was not put back.
 */
import { useState } from "react";
import { NokkerApiError, type Approval, type AutoReviewRollbackOffer, type NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import "./auto-review.css";

/** Reasons the core writes in French (`nokker/tools/card_snapshots.py`, `server.py::_rollback_offer`), shown in the
 * interface language; any other reason is shown as the core wrote it. */
export function rollbackReasonText(reason: string | undefined): string {
  const r = (reason ?? "").trim();
  switch (r.toLowerCase()) {
    case "":
    case "aucun point de retour pour cette carte":
      return tr("No restore point for this action.");
    case "restauration déjà appliquée":
      return tr("The restore was already applied.");
    case "écriture non terminée":
      return tr("The write did not finish: nothing to restore.");
    case "point incomplet":
      return tr("The restore point is incomplete.");
    default:
      return r;
  }
}

/** Decided by the reviewer and not revoked: the compact card. */
export function isAutoDecided(a: Approval): boolean {
  const ar = a.auto_review;
  return a.decided_via === "auto-review" && !!ar && (ar.decision === "approve" || ar.decision === "reject") && !ar.revoked_by;
}

export interface AppliedView {
  restored: string[];
  conflicts: string[];
}

/** What an applied point put back, as `GET` returns it (`applied: true` + lists, or `applied: {restored, conflicts}`);
 * `null` when the point was not applied. */
export function appliedOf(o: AutoReviewRollbackOffer | null | undefined): AppliedView | null {
  if (!o?.applied) return null;
  const inner = typeof o.applied === "object" ? o.applied : {};
  return { restored: inner.restored ?? o.restored ?? [], conflicts: inner.conflicts ?? o.conflicts ?? [] };
}

function FileList({ files, conflict }: { files: string[]; conflict?: boolean }) {
  return (
    <ul className={`ar-files${conflict ? " ar-conflicts" : ""}`}>
      {files.map((f) => (
        <li key={f}>
          <span className="mono">{f}</span>
          {conflict ? <> <span className="ar-conflict">{tr("modified since, not restored")}</span></> : null}
        </li>
      ))}
    </ul>
  );
}

export function AutoReviewBlock({
  a,
  client,
  readOnly,
  onRevoked,
}: {
  a: Approval;
  client: Pick<NokkerClient, "revokeAutoReview" | "rollbackAutoReview">;
  /** No action (no session). */
  readOnly?: boolean;
  /** The card as the core returns it after revocation (a revoked refusal is pending again). */
  onRevoked: (next: Approval) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offer, setOffer] = useState<AutoReviewRollbackOffer | null>(null);
  const [done, setDone] = useState<AppliedView | null>(null);
  const [already, setAlready] = useState(false);
  const ar = a.auto_review;
  if (!ar) return null;
  const revoked = Boolean(ar.revoked_by);
  const shown = offer ?? a.rollback ?? null;
  // Applied here (fresh result), or earlier (GET after a reload, or a 409 on « Restore files »).
  const earlier = appliedOf(shown);
  const result = done ?? earlier;
  const alreadyDone = !done && (earlier !== null || already);

  const revoke = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const next = await client.revokeAutoReview(a.id);
      if (next.rollback) setOffer(next.rollback);
      onRevoked(next);
    } catch (e) {
      setErr(e instanceof NokkerApiError && e.status === 409 ? tr("This automatic decision was already revoked.") : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await client.rollbackAutoReview(a.id);
      setDone({ restored: r.restored, conflicts: r.conflicts });
    } catch (e) {
      if (e instanceof NokkerApiError && e.status === 409) setAlready(true);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const error = err ? (
    <span className="error" role="alert">
      {err}
    </span>
  ) : null;

  if (isAutoDecided(a)) {
    const ok = ar.decision === "approve";
    return (
      <div className="ar-compact" data-auto-review={ar.decision}>
        <p className="ar-head">
          <span className={`chip ${ok ? "ok" : "ko"}`}>{ok ? tr("Approved automatically") : tr("Refused automatically")}</span>
        </p>
        {ar.reason ? <p className="fine ar-reason">{ar.reason}</p> : null}
        {readOnly ? null : (
          <div className="bubble-actions">
            <button type="button" className="btn btn-sm" data-ar="revoke" disabled={busy} onClick={() => void revoke()}>
              {tr("Revoke")}
            </button>
          </div>
        )}
        {error}
      </div>
    );
  }

  let head: string;
  if (ar.decision === "escalate") head = tr("The automatic review left this card to you.");
  else if (revoked) head = ar.decision === "approve" ? tr("Automatic approval revoked: the action had already run.") : tr("Automatic refusal revoked: the card is yours to decide.");
  else head = ar.decision === "approve" ? tr("Approved by the automatic review.") : tr("Refused by the automatic review.");

  return (
    <div className="ar-block" data-auto-review={ar.decision}>
      <p className="ar-head">
        <span className="chip">{tr("automatic review")}</span> {head}
      </p>
      {ar.reason ? <p className="fine ar-reason">{ar.reason}</p> : null}
      {revoked && ar.decision === "approve" && shown && !result && !already ? (
        shown.available ? (
          <div className="ar-rollback">
            <p className="fine">{tr("Files changed by this action:")}</p>
            <FileList files={shown.files ?? []} />
            {readOnly ? null : (
              <div className="bubble-actions">
                <button type="button" className="btn btn-brass" data-ar="restore" disabled={busy} onClick={() => void restore()}>
                  {tr("Restore files")}
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="fine ar-none">{rollbackReasonText(shown.reason)}</p>
        )
      ) : null}
      {alreadyDone ? (
        <p className="fine ar-none" data-ar="already" role="status">
          {tr("Already restored.")}
        </p>
      ) : null}
      {result ? (
        <div className="ar-rollback" data-ar="restored" role="status">
          {result.restored.length ? (
            <>
              <p className="fine">{tr("Files restored:")}</p>
              <FileList files={result.restored} />
            </>
          ) : null}
          {result.conflicts.length ? <FileList files={result.conflicts} conflict /> : null}
          {!result.restored.length && !result.conflicts.length && !alreadyDone ? <p className="fine">{tr("Nothing to restore.")}</p> : null}
        </div>
      ) : null}
      {error}
    </div>
  );
}
