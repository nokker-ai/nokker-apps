/**
 * Publication d'une page (LOKKAL §7.26, BUBBLES §10.4), dans la bulle `artifact` : choix explicite, page par page,
 * révocable ; jamais un outil du modèle. « Publier » ouvre une confirmation qui dit ce qui sera public, puis dépose une
 * carte forte qui ne s'approuve qu'à la clé d'appareil ; c'est la version signée qui devient publique. Dépublier est
 * immédiat et tue l'adresse pour toujours. Une page épinglée `local` reste sur la machine, sans action.
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type ArtifactState, type NokkerClient, type PublicPurge } from "@nokker-apps/sdk";
import { remoteApprovalUrl } from "../auth.js";
import { fmtBytes } from "../mirror/model.js";
import "./publish.css";

type Toast = (text: string, tone?: "ok" | "error") => void;

/** Droit de publier (`pages_public`, lu par Lokkal chez nokker.ai) : vrai, faux, ou inconnu (null). Une lecture par client. */
const allowedCache = new WeakMap<NokkerClient, Promise<boolean | null>>();
export function pagesPublic(client: NokkerClient): Promise<boolean | null> {
  let p = allowedCache.get(client);
  if (!p) {
    p = client.getLocalLinkStatus().then(
      (s) => (s.state === "approved" && typeof s.pages_public === "boolean" ? s.pages_public : s.state === "approved" ? null : false),
      () => null,
    );
    allowedCache.set(client, p);
  }
  return p;
}

const CODE_TEXT: Record<string, string> = {
  local_page: "Cette page est épinglée sur la machine : elle ne devient jamais publique.",
  not_linked: "Publier passe par la passerelle : lie d'abord cette machine à ton compte nokker.ai.",
  pages_public_not_allowed: "Les pages publiques sont réservées aux abonnés et aux comptes vérifiés.",
};
export function publishError(e: unknown): { code: string | null; text: string } {
  if (e instanceof NokkerApiError) {
    const err = (e.body as { error?: { code?: string; message?: string } } | undefined)?.error;
    const code = err?.code ?? null;
    return { code, text: (code && CODE_TEXT[code]) || err?.message || `refus de la machine (${e.status})` };
  }
  return { code: null, text: "la machine ne répond pas" };
}

/** « version N publiée, version M en cours » quand elles diffèrent. */
export function versionsLine(s: Pick<ArtifactState, "version" | "public_version">): string {
  if (!s.public_version) return "";
  return s.public_version === s.version ? `version ${s.public_version} publiée` : `version ${s.public_version} publiée, version ${s.version} en cours`;
}

const PURGE_TEXT: Record<PublicPurge, string | null> = {
  done: null,
  none: null,
  pending: "La copie publique gardée chez nokker.ai part au prochain passage du miroir (nokker.ai injoignable pour l'instant).",
};

