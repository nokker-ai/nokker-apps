/**
 * Onglet « Incidents » (X18, LOKKAL §7.18.3) : visible seulement si `GET /v1/incidents` répond (drapeau `operate`).
 * Liste vivante, détail avec la frise, passages d'agents cliquables vers leur fil et leurs cartes, « Je prends » et
 * « Résolu ». L'état s'écrit toujours (la couleur n'est jamais le seul signal). Écran Sources : la clé d'une source
 * n'est montrée qu'UNE fois, à la création ou au renouvellement.
 */
import React, { useCallback, useEffect, useState } from "react";
import { type AlertSource, type AlertSourceSecret, type Incident, type NokkerClient } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { runStatusLabel } from "../crew/model.js";
import { approvalStatusLabel, ago, incidentStateLabel, opsError, sortIncidents } from "../ops/model.js";
import { shellLang, tr } from "../i18n/index.js";

type Toast = (text: string, tone?: "ok" | "error") => void;

export function IncidentsTab({ client, tick, toast, onOpenThread, onLive }: { client: NokkerClient; tick: number; toast: Toast; onOpenThread: (id: string) => void; onLive?: (n: number) => void }): React.ReactElement {
  const [view, setView] = useState<"live" | "resolved" | "sources">("live");
  const [list, setList] = useState<Incident[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (view === "sources") return;
    try {
      const l = (await client.listIncidents({ state: view })).incidents;
      setList(sortIncidents(l));
      if (view === "live") onLive?.(l.length);
      setErr(null);
    } catch (e) {
      setErr(opsError(e));
    }
  }, [client, view, onLive]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  return (
    <section className="ops-tab" aria-label={tr("Incidents")}>
      <nav className="ops-sub" aria-label={tr("View")}>
        {(["live", "resolved", "sources"] as const).map((v) => (
          <button key={v} type="button" className={`chip-btn ${view === v ? "on" : ""}`} aria-pressed={view === v} onClick={() => (setView(v), setSel(null))}>
            {v === "live" ? tr("Live") : v === "resolved" ? tr("Resolved") : tr("Sources")}
          </button>
        ))}
      </nav>
      {view === "sources" ? (
        <Sources client={client} toast={toast} />
      ) : (
        <div className="ops-split">
          <div className="ops-list">
            {err ? (
              <p className="error" role="alert">
                {err}
              </p>
            ) : null}
            {list === null ? (
              <p className="fine">{tr("Loading…")}</p>
            ) : list.length === 0 ? (
              <p className="fine">{view === "live" ? tr("No live incidents.") : tr("No resolved incidents.")}</p>
            ) : (
              <ul className="inc-list">
                {list.map((i) => (
                  <li key={i.id}>
                    <button type="button" className={`inc-item st-${i.state} ${sel === i.id ? "on" : ""}`} aria-current={sel === i.id ? "true" : undefined} onClick={() => setSel(i.id)}>
                      <span className="inc-state">{incidentStateLabel(i.state)}</span>
                      <span className="inc-main">
                        <strong>{i.title}</strong>
                        <span className="fine">
                          {i.source.name} · {ago(i.last_seen_at)}
                          {i.occurrences > 1 ? ` · ×${i.occurrences}` : ""}
                          {i.severity ? ` · ${i.severity}` : ""}
                        </span>
                        {i.last_event ? <span className="fine inc-last">{i.last_event.text}</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="ops-detail">{sel ? <IncidentView key={sel} id={sel} client={client} tick={tick} toast={toast} onOpenThread={onOpenThread} /> : <p className="fine">{tr("Pick an incident.")}</p>}</div>
        </div>
      )}
    </section>
  );
}

function IncidentView({ id, client, tick, toast, onOpenThread }: { id: string; client: NokkerClient; tick: number; toast: Toast; onOpenThread: (id: string) => void }): React.ReactElement {
  const [i, setI] = useState<Incident | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    client.getIncident(id).then(
      (x) => live && setI(x),
      (e) => live && toast(opsError(e), "error"),
    );
    return () => {
      live = false;
    };
  }, [client, id, tick, toast]);
  if (!i) return <p className="fine">{tr("Loading…")}</p>;
  const act = async (fn: () => Promise<Incident>): Promise<void> => {
    setBusy(true);
    try {
      setI(await fn());
      setNote("");
    } catch (e) {
      toast(opsError(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="inc-detail">
      <header>
        <span className={`inc-state st-${i.state}`}>{incidentStateLabel(i.state)}</span>
        <h2>{i.title}</h2>
        <p className="fine">
          <code>{i.name}</code> · {i.source.name} · {tr("seen {0} times, the last {1}", i.occurrences, ago(i.last_seen_at))}
          {i.acked_by ? ` · ${tr("taken by {0}", i.acked_by)}` : ""}
          {i.resolved_by ? ` · ${tr("resolved by {0}", i.resolved_by)}` : ""}
        </p>
      </header>
      {i.summary && i.summary !== i.title ? <p>{i.summary}</p> : null}
      {Object.keys(i.labels).length ? (
        <p className="inc-labels">
          {Object.entries(i.labels).map(([k, v]) => (
            <code key={k}>
              {k}={v}
            </code>
          ))}
        </p>
      ) : null}
      {i.state !== "resolved" ? (
        <div className="inc-actions">
          {i.state === "open" ? (
            <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void act(() => client.ackIncident(i.id))}>
              {tr("I'll take it")}
            </button>
          ) : null}
          <input aria-label={tr("Resolution note (optional)")} placeholder={tr("note (optional)")} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.resolveIncident(i.id, note.trim() || undefined))}>
            {tr("Mark resolved")}
          </button>
        </div>
      ) : null}
      {i.runs.length ? (
        <section>
          <h3>{tr("Agents")}</h3>
          <ul className="inc-runs">
            {i.runs.map((r) => (
              <li key={r.run_id}>
                <Icon name="bot" size={14} /> <strong>{r.agent}</strong> <span className="fine">{runStatusLabel(r.status as Parameters<typeof runStatusLabel>[0], shellLang())}</span>
                {r.summary ? <p className="fine">{r.summary}</p> : null}
                <span className="team-row-actions">
                  {r.thread_id ? (
                    <button type="button" className="btn btn-ghost" onClick={() => onOpenThread(r.thread_id!)}>
                      {tr("Open the run")}
                    </button>
                  ) : null}
                  {r.approvals.map((a) => (
                    <a key={a.id} className="btn btn-ghost" href={`/approvals/${encodeURIComponent(a.id)}`}>
                      <Icon name="shield" size={14} /> {a.tool} · {approvalStatusLabel(a.status)}
                      {a.strength === "strong" ? ` · ${tr("strong")}` : ""}
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>{tr("Timeline")}</h3>
        <ol className="inc-timeline">
          {(i.timeline ?? []).map((t, k) => (
            <li key={k} className={`tl-${t.kind}`}>
              <time dateTime={t.at} className="fine">
                {new Date(t.at).toLocaleString(shellLang() === "fr" ? "fr-CH" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </time>
              <span>{t.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Sources({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement {
  const [list, setList] = useState<AlertSource[] | null>(null);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<AlertSource["format"]>("alertmanager");
  const [auth, setAuth] = useState<AlertSource["auth"]>("bearer");
  const [shown, setShown] = useState<AlertSourceSecret | null>(null);
  const [confirmRm, setConfirmRm] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await client.listAlertSources()).sources);
    } catch (e) {
      toast(opsError(e), "error");
      setList((c) => c ?? []);
    }
  }, [client, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  const ok = /^[A-Za-z0-9 _.-]{1,64}$/.test(name.trim());
  const create = async (): Promise<void> => {
    try {
      setShown(await client.createAlertSource({ name: name.trim(), format, auth }));
      setName("");
      await load();
    } catch (e) {
      toast(opsError(e), "error");
    }
  };
  const rotate = async (s: AlertSource): Promise<void> => {
    try {
      setShown(await client.rotateAlertSource(s.id));
    } catch (e) {
      toast(opsError(e), "error");
    }
  };
  const remove = async (s: AlertSource): Promise<void> => {
    try {
      await client.deleteAlertSource(s.id);
      setConfirmRm(null);
      toast(tr("Source “{0}” deleted; its incidents remain.", s.name), "ok");
      await load();
    } catch (e) {
      toast(opsError(e), "error");
    }
  };
  return (
    <div className="machine-section">
      <h2>{tr("Alert sources")}</h2>
      <p className="fine">{tr("One URL per source. Alertmanager cannot sign a body: choose “Bearer token” for it.")}</p>
      {list?.length ? (
        <ul className="secret-list">
          {list.map((s) => (
            <li key={s.id}>
              <code>{s.name}</code>
              <span className="fine">
                {s.format} · {s.auth === "bearer" ? tr("Bearer token") : tr("HMAC signature")} · {s.last_seen_at ? tr("last alert {0}", ago(s.last_seen_at)) : tr("never called")}
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => void rotate(s)}>
                {tr("Rotate key")}
              </button>
              {confirmRm === s.id ? (
                <>
                  <button type="button" className="btn btn-danger" onClick={() => void remove(s)}>
                    {tr("Yes, delete")}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(null)}>
                    {tr("Cancel")}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(s.id)}>
                  {tr("Delete")}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : list ? (
        <p className="fine">{tr("No sources.")}</p>
      ) : null}
      <form
        className="team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void create();
        }}
      >
        <input aria-label={tr("Source name")} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Prometheus" />
        <select aria-label={tr("Format")} value={format} onChange={(e) => setFormat(e.target.value as AlertSource["format"])}>
          <option value="alertmanager">Alertmanager</option>
          <option value="generic">{tr("generic (JSON)")}</option>
        </select>
        <select aria-label={tr("Authentication")} value={auth} onChange={(e) => setAuth(e.target.value as AlertSource["auth"])}>
          <option value="bearer">{tr("Bearer token")}</option>
          <option value="hmac">{tr("HMAC signature")}</option>
        </select>
        <button type="submit" className="btn btn-brass" disabled={!ok}>
          {tr("Create")}
        </button>
      </form>
      {shown ? <SecretOnce s={shown} url={client.resolveUrl(shown.url) ?? shown.url} onClose={() => setShown(null)} /> : null}
    </div>
  );
}

function SecretOnce({ s, url, onClose }: { s: AlertSourceSecret; url: string; onClose: () => void }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(s.secret).then(() => setCopied(true), () => undefined);
  };
  return (
    <div className="popout-backdrop">
      <div className="popout" role="dialog" aria-modal="true" aria-label={tr("Key of “{0}”", s.source.name)}>
        <header className="popout-head">
          <Icon name="shield" size={20} />
          <h3>{tr("Key of “{0}”", s.source.name)}</h3>
        </header>
        <div className="popout-body">
          <p className="error">{tr("Shown only once: copy it into your configuration now.")}</p>
          <dl className="team-rules">
            <dt>URL</dt>
            <dd>
              <code className="wrap">{url}</code>
            </dd>
            <dt>{tr("Header")}</dt>
            <dd>
              <code>{s.header}</code>
            </dd>
            <dt>{tr("Value")}</dt>
            <dd>
              <code className="wrap">{s.signature}</code>
            </dd>
            <dt>{tr("Key")}</dt>
            <dd>
              <code className="wrap">{s.secret}</code>
            </dd>
          </dl>
          <div className="crew-actions" style={{ padding: "12px 0 0" }}>
            <button type="button" className="btn" onClick={copy}>
              {copied ? tr("Copied") : tr("Copy the key")}
            </button>
            <button type="button" className="btn btn-brass" onClick={onClose}>
              {tr("Got it")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
