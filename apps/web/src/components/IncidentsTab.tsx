/**
 * Onglet « Incidents » (X18, LOKKAL §7.18.3) : visible seulement si `GET /v1/incidents` répond (drapeau `operate`).
 * Liste vivante, détail avec la frise, passages d'agents cliquables vers leur fil et leurs cartes, « Je prends » et
 * « Résolu ». L'état s'écrit toujours (la couleur n'est jamais le seul signal). Écran Sources : la clé d'une source
 * n'est montrée qu'UNE fois, à la création ou au renouvellement.
 */
import React, { useCallback, useEffect, useState } from "react";
import { INCIDENT_STATE_LABEL, type AlertSource, type AlertSourceSecret, type Incident, type NokkerClient } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { RUN_STATUS_LABEL } from "../crew/model.js";
import { APPROVAL_STATUS_LABEL, ago, opsError, sortIncidents } from "../ops/model.js";

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
    <section className="ops-tab" aria-label="Incidents">
      <nav className="ops-sub" aria-label="Vue">
        {(["live", "resolved", "sources"] as const).map((v) => (
          <button key={v} type="button" className={`chip-btn ${view === v ? "on" : ""}`} aria-pressed={view === v} onClick={() => (setView(v), setSel(null))}>
            {v === "live" ? "Vivants" : v === "resolved" ? "Résolus" : "Sources"}
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
              <p className="fine">Chargement…</p>
            ) : list.length === 0 ? (
              <p className="fine">{view === "live" ? "Aucun incident vivant." : "Aucun incident résolu."}</p>
            ) : (
              <ul className="inc-list">
                {list.map((i) => (
                  <li key={i.id}>
                    <button type="button" className={`inc-item st-${i.state} ${sel === i.id ? "on" : ""}`} aria-current={sel === i.id ? "true" : undefined} onClick={() => setSel(i.id)}>
                      <span className="inc-state">{INCIDENT_STATE_LABEL[i.state]}</span>
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
          <div className="ops-detail">{sel ? <IncidentView key={sel} id={sel} client={client} tick={tick} toast={toast} onOpenThread={onOpenThread} /> : <p className="fine">Choisis un incident.</p>}</div>
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
  if (!i) return <p className="fine">Chargement…</p>;
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
        <span className={`inc-state st-${i.state}`}>{INCIDENT_STATE_LABEL[i.state]}</span>
        <h2>{i.title}</h2>
        <p className="fine">
          <code>{i.name}</code> · {i.source.name} · vu {i.occurrences} fois, la dernière {ago(i.last_seen_at)}
          {i.acked_by ? ` · pris par ${i.acked_by}` : ""}
          {i.resolved_by ? ` · résolu par ${i.resolved_by}` : ""}
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
              Je prends
            </button>
          ) : null}
          <input aria-label="Note de résolution (facultative)" placeholder="note (facultative)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.resolveIncident(i.id, note.trim() || undefined))}>
            Résolu
          </button>
        </div>
      ) : null}
      {i.runs.length ? (
        <section>
          <h3>Agents</h3>
          <ul className="inc-runs">
            {i.runs.map((r) => (
              <li key={r.run_id}>
                <Icon name="bot" size={14} /> <strong>{r.agent}</strong> <span className="fine">{RUN_STATUS_LABEL[r.status as keyof typeof RUN_STATUS_LABEL] ?? r.status}</span>
                {r.summary ? <p className="fine">{r.summary}</p> : null}
                <span className="team-row-actions">
                  {r.thread_id ? (
                    <button type="button" className="btn btn-ghost" onClick={() => onOpenThread(r.thread_id!)}>
                      Ouvrir le passage
                    </button>
                  ) : null}
                  {r.approvals.map((a) => (
                    <a key={a.id} className="btn btn-ghost" href={`/approvals/${encodeURIComponent(a.id)}`}>
                      <Icon name="shield" size={14} /> {a.tool} · {APPROVAL_STATUS_LABEL[a.status] ?? a.status}
                      {a.strength === "strong" ? " · forte" : ""}
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>Frise</h3>
        <ol className="inc-timeline">
          {(i.timeline ?? []).map((t, k) => (
            <li key={k} className={`tl-${t.kind}`}>
              <time dateTime={t.at} className="fine">
                {new Date(t.at).toLocaleString("fr-CH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
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
      toast(`Source « ${s.name} » supprimée ; ses incidents restent.`, "ok");
      await load();
    } catch (e) {
      toast(opsError(e), "error");
    }
  };
  return (
    <div className="machine-section">
      <h2>Sources d'alertes</h2>
      <p className="fine">Une URL par source. Alertmanager ne sait pas signer un corps : choisis « jeton Bearer » pour lui.</p>
      {list?.length ? (
        <ul className="secret-list">
          {list.map((s) => (
            <li key={s.id}>
              <code>{s.name}</code>
              <span className="fine">
                {s.format} · {s.auth === "bearer" ? "jeton Bearer" : "signature HMAC"} · {s.last_seen_at ? `dernière alerte ${ago(s.last_seen_at)}` : "jamais appelée"}
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => void rotate(s)}>
                Renouveler la clé
              </button>
              {confirmRm === s.id ? (
                <>
                  <button type="button" className="btn btn-danger" onClick={() => void remove(s)}>
                    Oui, supprimer
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(null)}>
                    Annuler
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(s.id)}>
                  Supprimer
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : list ? (
        <p className="fine">Aucune source.</p>
      ) : null}
      <form
        className="team-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void create();
        }}
      >
        <input aria-label="Nom de la source" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Prometheus" />
        <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value as AlertSource["format"])}>
          <option value="alertmanager">Alertmanager</option>
          <option value="generic">générique (JSON)</option>
        </select>
        <select aria-label="Authentification" value={auth} onChange={(e) => setAuth(e.target.value as AlertSource["auth"])}>
          <option value="bearer">jeton Bearer</option>
          <option value="hmac">signature HMAC</option>
        </select>
        <button type="submit" className="btn btn-brass" disabled={!ok}>
          Créer
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
      <div className="popout" role="dialog" aria-modal="true" aria-label={`Clé de ${s.source.name}`}>
        <header className="popout-head">
          <Icon name="shield" size={20} />
          <h3>Clé de « {s.source.name} »</h3>
        </header>
        <div className="popout-body">
          <p className="error">Montrée une seule fois : copie-la maintenant dans ta configuration.</p>
          <dl className="team-rules">
            <dt>URL</dt>
            <dd>
              <code className="wrap">{url}</code>
            </dd>
            <dt>En-tête</dt>
            <dd>
              <code>{s.header}</code>
            </dd>
            <dt>Valeur</dt>
            <dd>
              <code className="wrap">{s.signature}</code>
            </dd>
            <dt>Clé</dt>
            <dd>
              <code className="wrap">{s.secret}</code>
            </dd>
          </dl>
          <div className="crew-actions" style={{ padding: "12px 0 0" }}>
            <button type="button" className="btn" onClick={copy}>
              {copied ? "Copiée" : "Copier la clé"}
            </button>
            <button type="button" className="btn btn-brass" onClick={onClose}>
              C'est noté
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
