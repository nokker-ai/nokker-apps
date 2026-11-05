/**
 * Vue « Apprentissage » (lots 16, 18, 19, 25) : ce qui attend ta décision (notes de mémoire proposées par Nina, règles
 * d'approbation suggérées), « Ce que Nokker a appris » (journal, aussi à l'adresse /journey) et les skills appris
 * (versions, différences, revenir à une version, désactiver). Contrats : noyau docs/LEARNING.md, APPROVALS.md §7.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { ApprovalSuggestions, ImportedMemoryEntry, JournalEntry, LearnedSkill, LearnedSkillDetail, NokkerClient, PendingNote } from "@nokker-apps/sdk";
import { tr } from "../i18n/index.js";
import type { Lang } from "../onboarding/i18n.js";
import { diffRows, journalLine, learningError, when } from "./model.js";
import { Consolidations } from "./Consolidations.js";
import { capability } from "../capabilities.js";

export type LearningSection = "pending" | "journal" | "skills" | "consolidations";

export function LearningView({
  client,
  lang,
  initial = "pending",
  onOpenThread,
  onChanged,
}: {
  client: NokkerClient;
  lang: Lang;
  initial?: LearningSection;
  /** Ouvre le fil d'origine (provenance) ; absent : pas de lien. */
  onOpenThread?: (threadId: string) => void;
  /** Une décision a changé ce qui attend : la pastille du menu se recalcule. */
  onChanged?: () => void;
}): React.ReactElement {
  const [section, setSection] = useState<LearningSection>(initial);
  // Consolidations: a tab only when the core serves them (flag memory_consolidation; off → 404).
  const [cx, setCx] = useState(false);
  useEffect(() => {
    const known = capability("consolidation");
    if (known !== null) return setCx(known);
    let live = true;
    client.listConsolidationRuns(1).then(
      () => live && setCx(true),
      () => live && setCx(false),
    );
    return () => {
      live = false;
    };
  }, [client]);
  const tabs: [LearningSection, string][] = [
    ["pending", tr("To approve")],
    ["journal", tr("What Nokker learned")],
    ["skills", tr("Learned skills")],
    ...(cx ? ([["consolidations", tr("Consolidations")]] as [LearningSection, string][]) : []),
  ];
  return (
    <section className="lrn" aria-label={tr("Learning")}>
      <div className="lrn-tabs" role="tablist" aria-label={tr("Learning")}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={section === id} className={`lrn-tab ${section === id ? "on" : ""}`} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </div>
      {section === "pending" ? <Pending client={client} lang={lang} onOpenThread={onOpenThread} onChanged={onChanged} /> : null}
      {section === "journal" ? <Journal client={client} lang={lang} onOpenThread={onOpenThread} /> : null}
      {section === "skills" ? <Skills client={client} lang={lang} onOpenThread={onOpenThread} /> : null}
      {section === "consolidations" && cx ? <Consolidations client={client} lang={lang} /> : null}
    </section>
  );
}

function Origin({ threadId, at, lang, onOpenThread }: { threadId?: string | null; at: string; lang: Lang; onOpenThread?: (t: string) => void }): React.ReactElement {
  return (
    <span className="lrn-origin fine">
      {when(at, lang)}
      {threadId && onOpenThread ? (
        <>
          {" · "}
          <button type="button" className="lrn-link" onClick={() => onOpenThread(threadId)}>
            {tr("open the conversation")}
          </button>
        </>
      ) : null}
    </span>
  );
}

// ── À valider : notes de mémoire proposées et règles suggérées ──