export function PublishPanel({ client, state: s, authMode, toast }: { client: NokkerClient; state: ArtifactState; authMode: string | null; toast: Toast }): React.ReactElement | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [index, setIndex] = useState(false);
  const [pending, setPending] = useState<{ approval_id: string; version: number } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [purge, setPurge] = useState<PublicPurge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void pagesPublic(client).then((v) => live && setAllowed(v));
    return () => {
      live = false;
    };
  }, [client]);

  // Publiée : l'adresse publique (une autre origine, un id tiré au hasard) vient de `/link`, jamais du state.
  useEffect(() => {
    if (!s.public) return setUrl(null);
    let live = true;
    client.getPageLink(s.page_id).then(
      (l) => live && setUrl(l.public_url ? new URL(client.resolveUrl(l.public_url) ?? l.public_url, location.href).href : null),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
  }, [client, s.page_id, s.public, s.public_version]);

  // La carte signée : la bulle se recale (public, public_version) ; refusée ou expirée : on le dit.
  useEffect(() => {
    if (pending && s.public && (s.public_version ?? 0) >= pending.version) setPending(null);
  }, [pending, s.public, s.public_version]);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => {
      client.getApproval(pending.approval_id).then(
        (a) => {
          if (a.status === "pending" || a.status === "approved" || a.status === "executed") return;
          setPending(null);
          setError(a.status === "rejected" ? "Publication refusée." : a.status === "expired" ? "La carte de publication a expiré : republie pour en déposer une nouvelle." : "La publication a échoué (page épinglée, ou version disparue).");
        },
        () => undefined,
      );
    }, 5000);
    return () => clearInterval(t);
  }, [client, pending]);

  if (s.locality === "local") return <p className="fine publish-local">Reste sur cette machine : ni copie, ni publication.</p>;
  if (!s.public && !pending && allowed === false) return null; // pas le droit : l'action est absente, pas grisée

  const publish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.publishPage(s.page_id, { index });
      setPending({ approval_id: r.approval_id, version: r.version });
      setConfirm(false);
    } catch (e) {
      const { code, text } = publishError(e);
      if (code === "pages_public_not_allowed") setAllowed(false);
      setError(text);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };
  const unpublish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.unpublishPage(s.page_id);
      setPurge(r.purge);
      toast("Page dépubliée : son adresse publique ne répond plus, et ne reviendra jamais.", "ok");
    } catch (e) {
      setError(publishError(e).text);
    } finally {
      setBusy(false);
    }
  };
  const copy = (): void => {
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  const confirmBox = (republish: boolean) => (
    <div className="publish-confirm" role="group" aria-label={republish ? "Republier la page" : "Publier la page"}>
      <p>
        <strong>{republish ? "Republier" : "Rendre publique"}</strong> : n'importe qui avec l'adresse pourra lire cette version.
      </p>
      <dl className="publish-what">
        <dt>Titre</dt>
        <dd>{s.title}</dd>
        <dt>Fichier</dt>
        <dd>
          <code>{s.path}</code>
        </dd>
        <dt>Version</dt>
        <dd>{s.version}</dd>
        <dt>Taille</dt>
        <dd>{fmtBytes(s.size)}</dd>
      </dl>
      <label className="team-check">
        <input type="checkbox" checked={index} onChange={(e) => setIndex(e.target.checked)} /> indexable par les moteurs de recherche
      </label>
      <p className="fine">Une page publique ne peut ni pister ni collecter : aucun appel réseau, aucun formulaire. Tu signes la publication sur ton appareil (carte forte).</p>
      <span className="team-row-actions">
        <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void publish()}>
          {republish ? "Republier" : "Publier"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
          Annuler
        </button>
      </span>
    </div>
  );

  return (
    <div className="publish-panel">
      {pending ? (
        <p className="publish-pending" role="status">
          En attente de ta signature : la carte « page_publish » (version {pending.version}) s'approuve sur ton appareil, jamais au jeton local.
          {authMode === "gateway" ? (
            <>
              {" "}
              <a href={remoteApprovalUrl(location.host, pending.approval_id)} target="_blank" rel="noopener noreferrer">
                Signer sur app.nokker.ai
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {s.public ? (
        <>
          <div className="publish-url">
            <input className="artifact-url mono" readOnly value={url ?? "…"} aria-label="Adresse publique de la page" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-sm" disabled={!url} onClick={copy}>
              {copied ? "Copiée" : "Copier"}
            </button>
          </div>
          <p className="fine">
            {versionsLine(s)}
            {s.public_index ? " · indexable" : " · non indexée"}
          </p>
          {confirm ? (
            confirmBox(true)
          ) : (
            <span className="team-row-actions">
              {s.public_version !== s.version && !pending && allowed !== false ? (
                <button type="button" className="btn" disabled={busy} onClick={() => (setIndex(!!s.public_index), setConfirm(true))}>
                  Republier la version {s.version}
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void unpublish()}>
                Dépublier
              </button>
            </span>
          )}
        </>
      ) : confirm ? (
        confirmBox(false)
      ) : !pending ? (
        <label className="team-check publish-switch">
          <input type="checkbox" checked={false} disabled={busy} onChange={() => (setIndex(false), setConfirm(true))} /> publique
        </label>
      ) : null}
      {purge && PURGE_TEXT[purge] ? <p className="fine">{PURGE_TEXT[purge]}</p> : null}
      {error ? (
        <p className="fine artifact-fail" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
