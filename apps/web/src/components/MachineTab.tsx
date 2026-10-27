/**
 * Onglet « Machine » — seulement sur un Lokkal en local (jeton local) : les processus lancés en arrière-plan par les
 * sessions et l'aperçu de leur port (X6, LOKKAL §7.7), et le coffre des secrets (X4, §7.10). Aucune valeur de secret
 * n'est jamais affichée ni relue : une valeur part une fois, à l'enregistrement.
 */
import React, { useCallback, useEffect, useState } from "react";
import { NokkerApiError, type LocalProcess, type LocalSecrets, type NokkerClient } from "@nokker-apps/sdk";
import { Icon } from "../icons.js";
import { tr } from "../i18n/index.js";
import { MirrorPanel } from "../mirror/MirrorPanel.js";
import { LocalMailbox } from "../localmail/LocalMailbox.js";

const POLL_MS = 5000;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

function stateLabel(s: LocalProcess["state"]): string {
  switch (s) {
    case "running":
      return tr("running");
    case "exited":
      return tr("exited");
    case "stopped":
      return tr("stopped");
    case "lost":
      return tr("lost");
  }
}

function apiMessage(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: { message?: string; code?: string } | string } | undefined;
    const m = typeof b?.error === "string" ? b.error : b?.error?.message;
    if (e.status === 503) return m ?? tr("Vault unavailable or sealed.");
    if (e.status === 403) return tr("Write refused by the gateway: the value would cross the relay. Do it on the machine.");
    return m ?? tr("server refused ({0})", e.status);
  }
  return tr("the machine is not responding");
}

export function MachineTab({ client, toast }: { client: NokkerClient; toast(text: string, tone?: "ok" | "error"): void }): React.ReactElement {
  return (
    <section className="machine-tab" aria-label={tr("Machine")}>
      <Processes client={client} toast={toast} />
      <Vault client={client} toast={toast} />
      <LocalMailbox client={client} toast={toast} />
      <MirrorPanel client={client} toast={toast} />
    </section>
  );
}

function Processes({ client, toast }: { client: NokkerClient; toast(text: string, tone?: "ok" | "error"): void }): React.ReactElement {
  const [list, setList] = useState<LocalProcess[] | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string; url: string; port: number } | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await client.listLocalProcesses()).processes);
    } catch {
      setList((cur) => cur ?? []);
    }
  }, [client]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const open = async (p: LocalProcess): Promise<void> => {
    try {
      const l = await client.getProcessLink(p.id);
      setPreview({ id: p.id, name: p.name, url: client.resolveUrl(l.url) ?? l.url, port: l.port });
    } catch (e) {
      toast(tr("Preview unavailable: {0}", apiMessage(e)), "error");
    }
  };

  return (
    <div className="machine-section">
      <h2>{tr("Background processes")}</h2>
      <p className="fine">{tr("Dev servers and commands started by your sessions; they stop with their session.")}</p>
      {list === null ? (
        <p className="fine">{tr("Loading…")}</p>
      ) : list.length === 0 ? (
        <p className="fine">{tr("No process started.")}</p>
      ) : (
        <ul className="proc-list">
          {list.map((p) => (
            <li key={`${p.thread_id}:${p.id}`} className={`proc st-${p.state}`}>
              <span className="proc-dot" aria-hidden="true" />
              <span className="proc-main">
                <strong>{p.name}</strong>
                <code className="proc-cmd">{p.command}</code>
              </span>
              <span className="fine">
                {stateLabel(p.state)}
                {p.state === "exited" && p.returncode != null ? ` (${tr("code {0}", p.returncode)})` : ""}
                {p.port ? ` · ${tr("port {0}", p.port)}` : ""}
              </span>
              {p.port && p.state === "running" ? (
                <button type="button" className="btn" onClick={() => void open(p)}>
                  <Icon name="play" /> {tr("Preview")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {preview ? (
        <div className="popout-backdrop" onClick={() => setPreview(null)}>
          <div className="popout proc-preview" role="dialog" aria-modal="true" aria-label={tr("Preview of {0}", preview.name)} onClick={(e) => e.stopPropagation()}>
            <header className="popout-head">
              <h3>
                {preview.name} · {tr("port {0}", preview.port)}
              </h3>
              <a className="btn btn-ghost" href={preview.url} target="_blank" rel="noopener noreferrer">
                {tr("Open")}
              </a>
              <button type="button" className="icon-btn" aria-label={tr("Close")} onClick={() => setPreview(null)}>
                <Icon name="close" />
              </button>
            </header>
            {/* Même isolation qu'une page : origine opaque, jamais allow-same-origin. */}
            <iframe className="proc-frame" src={preview.url} title={tr("Preview of {0}", preview.name)} sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" referrerPolicy="no-referrer" />
            <p className="fine proc-hint">{tr("Link valid for 1 h. An app that writes absolute paths (“/assets/…”) breaks: run it with a relative base.")}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Vault({ client, toast }: { client: NokkerClient; toast(text: string, tone?: "ok" | "error"): void }): React.ReactElement {
  const [view, setView] = useState<LocalSecrets | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRm, setConfirmRm] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await client.listLocalSecrets());
      setErr(null);
    } catch (e) {
      setErr(apiMessage(e));
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (!NAME_RE.test(name) || !value) return;
    setBusy(true);
    try {
      await client.putLocalSecret(name, value);
      toast(tr("Secret “{0}” saved.", name), "ok");
      setName("");
      setValue("");
      await load();
    } catch (e) {
      toast(apiMessage(e), "error");
    } finally {
      setBusy(false);
      setValue(""); // la valeur ne reste jamais dans la page
    }
  };
  const remove = async (n: string): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteLocalSecret(n);
      toast(tr("Secret “{0}” deleted.", n), "ok");
      setConfirmRm(null);
      await load();
    } catch (e) {
      toast(apiMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="machine-section">
      <h2>{tr("Vault")}</h2>
      <p className="fine">{tr("Agents and connectors refer to a secret by its NAME; its value is never shown, neither here nor elsewhere.")}</p>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      {view ? (
        <>
          <p className="fine">
            {tr("Provider:")} <code>{view.provider}</code>
            {view.sealed ? ` · ${tr("sealed")}` : ""}
          </p>
          {view.notice ? <p className="fine">{view.notice}</p> : null}
          {view.secrets.length ? (
            <ul className="secret-list">
              {view.secrets.map((s) => (
                <li key={s.name}>
                  <code>{s.name}</code>
                  {confirmRm === s.name ? (
                    <>
                      <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(s.name)}>
                        {tr("Yes, delete")}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(null)}>
                        {tr("Cancel")}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmRm(s.name)}>
                      {tr("Delete")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="fine">{tr("No secrets.")}</p>
          )}
        </>
      ) : null}
      <form
        className="secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="fine" htmlFor="sec-name">
          {tr("Name")}
        </label>
        <input id="sec-name" value={name} onChange={(e) => setName(e.target.value.trim())} placeholder={tr("WEATHER_API_KEY")} autoComplete="off" spellCheck={false} />
        <label className="fine" htmlFor="sec-value">
          {tr("Value")}
        </label>
        <input id="sec-value" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
        <button type="submit" className="btn btn-brass" disabled={busy || !NAME_RE.test(name) || !value}>
          {tr("Save")}
        </button>
        {name && !NAME_RE.test(name) ? <span className="fine">{tr("Letters, digits, “_”, “.”, “-” (64 at most).")}</span> : null}
      </form>
    </div>
  );
}