function Pending({ client, lang, onOpenThread, onChanged }: { client: NokkerClient; lang: Lang; onOpenThread?: (t: string) => void; onChanged?: () => void }): React.ReactElement {
  const [notes, setNotes] = useState<PendingNote[] | null | "off">(null);
  const [sugg, setSugg] = useState<ApprovalSuggestions | null | "off">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    client.listPendingMemory().then((r) => setNotes(r.notes), () => setNotes("off"));
    client.listApprovalSuggestions().then(setSugg, () => setSugg("off"));
  }, [client]);
  useEffect(load, [load]);

  const act = async (key: string, p: Promise<unknown>): Promise<void> => {
    setBusy(key);
    setErr(null);
    try {
      await p;
    } catch (e) {
      setErr(learningError(e));
    } finally {
      setBusy(null);
      load();
      onChanged?.();
    }
  };

  const noteList = Array.isArray(notes) ? notes : [];
  const suggList = sugg && sugg !== "off" ? sugg.suggestions : [];
  const loading = notes === null || sugg === null;
  return (
    <div className="lrn-pane">
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {loading ? <p className="fine">{tr("Loading…")}</p> : null}
      {!loading && noteList.length === 0 && suggList.length === 0 ? <p className="fine lrn-empty">{tr("Nothing waiting for you.")}</p> : null}
      {noteList.length ? (
        <>
          <h3>{tr("Notes Nina wants to remember")}</h3>
          <ul className="lrn-cards">
            {noteList.map((n) => (
              <li key={n.id} className="lrn-card">
                <div className="lrn-card-head">
                  <strong>{n.title}</strong>
                  <span className={`lrn-badge ${n.scope}`}>{n.scope === "user" ? tr("everywhere") : tr("this project")}</span>
                </div>
                <p className="lrn-text">{n.text}</p>
                <Origin threadId={n.thread_id} at={n.at} lang={lang} onOpenThread={onOpenThread} />
                <div className="lrn-actions">
                  <button type="button" className="btn btn-brass" disabled={busy !== null} onClick={() => void act(n.id, client.decidePendingMemory(n.id, "approve"))}>
                    {tr("Remember")}
                  </button>
                  <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void act(n.id, client.decidePendingMemory(n.id, "reject"))}>
                    {tr("Don't keep")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {suggList.length && sugg && sugg !== "off" ? (
        <>
          <h3>{tr("Rules you could make permanent")}</h3>
          <p className="fine">{tr("You approved these actions {0} times or more in {1} days. Accept to stop being asked.", sugg.threshold, sugg.window_days)}</p>
          {sugg.rule_store === null ? (
            // Outside Lokkal no rule can be written here: say so once, BEFORE the cards, instead of a dead button on each.
            <p className="ob-note lrn-where" role="note">
              {tr("Rules are stored on your Lokkal machine: accept this suggestion there.")}
            </p>
          ) : null}
          <ul className="lrn-cards">
            {suggList.map((s) => (
              <li key={s.id} className="lrn-card">
                <code className="lrn-rule">{s.rule}</code>
                <p className="fine">{tr("Approved {0} times, refused {1} times.", s.approved, s.rejected)}</p>
                <div className="lrn-actions">
                  {sugg.rule_store !== null ? (
                    <button type="button" className="btn btn-brass" disabled={busy !== null} onClick={() => void act(s.id, client.decideApprovalSuggestion(s.id, "accept"))}>
                      {tr("Accept the rule")}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void act(s.id, client.decideApprovalSuggestion(s.id, "dismiss"))}>
                    {tr("Dismiss")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ImportedMemory client={client} lang={lang} onChanged={onChanged} />
    </div>
  );
}

// ── Ce que Nokker a appris (journal, /journey) ──

const PAGE = 50;

function Journal({ client, lang, onOpenThread }: { client: NokkerClient; lang: Lang; onOpenThread?: (t: string) => void }): React.ReactElement {
  const [limit, setLimit] = useState(PAGE);
  const [entries, setEntries] = useState<JournalEntry[] | null | "off">(null);
  useEffect(() => {
    client.getLearningJournal(limit).then((r) => setEntries(r.entries), () => setEntries("off"));
  }, [client, limit]);
  if (entries === null) return <p className="fine">{tr("Loading…")}</p>;
  if (entries === "off") return <p className="fine lrn-empty">{tr("The learning journal is not available here.")}</p>;
  if (!entries.length) return <p className="fine lrn-empty">{tr("Nokker has not learned anything yet.")}</p>;
  return (
    <div className="lrn-pane">
      <ol className="lrn-journal">
        {entries.map((e) => {
          const l = journalLine(e);
          return (
            <li key={e.id} className={`lrn-entry k-${e.kind.replace(".", "-")}`}>
              <span className="lrn-dot" aria-hidden="true" />
              <div>
                <div>
                  <strong>{l.what}</strong> · <span className={e.kind.startsWith("skill.") ? "lrn-subject" : ""}>{l.subject}</span>
                </div>
                <span className="fine">{l.origin}</span> <Origin threadId={e.thread_id} at={e.at} lang={lang} onOpenThread={onOpenThread} />
              </div>
            </li>
          );
        })}
      </ol>
      {entries.length >= limit && limit < 1000 ? (
        <button type="button" className="btn btn-ghost" onClick={() => setLimit((n) => Math.min(1000, n + PAGE))}>
          {tr("Show older")}
        </button>
      ) : null}
    </div>
  );
}

// ── Skills appris : versions, différences, revenir, désactiver ──

function Skills({ client, lang, onOpenThread }: { client: NokkerClient; lang: Lang; onOpenThread?: (t: string) => void }): React.ReactElement {
  const [skills, setSkills] = useState<LearnedSkill[] | null | "off">(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    client.listLearnedSkills().then((r) => setSkills(r.skills), () => setSkills("off"));
  }, [client]);
  useEffect(load, [load]);
  if (skills === null) return <p className="fine">{tr("Loading…")}</p>;
  if (skills === "off") return <p className="fine lrn-empty">{tr("Learned skills are not available here.")}</p>;
  if (!skills.length) return <p className="fine lrn-empty">{tr("No learned skill yet.")}</p>;
  return (
    <div className="lrn-pane">
      <ul className="lrn-skills">
        {skills.map((s) => (
          <li key={s.name} className={`lrn-skill ${s.active ? "" : "off"}`}>
            <button type="button" className="lrn-skill-row" aria-expanded={open === s.name} onClick={() => setOpen(open === s.name ? null : s.name)}>
              <strong>{s.name}</strong>
              <span className="fine">
                v{s.version} · {s.active ? tr("in use") : tr("disabled")} · {when(s.at, lang)}
              </span>
            </button>
            {open === s.name ? <SkillDetail client={client} name={s.name} lang={lang} onOpenThread={onOpenThread} onChanged={load} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkillDetail({ client, name, lang, onOpenThread, onChanged }: { client: NokkerClient; name: string; lang: Lang; onOpenThread?: (t: string) => void; onChanged: () => void }): React.ReactElement {
  const [d, setD] = useState<LearnedSkillDetail | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Version that was in use before « Disable »: the undo brings it back. */
  const [undoTo, setUndoTo] = useState<number | null>(null);
  const load = useCallback(
    async (version?: number) => {
      try {
        const base = await client.getLearnedSkill(name);
        const v = version ?? base.current;
        const prev = [...base.versions].reverse().find((x) => x.version < v && x.op !== "disable")?.version;
        setD(await client.getLearnedSkill(name, prev ? { version: v, diffFrom: prev } : { version: v }));
        setShown(v);
      } catch (e) {
        setErr(learningError(e));
      }
    },
    [client, name],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const revert = async (version: number): Promise<boolean> => {
    setBusy(true);
    setErr(null);
    try {
      await client.revertLearnedSkill(name, version);
      onChanged();
      await load();
      return true;
    } catch (e) {
      setErr(learningError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!d) return <p className="fine">{err ?? tr("Loading…")}</p>;
  const rows = d.diff ? diffRows(d.diff) : [];
  return (
    <div className="lrn-detail">
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      <ol className="lrn-versions" aria-label={tr("Versions")}>
        {[...d.versions].reverse().map((v) => (
          <li key={v.version} className={v.version === shown ? "on" : ""}>
            <button type="button" className="lrn-link" onClick={() => void load(v.version)} disabled={v.op === "disable"}>
              v{v.version}
            </button>{" "}
            <span className="fine">
              {v.op === "create" ? tr("created") : v.op === "update" ? tr("updated") : v.op === "revert" ? tr("back to v{0}", v.reverted_to ?? "?") : tr("disabled")} · {v.actor === "owner" ? tr("by you") : tr("by Nina, card approved")}
            </span>{" "}
            <Origin threadId={v.thread_id} at={v.at} lang={lang} onOpenThread={onOpenThread} />
          </li>
        ))}
      </ol>
      {rows.length ? (
        <pre className="lrn-diff" aria-label={tr("Changes from the previous version")}>
          {rows.map((r, i) => (
            <span key={i} className={`d-${r.type}`}>
              {r.type === "add" ? "+ " : r.type === "del" ? "− " : r.type === "ctx" ? "  " : ""}
              {r.text}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : d.version?.content ? (
        <pre className="lrn-diff">{d.version.content}</pre>
      ) : null}
      <div className="lrn-actions">
        {shown !== null && shown !== d.current ? (
          <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void revert(shown)}>
            {tr("Go back to v{0}", shown)}
          </button>
        ) : null}
        {d.active ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              const was = d.current;
              void revert(0).then((ok) => ok && setUndoTo(was));
            }}
          >
            {tr("Disable")}
          </button>
        ) : undoTo !== null ? (
          <>
            <span className="fine" role="status">
              {tr("Skill disabled.")}
            </span>
            <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void revert(undoTo).then((ok) => ok && setUndoTo(null))}>
              {tr("Undo")}
            </button>
          </>
        ) : (
          <span className="fine">{tr("Disabled: pick a version above to bring it back.")}</span>
        )}
      </div>
    </div>
  );
}

// ── Mémoire importée d'un autre agent (Codex), gardée comme données (noyau lot 30 d) ──

/** Date d'origine (AAAA-MM-JJ) lisible, sans heure. */
function originDay(date: string, lang: Lang): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(lang === "fr" ? "fr-CH" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Entrées de la mémoire générée par Codex, importées comme DONNÉES : jamais des consignes, défaisables. « Retenir en
 * note personnelle » est le seul chemin vers la mémoire de Nokker. Absente hors de Lokkal ou drapeau éteint (401/404). */
function ImportedMemory({ client, lang, onChanged }: { client: NokkerClient; lang: Lang; onChanged?: () => void }): React.ReactElement | null {
  const [entries, setEntries] = useState<ImportedMemoryEntry[] | null | "off">(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    client.listImportedMemory().then((r) => setEntries(r.entries), () => setEntries("off"));
  }, [client]);
  useEffect(load, [load]);
  if (entries === null || entries === "off" || entries.length === 0) return null;
  const act = async (p: Promise<unknown>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await p;
    } catch (e) {
      setErr(learningError(e));
    } finally {
      setBusy(false);
      setConfirmAll(false);
      load();
      onChanged?.();
    }
  };
  return (
    <section className="lrn-imported" aria-labelledby="lrn-imported-title">
      <h3 id="lrn-imported-title">{tr("Imported from Codex")}</h3>
      <p className="fine">{tr("Memory written by Codex from your past conversations. Nokker treats it as information to check, never as instructions.")}</p>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      <ul className="lrn-cards">
        {entries.map((e) => (
          <li key={e.name} className="lrn-card">
            <p className="lrn-text">{e.text}</p>
            <span className="lrn-origin fine">{tr("Codex, {0}", originDay(e.date, lang))}</span>
            <div className="lrn-actions">
              <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void act(client.promoteImportedMemory(e.name))}>
                {tr("Keep as a personal note")}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(client.undoImportedMemory(e.name))}>
                {tr("Remove")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="lrn-actions">
        {confirmAll ? (
          <>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act(client.undoImportedMemory())}>
              {tr("Remove all {0} entries", entries.length)}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmAll(false)}>
              {tr("Cancel")}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmAll(true)}>
            {tr("Undo the whole Codex memory import")}
          </button>
        )}
      </div>
    </section>
  );
}
