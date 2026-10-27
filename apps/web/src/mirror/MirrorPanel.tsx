/**
 * Écran « Miroir » d'un Lokkal (jeton local, LOKKAL §7.23) : un voyant par canal, le retard et ce qui attend,
 * « Tout resynchroniser », les pages gardées en ligne machine éteinte, et les projets mémoire mis en miroir. Une note
 * ou une page `local` ne quitte jamais la machine : le noyau filtre à l'envoi, nokker.ai refuse à l'arrivée.
 */
import React, { useCallback, useEffect, useState } from "react";
import { MIRROR_CHANNELS, NokkerApiError, teamMemoryProjects, type LocalMirrorPage, type LocalMirrorProject, type LocalMirrorStatus, type MirrorSpace, type NokkerClient } from "@nokker-apps/sdk";
import { channelLabel, pageStateLabel, fmtAgo, fmtBytes, fmtDuration, lagText, light } from "./model.js";
import { tr } from "../i18n/index.js";
import "./mirror.css";

type Toast = (text: string, tone?: "ok" | "error") => void;
const POLL_MS = 5000;

function message(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: { message?: string } | string } | undefined;
    const m = typeof b?.error === "string" ? b.error : b?.error?.message;
    return m ?? tr("machine refused ({0})", e.status);
  }
  return tr("the machine is not responding");
}

/** Mention d'un projet mémoire relié à un projet d'équipe ; « Team project » tant que son nom n'est pas connu. */
export function teamLine(name: string | null, mirrored: boolean): string {
  const who = name ? tr("Team project “{0}”", name) : tr("Team project");
  return mirrored ? tr("{0}: its notes also go to the other members of the project.", who) : tr("{0}: mirrored, its notes would also go to the other members.", who);
}

export function MirrorPanel({ client, toast }: { client: NokkerClient; toast: Toast }): React.ReactElement | null {
  const [st, setSt] = useState<LocalMirrorStatus | null>(null);
  const [pages, setPages] = useState<{ pages: LocalMirrorPage[]; space: MirrorSpace | null } | null>(null);
  const [projects, setProjects] = useState<LocalMirrorProject[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, p, pj] = await Promise.allSettled([client.getLocalMirror(), client.listLocalMirrorPages(), client.listLocalMirrorProjects()]);
    if (s.status === "fulfilled") setSt(s.value);
    setPages(p.status === "fulfilled" ? p.value : null);
    setProjects(pj.status === "fulfilled" ? pj.value.projects : null);
  }, [client]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!st) return null;
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, "ok");
      await load();
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const team = teamMemoryProjects(st);

  return (
    <div className="machine-section mirror-panel">
      <h2>{tr("Mirror")}</h2>
      {!st.enabled ? (
        <p className="fine">
          {tr("The mirror is not active on this machine: your threads, notes and pages stay here. It is turned on in Lokkal's configuration, with a subscribed nokker.ai account.")}
        </p>
      ) : (
        <>
          {st.paused ? (
            <p className="mirror-paused" role="status">
              {tr("Paused: this machine's copies were erased at nokker.ai. Nothing is sent until it resumes, which will resend everything.")}{" "}
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => client.resumeLocalMirror(), tr("Mirror resumed: everything is sent again."))}>
                {tr("Resume")}
              </button>
            </p>
          ) : (
            <p className={`mirror-lag ${st.behind_s ? "late" : ""}`} role="status">
              {lagText(st)}
            </p>
          )}
          <ul className="mirror-channels" aria-label={tr("Mirror channels")}>
            {MIRROR_CHANNELS.map((k) => {
              const c = st.channels?.[k];
              if (!c) return null;
              const l = light(c);
              return (
                <li key={k} className={`mirror-ch ${l}`}>
                  <span className={`mirror-dot ${l}`} aria-hidden="true" />
                  <span className="mirror-ch-name">{channelLabel(k)}</span>
                  <span className="fine">
                    {l === "ok"
                      ? tr("last success {0}", fmtAgo(c.last_ok_at))
                      : `${c.failures > 1 ? tr("{0} failures", c.failures) : tr("{0} failure", c.failures)} · ${c.retry_in_s ? tr("retrying in {0}", fmtDuration(c.retry_in_s)) : tr("retrying shortly")}`}
                  </span>
                  {l === "retry" && c.last_error ? <span className="mirror-err">{c.last_error.message}</span> : null}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="btn"
            disabled={busy || !!st.paused || !!st.resync?.requested}
            title={st.paused ? tr("Resume first: the copies were erased") : undefined}
            onClick={() => void run(() => client.resyncLocalMirror(), tr("Resynchronisation requested: everything is re-read on both sides."))}
          >
            {st.resync?.requested ? tr("Resynchronising…") : tr("Resynchronise everything")}
          </button>
          {st.resync?.last_at ? <p className="fine">{tr("Last resynchronisation {0}.", fmtAgo(st.resync.last_at))}</p> : null}
        </>
      )}

      {pages && st.enabled ? (
        <>
          <h3>{tr("Pages kept online")}</h3>
          <p className="fine">
            {tr("A page kept online stays readable with the machine off, from a copy at nokker.ai (the latest version only, with a “machine offline” banner).")}
            {pages.space ? ` ${tr("Space used: {0} of {1}.", fmtBytes(pages.space.used), fmtBytes(pages.space.quota))}` : ""}
          </p>
          {pages.pages.length === 0 ? (
            <p className="fine">{tr("No page on this machine.")}</p>
          ) : (
            <ul className="mirror-pages">
              {pages.pages.map((p) => (
                <li key={p.page_id} className={`st-${p.state}`}>
                  <label className="team-check">
                    <input type="checkbox" checked={p.mirror} disabled={busy} onChange={(e) => void run(() => client.setLocalMirrorPage(p.page_id, e.target.checked))} /> {tr("keep online")}
                  </label>
                  <span className="mirror-page-title">
                    <strong>{p.title}</strong> <span className="fine">v{p.version} · {fmtBytes(p.size)}</span>
                  </span>
                  <span className={`chip mirror-st-${p.state}`}>{pageStateLabel(p.state)}</span>
                  {p.state === "quota" ? (
                    <span className="mirror-err">
                      {pages.space ? tr("Account limit reached ({0} of {1}): remove another page to make room.", fmtBytes(pages.space.used), fmtBytes(pages.space.quota)) : (p.error ?? tr("Account limit reached."))}
                    </span>
                  ) : p.state === "refused" && p.error ? (
                    <span className="mirror-err">{p.error}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {projects ? (
        <>
          <h3>{tr("Memory projects mirrored")}</h3>
          <p className="fine">{tr("A mirrored project sends its learned notes (rules, feedback, facts); the repository files do not travel.")}</p>
          {projects.length === 0 ? (
            <p className="fine">{tr("No memory project on this machine.")}</p>
          ) : (
            <ul className="mirror-pages">
              {projects.map((p) => (
                <li key={p.project}>
                  <label className="team-check">
                    <input type="checkbox" checked={p.mirror} disabled={busy} onChange={(e) => void run(() => client.setLocalMirrorProject(p.project, e.target.checked))} /> {tr("mirrored")}
                  </label>
                  <span className="mirror-page-title">
                    <strong>{p.label || p.project}</strong> <code className="fine">{p.project}</code>
                  </span>
                  {team.has(p.project) ? (
                    <span className="mirror-team fine">{teamLine(team.get(p.project) ?? null, p.mirror)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
