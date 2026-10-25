/**
 * Onglet Code (LOKKAL §7.28) : les sessions de code du compte sur le serveur de l'organisation. Ouvrir (dépôt, mode
 * parmi ceux que le noyau permet, plafond affiché), reprendre (le fil de la session : le prochain message rouvre le bac
 * à sable), points de retour hors tour (liste, changements, retour — la porte de la session décide : carte forte,
 * exécuté, ou refusé), fermer ou effacer, identifiants de forge par NOM. Les hooks du dépôt ne sont pas de ce lot.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { Approval, CheckpointDiff, CheckpointInfo, CodeCredential, CodeSession, CodeSessionList, NokkerClient, NokkerEvent } from "@nokker-apps/sdk";
import { parseToolJson } from "@nokker-apps/sdk";
import { c, codeError, fmtWhen, isFull, modeLabel, openBody, parsePoints, repoName, restoreOutcome, sortSessions, type Lang } from "./model.js";
import { SessionSkills, SessionSubagents, eventSession } from "./SessionExtras.js";
import "./code.css";

type Toast = (text: string, tone?: "ok" | "error") => void;
type Decide = (approval: Approval, decision: "approve" | "reject") => Promise<void>;
type OnCodeEvent = (fn: (e: NokkerEvent) => void) => () => void;

export function CodeTab({
  client,
  lang,
  toast,
  decide,
  onOpenThread,
  onCodeEvent,
}: {
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  decide: Decide;
  onOpenThread: (threadId: string) => void;
  onCodeEvent: OnCodeEvent;
}): React.ReactElement {
  const [list, setList] = useState<CodeSessionList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creds, setCreds] = useState<CodeCredential[] | null>(null);
  const fail = useCallback((e: unknown) => toast(codeError(lang, e), "error"), [lang, toast]);

  const load = useCallback(async () => {
    try {
      setList(await client.listCodeSessions());
      setErr(null);
    } catch (e) {
      setErr(codeError(lang, e));
    }
  }, [client, lang]);
  const loadCreds = useCallback(async () => {
    try {
      setCreds((await client.listCodeCredentials()).credentials);
    } catch {
      setCreds(null); // coffre absent ou indisponible : pas de choix d'identifiant
    }
  }, [client]);
  useEffect(() => {
    void load();
    void loadCreds();
  }, [load, loadCreds]);
  // Arbre des skills réécrit (`skill.untrusted`), sous-agent parti ou fini (`subagent.started|finished`), au propriétaire
  // seul : la liste se relit (bandeau, compteur `live`).
  useEffect(
    () => onCodeEvent((e) => (e.type === "skill.untrusted" || e.type === "subagent.started" || e.type === "subagent.finished") && eventSession(e) && void load()),
    [onCodeEvent, load],
  );

  return (
    <section className="code-tab" aria-labelledby="code-title">
      <h2 id="code-title">{c(lang, "title")}</h2>
      <p className="fine">{c(lang, "lead")}</p>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {!list && !err ? <p className="fine">{c(lang, "loading")}</p> : null}
      {list ? (
        <>
          <p className="fine code-count">
            {c(lang, "count", { n: list.sessions.length, limit: list.limit })} · {c(lang, "idleRule", { min: Math.max(1, Math.round(list.idle_ttl_s / 60)) })}
          </p>
          <OpenForm client={client} lang={lang} list={list} creds={creds} toast={toast} onOpened={load} />
          {list.sessions.length ? (
            <ul className="code-list">
              {sortSessions(list.sessions).map((s) => (
                <SessionCard key={s.id} s={s} client={client} lang={lang} toast={toast} fail={fail} decide={decide} onOpenThread={onOpenThread} onCodeEvent={onCodeEvent} reload={load} />
              ))}
            </ul>
          ) : (
            <p className="fine">{c(lang, "none")}</p>
          )}
          <Credentials client={client} lang={lang} creds={creds} toast={toast} fail={fail} reload={loadCreds} />
        </>
      ) : null}
    </section>
  );
}

function OpenForm({
  client,
  lang,
  list,
  creds,
  toast,
  onOpened,
}: {
  client: NokkerClient;
  lang: Lang;
  list: CodeSessionList;
  creds: CodeCredential[] | null;
  toast: Toast;
  onOpened: () => Promise<void>;
}): React.ReactElement {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [credential, setCredential] = useState("");
  const [mode, setMode] = useState(list.default_mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = isFull(list);
  // Le mode par défaut du noyau, sauf si l'utilisateur en a choisi un autre encore permis.
  useEffect(() => setMode((m) => (list.modes.includes(m) ? m : list.default_mode)), [list.modes, list.default_mode]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createCodeSession(openBody({ url, ref, credential, mode }));
      setUrl("");
      setRef("");
      setCredential("");
      toast(c(lang, "opened"), "ok");
      await onOpened();
    } catch (e2) {
      setError(codeError(lang, e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="code-card code-open" onSubmit={(e) => void submit(e)} aria-labelledby="code-open-title">
      <h3 id="code-open-title">{c(lang, "open")}</h3>
      <label htmlFor="code-url">{c(lang, "repoUrl")}</label>
      <input id="code-url" type="url" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder={c(lang, "repoPh")} value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby="code-url-tip" />
      <p id="code-url-tip" className="fine">
        {c(lang, "repoTip")}
      </p>
      {url.trim() ? (
        <div className="code-fields">
          <span>
            <label htmlFor="code-ref">{c(lang, "ref")}</label>
            <input id="code-ref" autoCapitalize="none" spellCheck={false} placeholder={c(lang, "refPh")} value={ref} onChange={(e) => setRef(e.target.value)} />
          </span>
          {creds ? (
            <span>
              <label htmlFor="code-cred">{c(lang, "credential")}</label>
              <select id="code-cred" value={credential} onChange={(e) => setCredential(e.target.value)}>
                <option value="">{c(lang, "credentialNone")}</option>
                {creds.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name}
                  </option>
                ))}
              </select>
            </span>
          ) : null}
        </div>
      ) : null}
      <label htmlFor="code-mode">{c(lang, "mode")}</label>
      <select id="code-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
        {list.modes.map((m) => (
          <option key={m} value={m}>
            {modeLabel(lang, m)}
          </option>
        ))}
      </select>
      <span className="code-actions">
        <button type="submit" className="btn btn-brass" disabled={busy || full}>
          {c(lang, "openBtn")}
        </button>
        {busy ? (
          <span className="fine" role="status">
            {c(lang, "opening")}
          </span>
        ) : null}
      </span>
      {full ? <p className="fine code-warn">{c(lang, "full")}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function SessionCard({
  s,
  client,
  lang,
  toast,
  fail,
  decide,
  onOpenThread,
  onCodeEvent,
  reload,
}: {
  s: CodeSession;
  client: NokkerClient;
  lang: Lang;
  toast: Toast;
  fail: (e: unknown) => void;
  decide: Decide;
  onOpenThread: (threadId: string) => void;
  onCodeEvent: OnCodeEvent;
  reload: () => Promise<void>;
}): React.ReactElement {
  const [points, setPoints] = useState(false);
  const [skills, setSkills] = useState(false);
  const [subs, setSubs] = useState(false);
  const untrusted = s.skills?.enabled && s.skills.project === "untrusted";
  const [confirm, setConfirm] = useState<"close" | "erase" | null>(null);
  const [busy, setBusy] = useState(false);

  const end = async (purge: boolean): Promise<void> => {
    setBusy(true);
    try {
      await client.closeCodeSession(s.id, purge);
      toast(c(lang, purge ? "erased" : "closed"), "ok");
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <li className={`code-card code-session ${s.status}`}>
      <div className="code-head">
        <strong className="code-repo">{s.repo ? repoName(s.repo.url) : c(lang, "noRepo")}</strong>
        {s.repo?.ref ? <code>{s.repo.ref}</code> : null}
        <span className={`chip code-status ${s.status === "active" ? "ok" : ""}`}>{c(lang, s.status === "idle" ? "idle" : "active")}</span>
        {untrusted ? <span className="chip code-chip-warn">{c(lang, "skillsChip", { n: s.skills!.count })}</span> : null}
        {s.subagents?.live ? <span className="chip ok">{c(lang, "subChip", { live: s.subagents.live })}</span> : null}
      </div>
      <p className="fine code-meta">
        {modeLabel(lang, s.mode)} · {c(lang, "created", { at: fmtWhen(lang, s.created_at) })} · {c(lang, "lastUsed", { at: fmtWhen(lang, s.last_used_at) })}
        {s.repo?.credential ? (
          <>
            {" · "}
            <code>{s.repo.credential}</code>
          </>
        ) : null}
      </p>
      {s.status === "idle" ? <p className="fine">{c(lang, "idleHint")}</p> : null}
      {untrusted ? <SessionSkills s={s} client={client} lang={lang} toast={toast} onChanged={reload} /> : null}
      {confirm ? (
        <div className="code-confirm" role="group" aria-label={c(lang, confirm)}>
          <p>{c(lang, confirm === "erase" ? "eraseConfirm" : "closeConfirm")}</p>
          <span className="code-actions">
            <button type="button" className={`btn ${confirm === "erase" ? "btn-danger" : ""}`} disabled={busy} onClick={() => void end(confirm === "erase")}>
              {c(lang, "yes")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>
              {c(lang, "cancel")}
            </button>
          </span>
        </div>
      ) : (
        <span className="code-actions">
          <button type="button" className="btn btn-brass" title={c(lang, "resumeHint")} onClick={() => onOpenThread(s.thread_id)}>
            {c(lang, "resume")}
          </button>
          <button type="button" className="btn" aria-expanded={points} onClick={() => setPoints(!points)}>
            {c(lang, points ? "hidePoints" : "points")}
          </button>
          {s.skills?.enabled && !untrusted ? (
            <button type="button" className="btn" aria-expanded={skills} onClick={() => setSkills(!skills)}>
              {c(lang, "skills")}
            </button>
          ) : null}
          {s.subagents ? (
            <button type="button" className="btn" aria-expanded={subs} onClick={() => setSubs(!subs)}>
              {c(lang, "sub")}
              {s.subagents.live ? ` (${s.subagents.live})` : ""}
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm("close")}>
            {c(lang, "close")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm("erase")}>
            {c(lang, "erase")}
          </button>
        </span>
      )}
      {points ? <Points s={s} client={client} lang={lang} toast={toast} decide={decide} onTouched={reload} /> : null}
      {skills && !untrusted ? (
        <div className="code-points">
          <SessionSkills s={s} client={client} lang={lang} toast={toast} onChanged={reload} />
        </div>
      ) : null}
      {subs ? (
        <div className="code-points">
          <SessionSubagents s={s} client={client} lang={lang} toast={toast} onCodeEvent={onCodeEvent} onChanged={reload} />
        </div>
      ) : null}
    </li>
  );
}

/** Points de retour d'une session, par `tools/call` (hors tour, mêmes portes que la boucle). */
function Points({ s, client, lang, toast, decide, onTouched }: { s: CodeSession; client: NokkerClient; lang: Lang; toast: Toast; decide: Decide; onTouched: () => Promise<void> }): React.ReactElement {
  const [items, setItems] = useState<CheckpointInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ hash: string; d: CheckpointDiff | string } | null>(null);
  const [ask, setAsk] = useState<CheckpointInfo | null>(null);
  const [card, setCard] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await client.callCodeSessionTool(s.id, "checkpoint_list");
      if ("approval_id" in r) return; // une lecture ne pose pas de carte
      const p = r.is_error ? null : parsePoints(r.content);
      setItems(p ?? []);
      setError(p ? null : r.content);
    } catch (e) {
      setError(codeError(lang, e));
    }
  }, [client, s.id, lang]);
  useEffect(() => {
    void load();
  }, [load]);

  // La carte du retour : en attente (ou approuvée, pas encore exécutée), on la garde ; sinon on dit l'issue et on relit.
  const settle = useCallback(
    (a: Approval) => {
      if (a.status === "pending" || a.status === "approved") return setCard(a);
      setCard(null);
      if (a.status === "executed") toast(c(lang, "restored"), "ok");
      else setError(c(lang, a.status === "rejected" ? "restoreRejected" : a.status === "expired" ? "restoreExpired" : "restoreFailed"));
      void load();
      void onTouched();
    },
    [lang, load, onTouched, toast],
  );
  // Décidée ici ou ailleurs (page de la carte, téléphone) : on suit son statut.
  const cardId = card?.id ?? null;
  useEffect(() => {
    if (!cardId) return;
    const t = setInterval(() => {
      client.getApproval(cardId).then(settle, () => undefined);
    }, 2500);
    return () => clearInterval(t);
  }, [cardId, client, settle]);

  const showDiff = async (p: CheckpointInfo): Promise<void> => {
    if (diff?.hash === p.hash) return setDiff(null);
    try {
      const r = await client.callCodeSessionTool(s.id, "checkpoint_diff", { hash: p.hash });
      if ("approval_id" in r) return;
      setDiff({ hash: p.hash, d: r.is_error ? r.content : (parseToolJson<CheckpointDiff>(r.content) ?? r.content) });
    } catch (e) {
      setError(codeError(lang, e));
    }
  };

  const restore = async (p: CheckpointInfo): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const o = restoreOutcome(lang, await client.callCodeSessionTool(s.id, "checkpoint_restore", { hash: p.hash }));
      if (o.kind === "card") settle(await client.getApproval(o.approvalId));
      else if (o.kind === "done") toast(o.text, "ok");
      else setError(o.text);
      if (o.kind !== "card") {
        void load();
        void onTouched();
      }
    } catch (e) {
      setError(codeError(lang, e));
    } finally {
      setBusy(false);
      setAsk(null);
    }
  };

  const decideCard = async (d: "approve" | "reject"): Promise<void> => {
    if (!card) return;
    setBusy(true);
    try {
      await decide(card, d);
      settle(await client.getApproval(card.id));
    } catch (e) {
      setError(e instanceof Error && !("status" in e) ? e.message : codeError(lang, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="code-points" aria-label={c(lang, "points")}>
      {card ? (
        <div className="code-confirm" role="status">
          <p className="code-warn">{c(lang, "restorePending")}</p>
          <span className="code-actions">
            <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void decideCard("approve")}>
              {c(lang, "restore")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decideCard("reject")}>
              {c(lang, "reject")}
            </button>
            <a className="fine" href={`/approvals/${encodeURIComponent(card.id)}`} target="_blank" rel="noopener noreferrer">
              {c(lang, "restoreSign")}
            </a>
          </span>
        </div>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {items === null && !error ? <p className="fine">{c(lang, "pointsLoading")}</p> : null}
      {items && !items.length ? <p className="fine">{c(lang, "pointsNone")}</p> : null}
      {items?.length ? (
        <ol className="code-point-list">
          {items.map((p) => (
            <li key={p.hash}>
              <div className="code-point">
                <code>{p.short_hash}</code>
                <span className="code-point-reason">{p.reason}</span>
                <span className="fine">
                  {fmtWhen(lang, p.timestamp)} · {c(lang, "pointLine", { files: p.files_changed })}
                  {p.insertions || p.deletions ? ` (+${p.insertions ?? 0} −${p.deletions ?? 0})` : ""}
                </span>
              </div>
              {ask?.hash === p.hash ? (
                <div className="code-confirm" role="group" aria-label={c(lang, "restore")}>
                  <p>{c(lang, "restoreConfirm", { hash: p.short_hash })}</p>
                  <span className="code-actions">
                    <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void restore(p)}>
                      {c(lang, "yes")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setAsk(null)}>
                      {c(lang, "cancel")}
                    </button>
                  </span>
                </div>
              ) : (
                <span className="code-actions">
                  <button type="button" className="btn btn-sm" aria-expanded={diff?.hash === p.hash} onClick={() => void showDiff(p)}>
                    {c(lang, diff?.hash === p.hash ? "hideDiff" : "diff")}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy || !!card} onClick={() => setAsk(p)}>
                    {c(lang, "restore")}
                  </button>
                </span>
              )}
              {diff?.hash === p.hash ? <DiffView lang={lang} d={diff.d} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function DiffView({ lang, d }: { lang: Lang; d: CheckpointDiff | string }): React.ReactElement {
  if (typeof d === "string") return <p className="error">{d}</p>;
  if (!d.diff && !d.stat) return <p className="fine">{d.message || c(lang, "diffEmpty")}</p>;
  return (
    <div className="code-diff">
      {d.stat ? <pre className="mono">{d.stat}</pre> : null}
      {d.diff ? (
        <pre className="mono">
          {d.diff.split("\n").map((l, i) => (
            <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : undefined}>
              {l + "\n"}
            </span>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function Credentials({
  client,
  lang,
  creds,
  toast,
  fail,
  reload,
}: {
  client: NokkerClient;
  lang: Lang;
  creds: CodeCredential[] | null;
  toast: Toast;
  fail: (e: unknown) => void;
  reload: () => Promise<void>;
}): React.ReactElement | null {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  if (creds === null) return null; // coffre absent : rien à ranger

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    try {
      const n = name.trim();
      await client.putCodeCredential(n, value);
      setValue("");
      setName("");
      toast(c(lang, "credSaved", { name: n }), "ok");
      await reload();
    } catch (e2) {
      fail(e2);
    } finally {
      setBusy(false);
    }
  };
  const del = async (n: string): Promise<void> => {
    try {
      await client.deleteCodeCredential(n);
      toast(c(lang, "credDeleted", { name: n }), "ok");
      await reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <details className="code-card code-creds">
      <summary>
        <h3>{c(lang, "creds")}</h3>
      </summary>
      <p className="fine">{c(lang, "credsLead")}</p>
      {creds.length ? (
        <ul className="code-cred-list">
          {creds.map((x) => (
            <li key={x.name}>
              <code>{x.name}</code>
              {x.updated_at ? <span className="fine">{c(lang, "credUpdated", { at: fmtWhen(lang, x.updated_at) })}</span> : null}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void del(x.name)}>
                {c(lang, "credDelete")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">{c(lang, "credsNone")}</p>
      )}
      <form className="code-fields" onSubmit={(e) => void save(e)}>
        <span>
          <label htmlFor="code-cred-name">{c(lang, "credName")}</label>
          <input id="code-cred-name" required autoCapitalize="none" spellCheck={false} placeholder={c(lang, "credNamePh")} value={name} onChange={(e) => setName(e.target.value)} />
        </span>
        <span>
          <label htmlFor="code-cred-value">{c(lang, "credValue")}</label>
          <input id="code-cred-value" type="password" required autoComplete="new-password" spellCheck={false} placeholder={c(lang, "credValuePh")} value={value} onChange={(e) => setValue(e.target.value)} />
        </span>
        <button type="submit" className="btn" disabled={busy || !name.trim() || !value}>
          {c(lang, "credSave")}
        </button>
      </form>
    </details>
  );
}
