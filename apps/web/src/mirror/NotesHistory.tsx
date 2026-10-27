/** Projet d'équipe en miroir, pour les mainteneurs (LOKKAL §7.15, §7.23) : les versions remplacées par une écriture
 * reçue plus tard, ou oubliées par un membre. Rien n'est effacé : « Remettre cette version » la rend courante et
 * envoie la version actuelle dans cet historique (les machines la tirent au passage suivant). */
import React, { useState } from "react";
import { NokkerApiError, type NokkerClient, type QuarantinedNote } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import { fmtWhen, teamError } from "../team/model.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

function restoreError(e: unknown): string {
  const code = e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined;
  return code === "already_current" ? tr("This version is already the current one.") : teamError(e);
}

export function NotesHistory({ client, projectId, toast }: { client: NokkerClient; projectId: string; toast?: Toast }): React.ReactElement {
  const [items, setItems] = useState<QuarantinedNote[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (): void => {
    client.listProjectQuarantine(projectId).then(
      (r) => setItems(r.quarantine),
      (er: unknown) => setErr(teamError(er)),
    );
  };
  const restore = async (q: QuarantinedNote): Promise<void> => {
    setBusy(true);
    setConfirm(null);
    try {
      await client.restoreQuarantinedNote(projectId, q.id);
      toast?.(tr("“{0}” restored; the previous version is in the history.", q.title || q.name), "ok");
      load();
    } catch (e) {
      toast?.(restoreError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="team-notes-history"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !items) load();
      }}
    >
      <summary>{tr("History of replaced or forgotten versions")}</summary>
      {err ? <p className="error">{err}</p> : null}
      {items === null && !err ? <p className="fine">{tr("Loading…")}</p> : null}
      {items?.length === 0 ? <p className="fine">{tr("No replaced version yet.")}</p> : null}
      {items?.length ? (
        <ul className="team-notes">
          {[...items].reverse().map((q) => (
            <li key={String(q.id)}>
              <span className="chip">{q.kind}</span> <strong>{q.title || q.name}</strong>
              <p className="fine">
                {q.reason} · {tr("written by {0}", q.author_account)}
                {q.author_machine ? ` (${q.author_machine})` : ""}
                {q.quarantined_at ? tr(" · set aside on {0}", fmtWhen(q.quarantined_at)) : ""}
              </p>
              {q.restored_at ? (
                <p className="fine">
                  {tr("Restored on {0}", fmtWhen(q.restored_at))}
                  {q.restored_by ? tr(" by {0}", q.restored_by) : ""}.
                </p>
              ) : null}
              {q.text ? <p>{q.text}</p> : null}
              {confirm === String(q.id) ? (
                <span className="team-row-actions">
                  <span className="fine">{tr("The current version of this note will move to the history.")}</span>
                  <button type="button" className="btn btn-sm btn-brass" disabled={busy} onClick={() => void restore(q)}>
                    {tr("Yes, restore")}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                    {tr("Cancel")}
                  </button>
                </span>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirm(String(q.id))}>
                  {tr("Restore this version")}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
