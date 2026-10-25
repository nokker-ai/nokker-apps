/**
 * Écran « Miroir » d'un Lokkal (jeton local, LOKKAL §7.23) : un voyant par canal, le retard et ce qui attend,
 * « Tout resynchroniser », les pages gardées en ligne machine éteinte, et les projets mémoire mis en miroir. Une note
 * ou une page `local` ne quitte jamais la machine : le noyau filtre à l'envoi, nokker.ai refuse à l'arrivée.
 */
import React, { useCallback, useEffect, useState } from "react";
import { MIRROR_CHANNELS, NokkerApiError, teamMemoryProjects, type LocalMirrorPage, type LocalMirrorProject, type LocalMirrorStatus, type MirrorSpace, type NokkerClient } from "@nokker-apps/sdk";
import { CHANNEL_LABEL, PAGE_STATE_LABEL, fmtAgo, fmtBytes, fmtDuration, lagText, light } from "./model.js";
import "./mirror.css";

type Toast = (text: string, tone?: "ok" | "error") => void;
const POLL_MS = 5000;

function message(e: unknown): string {
  if (e instanceof NokkerApiError) {
    const b = e.body as { error?: { message?: string } | string } | undefined;
    const m = typeof b?.error === "string" ? b.error : b?.error?.message;
    return m ?? `refus de la machine (${e.status})`;
  }
  return "la machine ne répond pas";
}

/** Mention d'un projet mémoire relié à un projet d'équipe ; « Projet d'équipe » tant que son nom n'est pas connu. */
export function teamLine(name: string | null, mirrored: boolean): string {
  const who = name ? `Projet d'équipe « ${name} »` : "Projet d'équipe";
  return mirrored ? `${who} : ses notes passent aussi aux autres membres du projet.` : `${who} : en miroir, ses notes passeraient aussi aux autres membres.`;
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
      <h2>Miroir</h2>
      {!st.enabled ? (
        <p className="fine">Le miroir n'est pas actif sur cette machine : tes fils, tes notes et tes pages restent ici. Il s'allume dans la configuration de Lokkal, avec un compte nokker.ai abonné.</p>
      ) : (
        <>
          {st.paused ? (
            <p className="mirror-paused" role="status">
              En pause : les copies de cette machine ont été effacées chez nokker.ai. Rien ne part jusqu'à la reprise, qui renverra tout.{" "}
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => client.resumeLocalMirror(), "Miroir repris : tout repart.")}>
                Reprendre
              </button>
            </p>
          ) : (
            <p className={`mirror-lag ${st.behind_s ? "late" : ""}`} role="status">
              {lagText(st)}
            </p>
          )}
          <ul className="mirror-channels" aria-label="Canaux du miroir">
            {MIRROR_CHANNELS.map((k) => {
              const c = st.channels?.[k];
              if (!c) return null;
              const l = light(c);
              return (
                <li key={k} className={`mirror-ch ${l}`}>
                  <span className={`mirror-dot ${l}`} aria-hidden="true" />
                  <span className="mirror-ch-name">{CHANNEL_LABEL[k]}</span>
                  <span className="fine">
                    {l === "ok"
                      ? `dernier succès ${fmtAgo(c.last_ok_at)}`
                      : `${c.failures} échec${c.failures > 1 ? "s" : ""} · ${c.retry_in_s ? `nouvel essai dans ${fmtDuration(c.retry_in_s)}` : "nouvel essai imminent"}`}
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
            title={st.paused ? "Reprendre d'abord : les copies ont été effacées" : undefined}
            onClick={() => void run(() => client.resyncLocalMirror(), "Resynchronisation demandée : tout est relu des deux côtés.")}
          >
            {st.resync?.requested ? "Resynchronisation en cours…" : "Tout resynchroniser"}
          </button>
          {st.resync?.last_at ? <p className="fine">Dernière resynchronisation {fmtAgo(st.resync.last_at)}.</p> : null}
        </>
      )}

      {pages && st.enabled ? (
        <>
          <h3>Pages gardées en ligne</h3>
          <p className="fine">
            Une page gardée en ligne reste lisible machine éteinte, depuis une copie chez nokker.ai (la dernière version seulement, avec un bandeau « machine hors ligne »).
            {pages.space ? ` Place utilisée : ${fmtBytes(pages.space.used)} sur ${fmtBytes(pages.space.quota)}.` : ""}
          </p>
          {pages.pages.length === 0 ? (
            <p className="fine">Aucune page sur cette machine.</p>
          ) : (
            <ul className="mirror-pages">
              {pages.pages.map((p) => (
                <li key={p.page_id} className={`st-${p.state}`}>
                  <label className="team-check">
                    <input type="checkbox" checked={p.mirror} disabled={busy} onChange={(e) => void run(() => client.setLocalMirrorPage(p.page_id, e.target.checked))} /> garder en ligne
                  </label>
                  <span className="mirror-page-title">
                    <strong>{p.title}</strong> <span className="fine">v{p.version} · {fmtBytes(p.size)}</span>
                  </span>
                  <span className={`chip mirror-st-${p.state}`}>{PAGE_STATE_LABEL[p.state]}</span>
                  {p.state === "quota" ? (
                    <span className="mirror-err">
                      {pages.space ? `Plafond du compte atteint (${fmtBytes(pages.space.used)} sur ${fmtBytes(pages.space.quota)}) : retire une autre page pour faire de la place.` : (p.error ?? "Plafond du compte atteint.")}
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
          <h3>Projets mémoire en miroir</h3>
          <p className="fine">Un projet en miroir envoie ses notes apprises (règles, retours, faits) ; les fichiers du dépôt ne voyagent pas.</p>
          {projects.length === 0 ? (
            <p className="fine">Aucun projet mémoire sur cette machine.</p>
          ) : (
            <ul className="mirror-pages">
              {projects.map((p) => (
                <li key={p.project}>
                  <label className="team-check">
                    <input type="checkbox" checked={p.mirror} disabled={busy} onChange={(e) => void run(() => client.setLocalMirrorProject(p.project, e.target.checked))} /> en miroir
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
