/** Projet d'équipe en miroir, pour les mainteneurs (LOKKAL §7.15, §7.23) : les versions remplacées par une écriture
 * reçue plus tard, ou oubliées par un membre. Rien n'est effacé : « Remettre cette version » la rend courante et
 * envoie la version actuelle dans cet historique (les machines la tirent au passage suivant). */
import React, { useState } from "react";
import { NokkerApiError, type NokkerClient, type QuarantinedNote } from "@nokker-apps/sdk";
import { fmtWhen, teamError } from "../team/model.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

function restoreError(e: unknown): string {
  const code = e instanceof NokkerApiError ? (e.body as { error?: { code?: string } } | undefined)?.error?.code : undefined;
  return code === "already_current" ? "Cette version est déjà la version courante." : teamError(e);
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
      toast?.(`« ${q.title || q.name} » remise en place ; la version d'avant est dans l'historique.`, "ok");
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
      <summary>Historique des versions remplacées ou oubliées</summary>
      {err ? <p className="error">{err}</p> : null}
      {items === null && !err ? <p className="fine">Chargement…</p> : null}
      {items?.length === 0 ? <p className="fine">Aucune version remplacée pour l'instant.</p> : null}
      {items?.length ? (
        <ul className="team-notes">
          {[...items].reverse().map((q) => (
            <li key={String(q.id)}>
              <span className="chip">{q.kind}</span> <strong>{q.title || q.name}</strong>
              <p className="fine">
                {q.reason} · écrite par {q.author_account}
                {q.author_machine ? ` (${q.author_machine})` : ""}
                {q.quarantined_at ? ` · mise de côté le ${fmtWhen(q.quarantined_at)}` : ""}
              </p>
              {q.restored_at ? (
                <p className="fine">
                  Remise en place le {fmtWhen(q.restored_at)}
                  {q.restored_by ? ` par ${q.restored_by}` : ""}.
                </p>
              ) : null}
              {q.text ? <p>{q.text}</p> : null}
              {confirm === String(q.id) ? (
                <span className="team-row-actions">
                  <span className="fine">La version actuelle de cette note passera dans l'historique.</span>
                  <button type="button" className="btn btn-sm btn-brass" disabled={busy} onClick={() => void restore(q)}>
                    Oui, remettre
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
                    Annuler
                  </button>
                </span>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirm(String(q.id))}>
                  Remettre cette version
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
