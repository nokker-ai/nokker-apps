/**
 * Publication d'une page (LOKKAL §7.26, BUBBLES §10.4), dans la bulle `artifact` : choix explicite, page par page,
 * révocable ; jamais un outil du modèle. « Publier » ouvre une confirmation qui dit ce qui sera public, puis dépose une
 * carte forte qui ne s'approuve qu'à la clé d'appareil ; c'est la version signée qui devient publique. Dépublier est
 * immédiat et tue l'adresse pour toujours. Une page épinglée `local` reste sur la machine, sans action.
 */
import React, { useEffect, useState } from "react";
import { NokkerApiError, type ArtifactState, type NokkerClient, type PublicPurge } from "@nokker-apps/sdk";
import { remoteApprovalUrl } from "../auth.js";
import { tr } from "../i18n/index.js";
import { fmtBytes } from "../mirror/model.js";
import "./publish.css";
import { ModerationNotice } from "./ModerationNotice.js";

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

function codeText(code: string): string | undefined {
  switch (code) {
    case "local_page":
      return tr("This page is pinned on the machine: it never becomes public.");
    case "not_linked":
      return tr("Publishing goes through the gateway: first link this machine to your nokker.ai account.");
    case "pages_public_not_allowed":
      return tr("Public pages are reserved for subscribers and verified accounts.");
    case "page_moderated":
      return tr("This page was removed by nokker.ai moderation: it cannot be published again.");
    default:
      return undefined;
  }
}
export function publishError(e: unknown): { code: string | null; text: string } {
  if (e instanceof NokkerApiError) {
    const err = (e.body as { error?: { code?: string; message?: string } } | undefined)?.error;
    const code = err?.code ?? null;
    return { code, text: (code && codeText(code)) || err?.message || tr("machine refused ({0})", e.status) };
  }
  return { code: null, text: tr("the machine is not responding") };
}

/** « version N published, version M in progress » quand elles diffèrent. */
export function versionsLine(s: Pick<ArtifactState, "version" | "public_version">): string {
  if (!s.public_version) return "";
  return s.public_version === s.version ? tr("version {0} published", s.public_version) : tr("version {0} published, version {1} in progress", s.public_version, s.version);
}

function purgeText(p: PublicPurge): string | null {
  return p === "pending" ? tr("The public copy kept at nokker.ai goes at the mirror's next pass (nokker.ai unreachable for now).") : null;
}

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
          setError(
            a.status === "rejected"
              ? tr("Publication refused.")
              : a.status === "expired"
                ? tr("The publication card expired: republish to place a new one.")
                : tr("Publication failed (page pinned, or version gone)."),
          );
        },
        () => undefined,
      );
    }, 5000);
    return () => clearInterval(t);
  }, [client, pending]);

  if (s.locality === "local") return <p className="fine publish-local">{tr("Stays on this machine: no copy, no publication.")}</p>;
  // Retirée par la modération : l'exposé des motifs remplace la publication (le noyau refuse de la republier).
  if (s.moderated_at) return <ModerationNotice s={s} />;
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
      toast(tr("Page unpublished: its public address no longer answers, and never will again."), "ok");
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
    <div className="publish-confirm" role="group" aria-label={republish ? tr("Republish the page") : tr("Publish the page")}>
      <p>
        <strong>{republish ? tr("Republish") : tr("Make public")}</strong>{tr(": anyone with the address will be able to read this version.")}
      </p>
      <dl className="publish-what">
        <dt>{tr("Title")}</dt>
        <dd>{s.title}</dd>
        <dt>{tr("File")}</dt>
        <dd>
          <code>{s.path}</code>
        </dd>
        <dt>{tr("Version")}</dt>
        <dd>{s.version}</dd>
        <dt>{tr("Size")}</dt>
        <dd>{fmtBytes(s.size)}</dd>
      </dl>
      <label className="team-check">
        <input type="checkbox" checked={index} onChange={(e) => setIndex(e.target.checked)} /> {tr("indexable by search engines")}
      </label>
      <p className="fine">{tr("A public page can neither track nor collect: no network call, no form. You sign the publication on your device (strong card).")}</p>
      <span className="team-row-actions">
        <button type="button" className="btn btn-brass" disabled={busy} onClick={() => void publish()}>
          {republish ? tr("Republish") : tr("Publish")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
          {tr("Cancel")}
        </button>
      </span>
    </div>
  );

  return (
    <div className="publish-panel">
      {pending ? (
        <p className="publish-pending" role="status">
          {tr("Waiting for your signature: the “page_publish” card (version {0}) is approved on your device, never with the local token.", pending.version)}
          {authMode === "gateway" ? (
            <>
              {" "}
              <a href={remoteApprovalUrl(location.host, pending.approval_id)} target="_blank" rel="noopener noreferrer">
                {tr("Sign on app.nokker.ai")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {s.public ? (
        <>
          <div className="publish-url">
            <input className="artifact-url mono" readOnly value={url ?? "…"} aria-label={tr("Public address of the page")} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-sm" disabled={!url} onClick={copy}>
              {copied ? tr("Copied") : tr("Copy")}
            </button>
          </div>
          <p className="fine">
            {versionsLine(s)}
            {s.public_index ? tr(" · indexable") : tr(" · not indexed")}
          </p>
          {confirm ? (
            confirmBox(true)
          ) : (
            <span className="team-row-actions">
              {s.public_version !== s.version && !pending && allowed !== false ? (
                <button type="button" className="btn" disabled={busy} onClick={() => (setIndex(!!s.public_index), setConfirm(true))}>
                  {tr("Republish version {0}", s.version)}
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void unpublish()}>
                {tr("Unpublish")}
              </button>
            </span>
          )}
        </>
      ) : confirm ? (
        confirmBox(false)
      ) : !pending ? (
        <label className="team-check publish-switch">
          <input type="checkbox" checked={false} disabled={busy} onChange={() => (setIndex(false), setConfirm(true))} /> {tr("public")}
        </label>
      ) : null}
      {purge && purgeText(purge) ? <p className="fine">{purgeText(purge)}</p> : null}
      {error ? (
        <p className="fine artifact-fail" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
