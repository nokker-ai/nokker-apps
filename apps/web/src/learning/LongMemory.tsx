/**
 * Écran « Mémoire » (nuage) : les notes longues de la personne — liste, ajout, suppression avec confirmation. Geste de la
 * PERSONNE (provenance « person »). Le portage « foyer » n'est pas proposé ici : une note écrite d'ici est toujours
 * personnelle ; un membre qui écrit passe par la relecture du foyer (202). Contrat : /v1/memory/long.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { LongKind, LongNote, NokkerClient } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import type { Lang } from "../onboarding/i18n.js";
import "./long-memory.css";
import { errorCode, learningError, when } from "./model.js";

const TITLE_MAX = 120;
const TEXT_MAX = 1500;

function kindLabel(k: LongKind): string {
  return k === "rule" ? tr("Rule") : k === "feedback" || k === "preference" ? tr("Preference") : tr("Fact");
}

function noteError(e: unknown): string {
  return errorCode(e) === "bad_note" ? tr("This note is too long or empty (title 120, text 1500 characters).") : learningError(e);
}

export function LongMemoryPane({ client, lang }: { client: NokkerClient; lang: Lang }): React.ReactElement {
  const [notes, setNotes] = useState<LongNote[] | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<LongKind>("fact");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(() => {
    client.getLongMemory().then(
      (r) => setNotes(r.notes),
      (e) => setErr(noteError(e)),
    );
  }, [client]);
  useEffect(load, [load]);

  const add = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const r = await client.writeLongNote({ scope: "user", kind, title: title.trim(), text: text.trim() });
      if ("pending" in r) setInfo(tr("Saved: sent to your household for review."));
      else if (r.duplicate) setInfo(tr("Already noted."));
      else setInfo(tr("Noted"));
      if (!("pending" in r)) {
        setTitle("");
        setText("");
      }
    } catch (e) {
      setErr(noteError(e));
    } finally {
      setBusy(false);
      load();
    }
  };

  const remove = async (name: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      await client.deleteLongNote(name);
    } catch (e) {
      setErr(noteError(e));
    } finally {
      setConfirm(null);
      setBusy(false);
      load();
    }
  };

  return (
    <div className="lrn-pane">
      <p className="fine">{tr("What Nina remembers about you. You decide what stays.")}</p>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {info ? (
        <p className="ob-note lrn-noted" role="status">
          {info}
        </p>
      ) : null}
      {notes === null && !err ? <p className="fine">{tr("Loading…")}</p> : null}
      {notes && notes.length === 0 ? <p className="fine lrn-empty">{tr("Nothing remembered yet.")}</p> : null}
      {notes && notes.length ? (
        <ul className="lrn-cards">
          {notes.map((n) => (
            <li key={n.name} className="lrn-card" data-note={n.name}>
              <div className="lrn-card-head">
                <strong>{n.title}</strong>
                <span className={`lrn-badge ${n.scope}`}>{kindLabel(n.kind)}</span>
              </div>
              <p className="lrn-text">{n.text}</p>
              <span className="lrn-origin fine">
                {when(n.updated_at, lang)}
                {n.mine ? ` · ${tr("written by you")}` : ""}
              </span>
              <div className="lrn-actions">
                {confirm === n.name ? (
                  <>
                    <span className="fine">{tr("Delete this note?")}</span>
                    <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void remove(n.name)}>
                      {tr("Yes, delete")}
                    </button>
                    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>
                      {tr("Cancel")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(n.name)}>
                    {tr("Delete")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="lrn-form" onSubmit={(e) => void add(e)}>
        <h3>{tr("Add a note")}</h3>
        <label>
          {tr("Title")}
          <input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          {tr("Note")}
          <textarea value={text} maxLength={TEXT_MAX} rows={3} onChange={(e) => setText(e.target.value)} required />
        </label>
        <label>
          {tr("Type")}
          <select value={kind} onChange={(e) => setKind(e.target.value as LongKind)}>
            <option value="fact">{tr("Fact")}</option>
            <option value="feedback">{tr("Preference")}</option>
            <option value="rule">{tr("Rule")}</option>
          </select>
        </label>
        <button type="submit" className="btn btn-brass" disabled={busy || !title.trim() || !text.trim()}>
          {tr("Save")}
        </button>
      </form>
    </div>
  );
}
